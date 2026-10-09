import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Seen = { toasts: string[]; statuses: (string | undefined)[] }

function engine(on: On): Seen {
  const seen: Seen = { toasts: [], statuses: [] }
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('classic.Notification', () => ({}))
  return seen
}

const done = (durationMs: number, extra: { isAborted?: boolean; agentId?: string } = {}) =>
  ({ answer: 'ok', durationMs, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as const

describe('turn-done-alert', () => {
  test('a long turn shows a heartbeat, then a toast with duration and tool count', async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Bash', command: 'pwd' })

    await clock.advance(60_000)
    expect(seen.statuses).toEqual([])

    await clock.advance(120_000)
    expect(seen.statuses.at(-1)).toBe('working 3m · 2 tools')

    await $.turn.complete(done(185_000))
    expect(seen.statuses.at(-1)).toBeUndefined()
    expect(seen.toasts).toEqual(['Turn done in 3m 5s · 2 tools'])

    // The heartbeat stops with the turn.
    const after = seen.statuses.length
    await clock.advance(60_000)
    expect(seen.statuses.length).toBe(after)
  })

  test('short, aborted and subagent turns stay quiet', async ($, on) => {
    mock.clock(on)
    const seen = engine(on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete(done(59_000))
    await $.turn.complete(done(300_000, { isAborted: true }))
    await $.turn.complete(done(300_000, { agentId: 'a1' }))
    expect(seen.toasts).toEqual([])
  })

  test('the threshold comes from userConfig', { options: { thresholdSeconds: 10 } }, async ($, on) => {
    mock.clock(on)
    const seen = engine(on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete(done(12_000))
    expect(seen.toasts).toEqual(['Turn done in 12s · 0 tools'])
  })

  test('a question or a permission prompt says Claude is waiting', async ($, on) => {
    const seen = engine(on)
    await $.tool.call({
      tool: 'AskUserQuestion',
      questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
    })
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
    expect(seen.toasts).toEqual(['waiting for you: a question', 'waiting for you: permission needed'])
  })
})
