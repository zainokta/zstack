import { atom, read } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { BlastHeld } from '../types'
import { classifyBash, mcpSql } from './classify'
import type { Risk } from './classify'
import { joinDir } from './shell'
import { DESTRUCTIVE, analyze, scopeLine } from './sql'

const PANE = 'stack-blast-radius'
const HOLD_MS = 5 * 60_000
const MAX_LINES = 12
const RISKY_WORD = /\b(terraform|tofu|pulumi|gcloud|aws|kubectl|docker|rm|mysql|mariadb|psql)\b/

const held = atom({ plugin: 'stack-blast-radius', key: 'held' } as const, null)

// The call being held lives here; the pane draws the copy published to $.state.
// A $.state read inside the long tool.call dispatch doesn't see a button's
// later write, so the hold loop watches these instead (a reload ends the hold
// with them: its dispatch goes too).
let current: BlastHeld | null = null
const decisions = new Map<string, 'proceed' | 'cancel'>()

async function publish($: EngineInterface, change: (h: BlastHeld) => BlastHeld) {
  if (current === null) return
  current = change(current)
  await $.state.set({ plugin: 'stack-blast-radius', key: 'held' }, current)
}

type Ran = { exitCode: number; stdout: string; stderr: string }
type Call = { risk: Risk; tool: string; sqlKey?: string; command: string }

/** Passwords and tokens out of anything the pane or a deny shows. */
export function redact(text: string): string {
  return (/\b(mysql|mariadb)\b/.test(text) ? text.replace(/(\s-p)(?!\s)\S+/g, '$1***') : text)
    .replace(/(--password[= ])\S+/gi, '$1***')
    .replace(/\b([A-Z_]*(PASSWORD|PASS|PWD|TOKEN|SECRET|KEY)[A-Z_]*=)\S+/g, '$1***')
    .replace(/(\/\/[^:/\s@]+:)[^@\s]+@/g, '$1***@')
}

const firstLines = (text: string, n = MAX_LINES) => text.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '').slice(0, n)

/** The risky part of a tool call, judged from the call alone (no `$`), or null. */
function riskOf(e: ToolCallInput, root: string): Call | null {
  if (e.tool === 'Bash') {
    const risk = classifyBash(e.command, root)
    return risk && { risk, tool: 'Bash', command: e.command }
  }
  const tool = String(e.tool)
  const found = mcpSql(tool, e as unknown as Record<string, unknown>)
  if (found === null) return null
  const sql = analyze(found.sql)
  const verbs = [...new Set(sql.map(s => s.verb))].join(', ')
  return sql.length === 0 ? null : {
    risk: { kind: 'sql', label: `${tool.replace(/^mcp__/, '').replace(/__/, ' ')} ${verbs}`, words: [], dir: null, sql, warnings: [] },
    tool,
    sqlKey: found.key,
    command: found.sql,
  }
}

async function run($: EngineInterface, argv: string[], cwd: string | undefined, timeoutMs = 20_000): Promise<Ran> {
  try {
    return await $.process.run(argv, { cwd, timeoutMs })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error instanceof Error ? error.message : error) }
  }
}

async function where($: EngineInterface, dir: string | null): Promise<string | undefined> {
  if (dir === null) return undefined
  if (dir === '~' || dir.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}${dir.slice(1)}`
  return dir
}

/** A `sql-file` risk read and judged: null when the file holds nothing destructive. */
async function readSqlFile($: EngineInterface, risk: Risk): Promise<Risk | null> {
  const cwd = await $.session.cwd()
  const dir = await where($, risk.dir)
  const base = dir === undefined ? cwd : dir.startsWith('/') ? dir : `${cwd}/${dir}`
  const path = risk.file!.startsWith('/') ? risk.file! : joinDir(base, risk.file)
  try {
    const sql = analyze(await $.fs.read(path))
    return sql.length === 0 ? null : { ...risk, kind: 'sql', sql }
  } catch {
    return { ...risk, kind: 'sql', warnings: [`Couldn't read ${risk.file}; it may hold anything.`] }
  }
}

