import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { IntentGateIntent, IntentGatePrevious, IntentGateTurn } from '../types/index'

const TURN = { plugin: 'intent-gate', key: 'turn' } as const
const PREVIOUS = { plugin: 'intent-gate', key: 'previous' } as const
const MODE = { plugin: 'intent-gate', key: 'mode' } as const
const PINNED = { plugin: 'intent-gate', key: 'pinned' } as const
const RUNNING = { plugin: 'intent-gate', key: 'running' } as const

const INTENTS: readonly IntentGateIntent[] = ['question', 'plan', 'review', 'execute', 'ops', 'none']
const BLOCKING: readonly IntentGateIntent[] = ['question', 'plan', 'review']
const MIN_CONFIDENCE = 0.6
const JEV_TIMEOUT_MS = 8000

// Prompts a person (or their own script) wrote; other origins keep the previous intent.
const PERSON_ORIGINS = ['composer', 'bridge', 'sdk']

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// Secrets the user pastes into prompts. Jev is an external API: these never leave the machine.
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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)

const GIT_WRITE =
  /\bgit\s+(?:-[Cc]\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*(?:add|commit|push|reset|rebase|merge|cherry-pick|revert|restore|clean|rm|mv|am|apply|stash(?!\s+(?:list|show)\b)|checkout\b[^;&|\n]*\s--(?:\s|$))/

export function isGitWrite(command: string): boolean {
  return GIT_WRITE.test(command)
}

const PLAN_PATH = [/(^|\/)(plans|specs|adrs?)\//i, /(^|\/)docs\/superpowers(\/|$)/, /\/\.local\/state\/zstack(\/|$)/, /^\/tmp\//]

export function isPlanPath(path: string): boolean {
  return !/(^|\/)\.\.(\/|$)/.test(path) && PLAN_PATH.some(p => p.test(path))
}

function editedPath(e: Record<string, unknown>): string {
  const path = e.file_path ?? e.notebook_path
  return typeof path === 'string' ? path : ''
}

export type Verdict = { intent?: IntentGateIntent; confidence?: number; source: IntentGateTurn['source'] }

export function readJevAnswer(stdout: string): Verdict {
  const answers = JSON.parse(stdout) as { intent?: { choice?: unknown; confidence?: unknown } }
  const choice = answers.intent?.choice
  const confidence = answers.intent?.confidence
  if (typeof choice !== 'string' || !INTENTS.includes(choice as IntentGateIntent) || typeof confidence !== 'number') {
    return { source: 'unavailable' }
  }
  const intent = choice as IntentGateIntent
  return confidence < MIN_CONFIDENCE ? { intent, confidence, source: 'unsure' } : { intent, confidence, source: 'jev' }
}

export function jevRequest(prompt: string, previous: IntentGatePrevious | undefined) {
  return {
    state: {
      prompt: clip(redact(prompt), 2000),
      previous_turn: {
        intent: previous?.intent ?? 'unknown',
        prompt: clip(redact(previous?.prompt ?? ''), 300),
        assistant_reply_tail: redact(previous?.replyTail ?? ''),
      },
      policy:
        'Classify what the person wants done THIS turn. A terse follow-up ("continue", "go", "lanjutin", "1. A 2. yes") keeps the previous turn intent unless it explicitly asks to start changing things.',
    },
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Which intent best describes `prompt`, using `previous_turn` only to interpret terse follow-ups?',
        criteria: {
          question: 'Asks a question, wants an opinion, explanation or diagnosis; no change to files wanted',
          plan: 'Wants a plan, spec, design or ADR written or discussed; explicitly not the implementation yet',
          review: 'Wants a review, audit or check of existing code or changes, with no edits',
          execute: 'Wants files changed: write, fix, implement, refactor, revert, edit config or docs, continue implementing, commit or push',
          ops: 'Wants something run or operated: trigger, deploy, run a job or command until it works',
          none: 'Unclear, empty, or not a request',
        },
      },
    },
  }
}

async function classify($: EngineInterface, prompt: string, previous: IntentGatePrevious | undefined): Promise<Verdict> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const ran = await $.process.run([home ? `${home}/.local/bin/jev` : 'jev'], {
      stdin: JSON.stringify(jevRequest(prompt, previous)),
      timeoutMs: JEV_TIMEOUT_MS,
    })
    return ran.exitCode === 0 ? readJevAnswer(ran.stdout) : { source: 'unavailable' }
  } catch {
    return { source: 'unavailable' }
  }
}

