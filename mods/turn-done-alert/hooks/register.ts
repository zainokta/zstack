import type { EngineInterface, Register, Timer } from 'claude-code'

const HEARTBEAT_AFTER_MS = 120_000
const TICK_MS = 15_000
const TOAST_MS = 30_000

// What each classic Notification type means for someone who is not looking.
const WAITING: Record<string, string> = {
  permission_prompt: 'waiting for you: permission needed',
  elicitation_dialog: 'waiting for you: input requested',
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function heartbeat(elapsedMs: number, tools: number): string {
  return `working ${Math.floor(elapsedMs / 60_000)}m · ${tools} tool${tools === 1 ? '' : 's'}`
}

// The running turn's bookkeeping. Nothing draws from it, so a hot reload losing
// it only costs the heartbeat and toast of the turn running at that moment.
type Live = { startedAt?: number; tools: number; tick?: Timer }

async function beat($: EngineInterface, live: Live): Promise<void> {
  if (live.startedAt === undefined) {
    return
  }
  const elapsed = (await $.clock.now()) - live.startedAt
  if (elapsed >= HEARTBEAT_AFTER_MS) {
    $.ui.status(heartbeat(elapsed, live.tools))
  }
}

export const register: Register = (on, options) => {
  const thresholdMs = Number(options.thresholdSeconds ?? 60) * 1000

  const live: Live = { tools: 0 }

  on('turn.start', async ($, e, next) => {
    live.startedAt = await $.clock.now()
    live.tools = 0
    live.tick?.cancel()
    live.tick = $.clock.every(TICK_MS, () => {
      beat($, live).catch(() => {})
    })
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (live.startedAt !== undefined) {
      live.tools += 1
    }
    if (e.tool === 'AskUserQuestion') {
      $.ui.toast('waiting for you: a question', { timeoutMs: TOAST_MS })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', ($, e, next) => {
    const text = WAITING[e.notification_type]
    if (text !== undefined) {
      $.ui.toast(text, { timeoutMs: TOAST_MS })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Subagent runs end their own turns inside the main one.
    if (e.agentId !== undefined) {
      return next(e)
    }
    const count = live.tools
    live.tick?.cancel()
    live.tick = undefined
    live.startedAt = undefined
    $.ui.status(undefined)

    if (!e.isAborted && e.durationMs >= thresholdMs) {
      const verb = e.reason === 'answer' ? 'Turn done in' : `Turn ended (${e.reason}) after`
      $.ui.toast(`${verb} ${duration(e.durationMs)} · ${count} tool${count === 1 ? '' : 's'}`, { timeoutMs: TOAST_MS })
    }
    return next(e)
  })
}
