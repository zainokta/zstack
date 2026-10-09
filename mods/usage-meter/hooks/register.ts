import type { EngineInterface, Register, SessionUsage } from 'claude-code'

const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

export function tokens(n: number): string {
  if (n >= 1_000_000) {
    return `${Number((n / 1_000_000).toFixed(1))}M`
  }
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// Every percentage is "used", so the context and rate-limit figures read the same way.
export function usageLine(u: SessionUsage): string {
  const { percent, tokens: used, window } = u.context
  const ctx = `ctx ${percent === undefined ? '--' : `${percent}%`} ${used === undefined ? '--' : tokens(used)}/${tokens(window)}`
  const limits = u.rateLimits.map(r => `${WINDOW_LABELS[r.kind] ?? r.kind} ${Math.round(r.percentUsed)}%`)
  return [ctx, ...limits].join(' · ')
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    $.ui.status(usageLine(await $.session.usage()))
  } catch (error) {
    $.ui.log(`usage-meter: ${String(error)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    return done
  })
}