export function statusLine(turn: IntentGateTurn | undefined, mode: 'auto' | 'off' | undefined): string | undefined {
  if (mode === 'off') return 'intent: off'
  if (!turn) return undefined
  if (turn.source === 'unavailable') return 'intent: ? (Jev unavailable)'
  if (turn.source === 'unsure') return `intent: ? (unsure, ${turn.intent} ${turn.confidence?.toFixed(2)})`
  return `intent: ${turn.intent}${turn.source === 'override' ? ' (set by /intent)' : ''}`
}

function denyReason(turn: IntentGateTurn, what: string): string {
  const by = turn.source === 'override' ? 'set by /intent' : `Jev ${turn.confidence?.toFixed(2)}`
  const instead = turn.intent === 'plan' ? 'write the plan (plan files under plans/, specs/, adr/ or /tmp are allowed) or reply in text' : 'answer in text'
  return (
    `intent-gate: the user's request this turn is "${turn.intent}" (${by}), so ${what} is blocked. ` +
    `Do not change files or git state; ${instead}. If changes are needed, describe them and ask the user to reply "go" (or run /intent execute).`
  )
}

const USAGE = 'Usage: /intent <execute|question|plan|review|off|auto>'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'intent',
      description: 'Override intent-gate: set this turn\'s intent, or switch the gate off/auto for the session.',
      argumentHint: '<execute|question|plan|review|off|auto>',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'intent' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'auto') {
      await $.state.set(MODE, arg)
      await $.state.set(PINNED, null)
      const { value: turn } = await $.state.get(TURN)
      $.ui.status(statusLine(turn, arg))
      return { text: arg === 'off' ? 'intent-gate is off for this session. /intent auto turns it back on.' : 'intent-gate classifies prompts again.' }
    }
    const intent = INTENTS.find(i => i === arg && i !== 'none')
    if (!intent) return { text: USAGE }

    // Mid-turn the override applies to the running turn; when idle, to the next prompt.
    const { value: running } = await $.state.get(RUNNING)
    const turn: IntentGateTurn = { intent, source: 'override' }
    await $.state.set(MODE, 'auto')
    await $.state.set(TURN, turn)
    await $.state.set(PINNED, running ? null : intent)
    $.ui.status(statusLine(turn, 'auto'))
    return { text: `intent set to ${intent} for ${running ? 'the running turn' : 'your next prompt'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.includes(e.origin.kind) || e.text.trimStart().startsWith('/intent')) return next(e)
    const { value: mode } = await $.state.get(MODE)
    if (mode === 'off') return next(e)

    const { value: pinned } = await $.state.get(PINNED)
    let turn: IntentGateTurn
    if (pinned) {
      turn = { intent: pinned, source: 'override' }
      await $.state.set(PINNED, null)
    } else {
      const { value: previous } = await $.state.get(PREVIOUS)
      turn = await classify($, e.text, previous)
    }
    await $.state.set(TURN, turn)
    await update($, PREVIOUS, p => ({ intent: turn.intent, prompt: e.text, replyTail: p?.replyTail ?? '' }))
    $.ui.status(statusLine(turn, mode))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await $.state.set(RUNNING, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await $.state.set(RUNNING, false)
      await update($, PREVIOUS, p => ({ intent: p?.intent, prompt: p?.prompt ?? '', replyTail: tail(e.answer, 400) }))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isEdit = EDIT_TOOLS.includes(tool)
    const command = tool === 'Bash' ? String((e as Record<string, unknown>).command ?? '') : ''
    if (!isEdit && !isGitWrite(command)) return next(e)

    const { value: mode } = await $.state.get(MODE)
    const { value: turn } = await $.state.get(TURN)
    if (mode === 'off' || !turn?.intent || turn.source === 'unavailable' || turn.source === 'unsure') return next(e)
    if (!BLOCKING.includes(turn.intent)) return next(e)

    if (isEdit) {
      const path = editedPath(e as Record<string, unknown>)
      if (turn.intent === 'plan' && isPlanPath(path)) return next(e)
      return { deny: denyReason(turn, `${tool} on ${path || 'a file'}`) }
    }
    return { deny: denyReason(turn, 'a git write') }
  }).catch(($, e, next) => next(e))
}
