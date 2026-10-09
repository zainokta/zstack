import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

export const SECTION_ID = 'rules-injector:rules'
// About 3k tokens: room for house.md (~3.7 KB) and plenty of user rules.
export const CAP = 12_000
const MIN_FORGET = 4
const USAGE = 'usage: /rules | /rules add <text> | /rules add-project <text> | /rules forget <pattern>'

type Part = { kind: 'project' | 'global' | 'house'; path: string; body: string }

// `zstack rule list` prints `## <path>` then the file, for house.md, global.md and the repo's file.
export function parse(out: string, rulesDir: string): Part[] {
  const parts: Part[] = []
  for (const chunk of out.split(/^## (?=\/)/m).slice(1)) {
    const nl = chunk.indexOf('\n')
    const path = (nl < 0 ? chunk : chunk.slice(0, nl)).trim()
    const body = (nl < 0 ? '' : chunk.slice(nl + 1)).replace(/\s*<!--.*?-->/g, '').trim()
    if (!body) continue
    const kind = !path.startsWith(`${rulesDir}/`) ? 'house' : path.endsWith('/global.md') ? 'global' : 'project'
    parts.push({ kind, path, body })
  }
  return parts
}

// Most specific first, so a cut drops generic house rules before the user's own.
export function compose(parts: Part[], cwd: string): string | undefined {
  const order = { project: 0, global: 1, house: 2 } as const
  const title = { project: `Project rules (${cwd})`, global: 'Global rules', house: 'House rules' } as const
  const sorted = [...parts].sort((a, b) => order[a.kind] - order[b.kind])
  if (!sorted.length) return undefined
  const text = [
    '# Standing rules (zstack)',
    'The user set these rules and has had to repeat them. Follow every one without being reminded. The user manages them with /rules.',
    ...sorted.map(p => `## ${title[p.kind]}\n${p.body.replace(/^# House rules\n+/, '').replace(/^#{1,2} /gm, '### ')}`),
  ].join('\n\n')
  if (text.length <= CAP) return text
  const cut = text.slice(0, text.lastIndexOf('\n', CAP))
  return `${cut}\n\n[${text.length - cut.length} more characters of rules cut; run /rules to see all]`
}

type Cache = { cwd: string; sig: string; house?: string; text?: string }

// Module state is fine here: nothing draws from it, and a reload just re-reads the rules.
let cache: Cache | undefined
let pending: Promise<string | undefined> | undefined
let isDirty = false
let isMissing = false

async function rulesDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('ZSTACK_HOME')
  return `${home ?? `${(await $.env.get('HOME')) ?? ''}/.local/state/zstack`}/rules`
}

// Every rules file's mtime and size: `rule add` appends, `rule forget` rewrites,
// a new project file appears in the directory, house.md is edited by hand.
async function signature($: EngineInterface, dir: string, house?: string): Promise<string> {
  const files = await $.fs.list(dir).catch(() => [])
  const parts = files.map(f => `${f.name}:${f.mtimeMs}:${f.size}`).sort()
  if (house) {
    const st = await $.fs.stat(house).catch(() => undefined)
    parts.push(`house:${st?.mtimeMs ?? 0}:${st?.size ?? 0}`)
  }
  return parts.join('|')
}

function zstack($: EngineInterface, args: string[]): Promise<ProcessRunResult> {
  return $.process.run(['zstack', ...args], { timeoutMs: 10_000 })
}

async function load($: EngineInterface): Promise<string | undefined> {
  if (isMissing) return undefined
  const cwd = await $.session.cwd()
  const dir = await rulesDir($)
  const sig = await signature($, dir, cache?.house)
  if (cache && !isDirty && cache.cwd === cwd && cache.sig === sig) return cache.text
  isDirty = false

  let out: ProcessRunResult
  try {
    out = await zstack($, ['rule', 'list', '--repo', cwd])
  } catch {
    if (cache?.text === undefined) {
      isMissing = true
      $.ui.status('rules-injector: zstack not found, standing rules are not injected')
      return undefined
    }
    cache = { ...cache, sig }
    return cache.text
  }
  // A failed read keeps the last good rules and retries on the next change.
  if (out.exitCode !== 0) {
    cache = { cwd, sig, house: cache?.house, text: cache?.text }
    return cache.text
  }
  const parts = parse(out.stdout, dir)
  const house = parts.find(p => p.kind === 'house')?.path
  cache = { cwd, sig: house === cache?.house ? sig : await signature($, dir, house), house, text: compose(parts, cwd) }
  return cache.text
}

function rules($: EngineInterface): Promise<string | undefined> {
  pending ??= load($).finally(() => {
    pending = undefined
  })
  return pending
}

function said(r: ProcessRunResult): string {
  return (r.exitCode === 0 ? r.stdout : r.stderr || `zstack exited ${r.exitCode}`).trim()
}

async function run($: EngineInterface, args: string[]): Promise<string> {
  try {
    const r = await zstack($, args)
    if (isMissing) {
      isMissing = false
      $.ui.status(undefined)
    }
    if (r.exitCode === 0 && args[1] !== 'list') isDirty = true
    return said(r)
  } catch {
    return 'zstack is not on PATH; standing rules are not injected.'
  }
}

async function command($: EngineInterface, args: string): Promise<string> {
  const m = /^(\S*)\s*([\s\S]*)$/.exec(args.trim())
  const sub = m?.[1] ?? ''
  const rest = (m?.[2] ?? '').trim()
  const cwd = await $.session.cwd()

  if (sub === '' || sub === 'list') {
    const listed = await run($, ['rule', 'list', '--repo', cwd])
    const text = await rules($)
    const note = text === undefined ? 'nothing is injected' : `${text.length} characters injected into the system prompt`
    return `${listed || 'no rules yet'}\n\n(${note})`
  }
  if ((sub === 'add' || sub === 'add-project' || sub === 'forget') && !rest) return USAGE
  if (sub === 'add') return run($, ['rule', 'add', '--', rest])
  if (sub === 'add-project') return run($, ['rule', 'add', '--project', '--repo', cwd, '--', rest])
  if (sub === 'forget') {
    // zstack forgets every line containing the pattern, in every project's file.
    if (rest.length < MIN_FORGET) return `pattern too short: use at least ${MIN_FORGET} characters (it removes every matching rule line in every project)`
    return run($, ['rule', 'forget', '--', rest])
  }
  return USAGE
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rules',
      description: 'Show zstack standing rules; add, add-project or forget one',
      argumentHint: '[add <text> | add-project <text> | forget <pattern>]',
    })
    return next(e)
  })

  on('command.run', { command: 'rules' }, async ($, e) => ({ text: await command($, e.args) }))

  // Fail open: if anything here throws, the prompt goes out as the engine composed it.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = await rules($)
    if (text === undefined) return composed
    const sections = composed.sections.filter(s => s.id !== SECTION_ID)
    return { sections: [...sections, { id: SECTION_ID, text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))
}