const flagValue = (words: readonly string[], ...names: string[]) => {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!
    for (const n of names) {
      if (w === n) return words[i + 1]
      if (w.startsWith(`${n}=`)) return w.slice(n.length + 1)
    }
  }
  return undefined
}

/** What the command would land on, and a dry run where one is cheap and only reads. */
async function measure($: EngineInterface, call: Call, cwd: string | undefined): Promise<{ context: string[]; lines: string[] }> {
  const { risk } = call
  const w = risk.words
  const context: string[] = []
  let lines: string[] = []

  if (risk.kind === 'terraform') {
    const subAt = w.findIndex((x, i) => i > 0 && !x.startsWith('-'))
    const globals = w.slice(1, subAt)
    const rest = w.slice(subAt + 1)
    const ws = await run($, [w[0]!, ...globals, 'workspace', 'show'], cwd, 10_000)
    if (ws.exitCode === 0) context.push(`workspace: ${ws.stdout.trim()}`)
    const VALUED = new Set(['-var', '-var-file', '-target', '-replace', '-parallelism', '-lock-timeout', '-state', '-state-out', '-backup'])
    const planFile = rest.find((x, i) => !x.startsWith('-') && !VALUED.has(rest[i - 1] ?? ''))
    const pass = rest.flatMap((x, i) => (/^-(var|var-file|target|replace)(=|$)/.test(x) ? (x.includes('=') ? [x] : [x, rest[i + 1] ?? '']) : []))
    const isDestroy = w[subAt] === 'destroy' || rest.includes('-destroy')
    const argv = w[subAt] === 'apply' && planFile
      ? [w[0]!, ...globals, 'show', '-no-color', planFile]
      : [w[0]!, ...globals, 'plan', '-no-color', '-input=false', '-lock=false', ...(isDestroy ? ['-destroy'] : []), ...pass]
    const plan = await run($, argv, cwd, 180_000)
    const out = plan.stdout.split('\n')
    const summary = out.filter(l => /^(Plan:|No changes\.|Changes to Outputs)/.test(l.trim()))
    const changes = out.filter(l => /^\s*# .+ (will be|must be)/.test(l)).map(l => l.trim().replace(/^# /, ''))
    lines = [...summary, ...changes].slice(0, MAX_LINES)
    if (lines.length === 0) lines = [`${argv.slice(0, 4).join(' ')} gave no summary${plan.exitCode !== 0 ? `: ${firstLines(plan.stderr, 1)[0] ?? `exit ${plan.exitCode}`}` : ''}`]
  } else if (risk.kind === 'pulumi') {
    const stackArgs = flagValue(w, '-s', '--stack') ? ['--stack', flagValue(w, '-s', '--stack')!] : []
    const cwdArgs = flagValue(w, '-C', '--cwd') ? ['--cwd', flagValue(w, '-C', '--cwd')!] : []
    const stack = stackArgs[1] ?? (await run($, ['pulumi', 'stack', '--show-name', ...cwdArgs], cwd, 15_000)).stdout.trim()
    if (stack) context.push(`stack: ${stack}`)
    const argv = risk.label.endsWith('destroy')
      ? ['pulumi', 'destroy', '--preview-only', '--non-interactive', ...stackArgs, ...cwdArgs]
      : ['pulumi', 'preview', '--non-interactive', ...stackArgs, ...cwdArgs]
    const preview = await run($, argv, cwd, 180_000)
    lines = preview.stdout.split('\n')
      .filter(l => /^\s*([-+~]{1,2}|\+-|-\+)\s+\S|Resources:|\d+ to (create|update|delete|replace)|unchanged/.test(l))
      .map(l => l.trim())
      .slice(0, MAX_LINES)
    if (lines.length === 0) lines = [`${argv.slice(0, 2).join(' ')} gave no summary${preview.exitCode !== 0 ? `: ${firstLines(preview.stderr, 1)[0] ?? ''}` : ''}`]
  } else if (risk.kind === 'gcloud') {
    const project = flagValue(w, '--project') ?? (await run($, ['gcloud', 'config', 'get-value', 'project'], cwd, 10_000)).stdout.trim()
    const account = flagValue(w, '--account') ?? (await run($, ['gcloud', 'config', 'get-value', 'account'], cwd, 10_000)).stdout.trim()
    if (project) context.push(`project: ${project}`)
    if (account) context.push(`account: ${account}`)
    lines = ['gcloud has no dry run for this; check the project above.']
  } else if (risk.kind === 'aws') {
    const profile = flagValue(w, '--profile') ?? (await $.env.get('AWS_PROFILE'))
    const region = flagValue(w, '--region') ?? (await $.env.get('AWS_REGION')) ?? (await $.env.get('AWS_DEFAULT_REGION'))
    context.push(`profile: ${profile ?? 'default'}`, ...(region ? [`region: ${region}`] : []))
    const url = w.find(x => x.startsWith('s3://'))
    if (url) {
      const extra = [...(profile ? ['--profile', profile] : []), ...(region ? ['--region', region] : [])]
      const ls = await run($, ['aws', 's3', 'ls', '--recursive', '--summarize', url, ...extra], cwd, 30_000)
      lines = ls.stdout.split('\n').filter(l => /Total (Objects|Size)/.test(l)).map(l => l.trim())
      if (lines.length === 0) lines = [`Couldn't list ${url}.`]
    } else {
      lines = ['aws has no dry run for this; check the profile and region above.']
    }
  } else if (risk.kind === 'kubectl') {
    const ctx = flagValue(w, '--context') ?? (await run($, ['kubectl', 'config', 'current-context'], cwd, 10_000)).stdout.trim()
    const ns = flagValue(w, '-n', '--namespace')
      ?? ((await run($, ['kubectl', 'config', 'view', '--minify', '-o', 'jsonpath={..namespace}'], cwd, 10_000)).stdout.trim() || 'default')
    context.push(`context: ${ctx || '(none)'}`, `namespace: ${ns}`)
    const subAt = w.findIndex(x => x === 'delete' || x === 'apply')
    if (w[subAt] === 'delete') {
      const keep = w.slice(1).filter((x, i) => i + 1 !== subAt && !/^--(grace-period|force|now|wait|cascade|all$|timeout)/.test(x))
      const out = keep.flatMap((x, i) => (x === '-o' || x === '--output' ? [] : keep[i - 1] === '-o' || keep[i - 1] === '--output' ? [] : [x]))
      const get = await run($, ['kubectl', 'get', ...out, '-o', 'name'], cwd, 20_000)
      const names = firstLines(get.stdout, 200)
      lines = get.exitCode === 0 ? [`deletes ${names.length} object(s)`, ...names.slice(0, MAX_LINES - 1)] : [`kubectl get failed: ${firstLines(get.stderr, 1)[0] ?? ''}`]
    } else {
      const args: string[] = []
      w.forEach((x, i) => {
        if (/^(-f|--filename|-k|--kustomize|-n|--namespace|--context|-l|--selector)$/.test(x)) args.push(x, w[i + 1] ?? '')
        else if (/^(-R|--recursive|--server-side)$|^(-f|--filename|-k|--kustomize|-n|--namespace|--context|-l|--selector)=/.test(x)) args.push(x)
      })
      const diff = await run($, ['kubectl', 'diff', ...args], cwd, 30_000)
      lines = diff.exitCode === 0 ? ['kubectl diff: no changes'] : firstLines(diff.stdout || diff.stderr)
    }
  } else if (risk.kind === 'docker') {
    lines = firstLines((await run($, ['docker', 'system', 'df'], cwd, 15_000)).stdout)
  } else if (risk.kind === 'rm') {
    const targets = w.slice(1).filter(a => !/^-/.test(a))
    // Paths go in as arguments, never as source; IFS= keeps a glob from splitting.
    const script = 'IFS=; shopt -s nullglob dotglob; paths=(); for g in "$@"; do case "$g" in /*) ;; *) g="./$g";; esac; for p in $g; do [ -e "$p" ] && paths+=("$p"); done; done; [ ${#paths[@]} -eq 0 ] && { echo 0; echo 0; exit 0; }; find "${paths[@]}" 2>/dev/null | wc -l; du -shc -- "${paths[@]}" 2>/dev/null | tail -n1 | cut -f1'
    const counted = await run($, ['bash', '-c', script, 'blast-radius', ...targets], cwd, 15_000)
    const [n, size] = firstLines(counted.stdout, 2)
    lines = n === '0' ? ['Nothing there to delete.'] : [`${n ?? '?'} files and folders, ${size ?? '?'} in all`]
  } else if (risk.kind === 'sql') {
    for (const s of risk.sql) {
      lines.push(s.text.replace(/\s+/g, ' ').slice(0, 160), `  ${scopeLine(s)}${s.note && s.scope !== 'schema' ? ` ${s.note}` : ''}`)
      if (s.count !== undefined && call.sqlKey !== undefined && risk.sql.length === 1) {
        lines.push(`  ${await countRows($, call.tool, call.sqlKey, s.count)}`)
      }
    }
    if (call.tool === 'Bash') lines.push('Row counts are not run for the mysql/psql CLI.')
  }
  return { context, lines }
}

/** Runs the derived COUNT through the same DB tool, only if that call needs no prompt. */
async function countRows($: EngineInterface, tool: string, key: string, count: string): Promise<string> {
  const input = { [key]: count }
  const check = await $.tool.check({ tool, input })
  if (check.decision !== 'allow') return `Not counted: running ${count.slice(0, 60)}... would need your permission.`
  const res = await $.tool.call({ tool, ...input } as never)
  const text = res.deny ?? res.text ?? ''
  const n = /"n"\s*:\s*"?(\d+)/.exec(text)?.[1] ?? /(\d+)/.exec(text)?.[1]
  return n === undefined ? `Count failed: ${text.slice(0, 80)}` : `${n} row(s) match now.`
}

/** Fills in the held call's preview, as long as that call is still the one held. */
async function preview($: EngineInterface, call: Call, id: string) {
  let found: { context?: string[]; lines: string[] }
  try {
    found = await measure($, call, await where($, call.risk.dir))
  } catch (error) {
    found = { lines: [`Preview failed: ${String(error instanceof Error ? error.message : error).slice(0, 120)}`] }
  }
  if (current?.id === id) await publish($, h => ({ ...h, ...found, isMeasuring: false })).catch(() => {})
}

const deny = (label: string, why: string) => ({
  deny: `stack-blast-radius held \`${label}\` and did not run it: ${why}. Don't retry it unless the user asks you to.`,
})

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash' && !String(e.tool).startsWith('mcp__')) return next(e)
    let call = riskOf(e, e.tool === 'Bash' ? await $.session.root() : '/')
    if (call === null) return next(e)
    if (call.risk.kind === 'sql-file') {
      const risk = await readSqlFile($, call.risk)
      if (risk === null) return next(e)
      call = { ...call, risk }
    }
    const { label } = call.risk
    if ((await $.session.surfaces()).length === 0) {
      return deny(label, 'nobody can press Proceed in a session with no screen (claude -p); ask the user to run it themselves')
    }

    const id = e.tool_use_id
    const startedAt = await $.clock.now()
    const mine: BlastHeld = {
      id,
      label,
      command: redact(call.command),
      context: [],
      lines: [],
      warnings: [...call.risk.warnings, ...(call.risk.sql.some(s => s.scope === 'none' && s.verb !== 'TRUNCATE') ? ['No WHERE: it touches every row.'] : [])],
      isMeasuring: true,
      decision: null,
      where: 'pane',
      startedAt,
    }
    // One hold at a time: a second risky call (a subagent's) waits its turn.
    // No await between the check and the claim, so two can't both get in.
    while (current !== null) {
      if (next.signal.aborted) return deny(label, 'the turn was interrupted')
      if ((await $.clock.now()) - startedAt > HOLD_MS) return deny(label, 'another held command was still waiting for an answer')
      await $.process.run(['sleep', '0.25'], { timeoutMs: 5000 })
    }
    current = mine

    let placed = false
    let decision: string
    try {
      await publish($, h => h)
      const opened = await $.ui.open({ id: PANE, title: 'Blast Radius', focus: true, rows: 20 })
      placed = opened.isPlaced
      if (!placed) await publish($, h => ({ ...h, where: 'band' }))
      void preview($, call, id)
      for (;;) {
        const chosen = decisions.get(id)
        if (chosen !== undefined) { decision = chosen; break }
        if (next.signal.aborted) { decision = 'interrupted'; break }
        if ((await $.clock.now()) - startedAt > HOLD_MS) { decision = 'timeout'; break }
        await $.process.run(['sleep', '0.25'], { timeoutMs: 5000 })
      }
    } catch {
      decision = 'error'
    } finally {
      // Close this call's pane before letting the next hold in.
      if (placed) await $.ui.close({ id: PANE }).catch(() => {})
      decisions.delete(id)
      if (current?.id === id) current = null
      await $.state.set({ plugin: 'stack-blast-radius', key: 'held' }, null).catch(() => {})
    }

    if (decision === 'proceed') return next(e)
    const why: Record<string, string> = {
      cancel: 'the user pressed Cancel',
      timeout: `no answer within ${HOLD_MS / 60_000} minutes`,
      interrupted: 'the turn was interrupted',
    }
    return deny(label, why[decision] ?? 'the hold failed')
  }).catch(($, e, next) => {
    // Fail closed (Jev: fail_closed 0.98): a risky call is refused when the
    // hold breaks; anything else goes on. Re-entry (our own COUNT) is judged
    // the same way, from the call alone.
    if (next.called) return next(e)
    let risky: boolean
    try {
      risky = riskOf(e, '') !== null
    } catch {
      risky = e.tool !== 'Bash' || DESTRUCTIVE.test(e.command) || RISKY_WORD.test(e.command)
    }
    return !risky ? next(e) : { deny: 'stack-blast-radius: its hold failed, so this risky command was not run. Ask the user to run it, or retry.' }
  })

  // Closing the pane by hand is a Cancel.
  on('ui.close', ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && current !== null && !decisions.has(current.id)) {
      decisions.set(current.id, 'cancel')
    }
    return next(e)
  })

  // A copy left in $.state by a reload mid-hold names no live call: not drawn.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const h = await read($, held)
    return h === null || h.id !== current?.id ? next(e) : draw($, e, h)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const h = await read($, held)
    return h === null || h.id !== current?.id || h.where !== 'band' ? next(e) : draw($, e, h)
  })
}

