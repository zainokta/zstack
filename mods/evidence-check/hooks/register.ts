import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const TURN = { plugin: 'evidence-check', key: 'turn' } as const

const JEV_TIMEOUT_MS = 8000
// Jev's probability that the reply asserts verified success; below this the phrase was a hedge, a recap or an edit note.
const MIN_CLAIM = 0.65

// Bash commands that test, build, lint or probe something.
const CHECK_COMMAND = new RegExp(
  [
    String.raw`\bgo\s+(?:test|vet|build)\b`,
    String.raw`\b(?:pytest|tox|nox|phpunit|rspec|ctest)\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|build|lint|typecheck|type-check|check|e2e|verify)\b`,
    String.raw`\b(?:vitest|jest|mocha|tsc|eslint|biome|playwright|cypress)\b`,
    String.raw`\bprettier\s+(?:--check|-c)\b`,
    String.raw`\bcargo\s+(?:test|check|build|clippy|nextest)\b`,
    String.raw`\b(?:ruff|mypy|pyright|flake8|pylint|golangci-lint|staticcheck|shellcheck|hadolint|tflint)\b`,
    String.raw`\b(?:make|just|task)\s+(?:test|tests|check|lint|build|verify|e2e|ci)\b`,
    String.raw`\b(?:mvn|mvnw|gradle|gradlew)\b[^\n;&|]*\b(?:test|verify|check|build)\b`,
    String.raw`\b(?:dotnet|swift|zig)\s+(?:test|build)\b`,
    String.raw`\bnode\s+--test\b`,
    String.raw`\b(?:curl|wget|grpcurl|httpie|k6)\b`,
    String.raw`\b(?:psql|mysql|sqlite3|mongosh|redis-cli)\b`,
  ].join('|'),
  'i',
)

// MCP tools that query a database, drive a browser or read live telemetry.
const CHECK_MCP = /playwright|puppeteer|browser|chrome|sql|postgres|mysql|mongo|redis|database|bigquery|query|sentry|logging|monitoring|test/i

export function checkOf(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Bash') return CHECK_COMMAND.exec(String(input.command ?? ''))?.[0]
  if (tool.startsWith('mcp__') && CHECK_MCP.test(tool)) return tool
  return undefined
}

const CLAIM = new RegExp(
  [
    String.raw`\b(?:all\s+)?(?:the\s+)?(?:unit\s+|integration\s+|e2e\s+)?tests?\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed)?|are\s+(?:passing|green)|succeed(?:s|ed)?)\b`,
    String.raw`\ball\s+(?:green|passing|checks\s+pass(?:ed)?)\b`,
    String.raw`\b(?:it|they|build|suite|ci|checks?|lint|everything)\s+(?:now\s+)?pass(?:es|ed)?\b`,
    String.raw`\bpassed\b(?!\s+(?:to|in|into|as|through|by|the|a|an|it|them|along|down|on|over)\b)`,
    String.raw`(?<!\b(?:a|the)\s)\bfixed\b(?![-\w])(?!\s+(?:size|width|height|point|cost|number|rate|length|position|at|by)\b)`,
    String.raw`\bverified\b`,
    String.raw`\b(?:works|working)\s+now\b|\bnow\s+works\b|\bit\s+works\b`,
    String.raw`\bno\s+breaking\s+changes?\b`,
    String.raw`\bbuilds?\s+(?:succeeds|succeeded|is\s+green|passes|cleanly|successfully)\b`,
    String.raw`\b(?:sudah|udah)\s+(?:jalan|berjalan|beres|fix|aman|bisa|works?)\b`,
    String.raw`\bberhasil\b`,
    String.raw`\b(?:test|tes)\s+(?:sudah\s+)?lulus\b`,
  ].join('|'),
  'gi',
)

