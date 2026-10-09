import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

function engine(on: On, usage: SessionUsage, lines: (string | undefined)[]) {
  on('session.usage', () => ({ value: usage }))
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

const TURN = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

describe('usage-meter', () => {
  test('shows context fill and rate-limit windows at session start', async ($, on) => {
    const lines: (string | undefined)[] = []
    engine(on, {
      startedAt: 0,
      context: { tokens: 84_200, window: 200_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 63.4 },
        { kind: 'seven_day', percentUsed: 12 },
      ],
    }, lines)
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    expect(lines).toEqual(['ctx 42% 84k/200k · 5h 63% · 7d 12%'])
  })

  test('refreshes after a turn and copes with missing figures', async ($, on) => {
    const lines: (string | undefined)[] = []
    engine(on, { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] }, lines)
    await $.turn.complete(TURN)
    expect(lines).toEqual(['ctx -- --/1M'])
  })

  test('a failing usage read leaves the turn untouched', async ($, on) => {
    on('session.usage', () => {
      throw new Error('no usage')
    })
    on('ui.log', () => ({ value: undefined }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    const result = await $.turn.complete(TURN)
    expect(result.text).toBe('done')
  })
})