// `h` is the JSX factory, so the held call is `item` here.
function draw($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], item: BlastHeld) {
  const { Box, Button, Text } = $.ui.resolve(e)
  // The buttons answer the call this pane was drawn for, never a later one.
  const decide = (decision: 'proceed' | 'cancel') => async () => {
    if (decisions.has(item.id) || current?.id !== item.id) return
    decisions.set(item.id, decision)
    await publish($, h => ({ ...h, decision }))
  }
  const commandLines = item.command.split('\n')
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text key="title" bold color="yellow">⚠ Blast Radius · {item.label}</Text>
      <Box key="cmd" flexDirection="column" marginTop={1}>
        {commandLines.slice(0, 6).map((line, i) => (
          <Text key={`c${i}`} wrap="truncate-end">{i === 0 ? '$ ' : '  '}{line}</Text>
        ))}
        {commandLines.length > 6 ? <Text key="cmore" dimColor>  … {commandLines.length - 6} more lines</Text> : null}
      </Box>
      {item.context.length > 0 ? <Text key="ctx" color="cyan">{item.context.join('  ·  ')}</Text> : null}
      <Box key="preview" flexDirection="column" marginTop={1}>
        {item.isMeasuring && item.lines.length === 0 ? <Text key="wait" dimColor>Running the dry run…</Text> : null}
        {item.lines.map((line, i) => <Text key={`l${i}`} wrap="truncate-end">{line}</Text>)}
      </Box>
      {item.warnings.map((line, i) => <Text key={`w${i}`} color="red" bold>! {line}</Text>)}
      <Box key="buttons" marginTop={1} gap={2}>
        <Button key="proceed" label="Proceed" hotkey="1" plain onPress={decide('proceed')} />
        <Button key="cancel" label="Cancel" hotkey="2" plain autoFocus onPress={decide('cancel')} />
        <Text key="hint" dimColor>Claude is waiting. No answer in {HOLD_MS / 60_000} min = Cancel.</Text>
      </Box>
    </Box>
  )
}