// Words earlier in the same sentence that turn a claim into a hedge, a negation or a plan.
const HEDGE =
  /\b(?:not|never|cannot|unable|without|unverified|untested|should|will|would|might|may|could|if|once|until|unless|to|ensure|expect|expected|hope|whether|belum|tidak|tak|gak|nggak|bukan|kalau|jika|harusnya|seharusnya|semoga|supaya)\b|n't\b/i

/** The reply with code, inline code, block quotes and quoted strings removed. */
export function stripQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
}

/** The first success claim the reply states as fact, if any. */
export function findClaim(answer: string): string | undefined {
  const text = stripQuoted(answer)
  for (const m of text.matchAll(CLAIM)) {
    const sentence = text.slice(Math.max(0, m.index - 80), m.index).split(/[.!?;:\n]/).at(-1) ?? ''
    if (!HEDGE.test(sentence)) return m[0].replace(/\s+/g, ' ').trim()
  }
  return undefined
}

const SECRETS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED KEY]'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic|Token)\s+[\w.~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1[REDACTED]@'],
  [/\b((?:set-)?cookie)\s*:\s*[^\n]+/gi, '$1: [REDACTED]'],
  [/\b(password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[REDACTED]'],
  [/\bsshpass\s+-p\s*\S+/g, 'sshpass -p [REDACTED]'],
  [/\b(sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|glpat-[\w-]{16,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35})/g, '[REDACTED KEY]'],
  [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, '[REDACTED]'],
]

export function redact(text: string): string {
  return SECRETS.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text)
}

const excerpt = (text: string) => (text.length > 3000 ? `${text.slice(0, 1000)}\n…\n${text.slice(-2000)}` : text)

type Confirmed = 'yes' | 'no' | 'unavailable'

// Jev drops hedges, recaps of an earlier turn's run and plain edit notes that the phrase list cannot tell apart.
async function confirm($: EngineInterface, answer: string, claim: string, tools: number): Promise<Confirmed> {
  const request = {
    state: {
      reply: excerpt(redact(stripQuoted(answer))),
      matched_phrase: redact(claim),
      tool_calls_this_turn: tools,
      note: 'No test, build, lint, curl or DB check ran this turn.',
    },
    questions: {
      claims: {
        type: 'noul',
        instructions:
          'Does `reply` assert, as a fact, that work was verified to succeed or now works (tests pass, bug fixed and working, build green, verified, no breaking change, nothing else affected)? False if it only hedges (should/might/once you run), only describes edits made, or reports a result from an earlier turn.',
      },
    },
  }
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const ran = await $.process.run([home ? `${home}/.local/bin/jev` : 'jev'], { stdin: JSON.stringify(request), timeoutMs: JEV_TIMEOUT_MS })
    if (ran.exitCode !== 0) return 'unavailable'
    const noul = (JSON.parse(ran.stdout) as { claims?: { noul?: unknown } }).claims?.noul
    if (typeof noul !== 'number') return 'unavailable'
    return noul >= MIN_CLAIM ? 'yes' : 'no'
  } catch {
    return 'unavailable'
  }
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    await $.state.set(TURN, { tools: 0, checks: [] })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      const check = checkOf(String(e.tool), e as Record<string, unknown>)
      await update($, TURN, t => ({ tools: (t?.tools ?? 0) + 1, checks: check ? [...(t?.checks ?? []), check] : (t?.checks ?? []) }))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done

    const { value: turn } = await $.state.get(TURN)
    if (turn && turn.checks.length > 0) return done
    const claim = findClaim(e.answer)
    if (!claim) return done

    const confirmed = await confirm($, e.answer, claim, turn?.tools ?? 0)
    if (confirmed === 'no') return done

    const shown = redact(claim).slice(0, 80)
    const text =
      `evidence-check: the reply claims "${shown}" but no test or check ran this turn` +
      (confirmed === 'unavailable' ? ' (Jev unavailable: phrase match only)' : '')
    $.ui.toast(text, { timeoutMs: 8000 })
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
    return done
  }).catch(($, e, next) => next(e))
}
