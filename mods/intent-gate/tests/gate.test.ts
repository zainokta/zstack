import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Jev = { intent: string; confidence: number } | 'down'

// Stands in for the engine and the host beneath the plugin: Jev's answers, the status line, the tools.
function world(on: On, answers: Jev[]) {
  const sent: string[] = []
  const statuses: (string | undefined)[] = []
  const ran: string[] = []
  mock.env(on, { HOME: '/home/u' })
  on('process.run', ($, e) => {
    sent.push(e.init?.stdin ?? '')
    const next = answers.shift() ?? 'down'
    if (next === 'down') return { deny: 'jev timed out' }
    const stdout = JSON.stringify({ intent: { type: 'choice', choice: next.intent, confidence: next.confidence } })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    ran.push(String(e.tool))
    return { result: {} } as never
  })
  return { sent, statuses, ran }
}

const say = ($: Engine, text: string, kind: 'composer' | 'sdk' | 'task-notification' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind } })

const edit = ($: Engine, file_path = '/repo/src/auth.go') =>
  $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

const intent = ($: Engine, args: string) =>
  $.command.run({ command: 'intent', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

describe('intent-gate', () => {
  test('a review turn blocks edits and git writes but not reads or tests', async ($, on) => {
    const w = world(on, [{ intent: 'review', confidence: 0.96 }])
    await say($, "review it, don't execute lol")

    const denied = await edit($)
    expect(denied.deny).toContain('"review"')
    expect(denied.deny).toContain('reply "go"')
    expect((await bash($, 'git add -A && git commit -m wip')).deny).toContain('git write')
    expect((await bash($, 'git status && git diff')).deny).toBeUndefined()
    expect((await bash($, 'go test ./...')).deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash', 'Bash'])
    expect(w.statuses.at(-1)).toBe('intent: review')
  })

  test('an execute turn lets edits through', async ($, on) => {
    const w = world(on, [{ intent: 'execute', confidence: 1 }])
    await say($, 'fix the null pointer in auth.go')
    expect((await edit($)).deny).toBeUndefined()
    expect((await bash($, 'git commit -am fix')).deny).toBeUndefined()
    expect(w.ran).toEqual(['Edit', 'Bash'])
  })

  test('a plan turn may write plan files only', async ($, on) => {
    world(on, [{ intent: 'plan', confidence: 0.9 }])
    await say($, "put the plan into the docs, don't execute yet")
    expect((await edit($, '/repo/docs/superpowers/plans/2026-auth.md')).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs/specs/auth.md', content: 'x' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Write', file_path: '/tmp/plan.md', content: 'x' })).deny).toBeUndefined()
    expect((await edit($, '/repo/src/auth.go')).deny).toContain('"plan"')
    expect((await edit($, '/repo/docs/plans/../../src/auth.go')).deny).toContain('"plan"')
  })

  test('Jev down or unsure fails open and says so', async ($, on) => {
    const w = world(on, ['down', { intent: 'review', confidence: 0.5 }])
    await say($, 'review the auth module')
    expect(w.statuses.at(-1)).toBe('intent: ? (Jev unavailable)')
    expect((await edit($)).deny).toBeUndefined()

    await say($, 'hmm')
    expect(w.statuses.at(-1)).toContain('intent: ? (unsure')
    expect((await edit($)).deny).toBeUndefined()
  })

  test('secrets are redacted before the prompt reaches Jev', async ($, on) => {
    const w = world(on, [{ intent: 'question', confidence: 0.9 }])
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    await say($, `why does this 401? Authorization: Bearer ${jwt} db postgres://app:hunter2@db:5432/x password=s3cret`)
    const sent = w.sent[0] ?? ''
    expect(sent).not.toContain(jwt)
    expect(sent).not.toContain('hunter2')
    expect(sent).not.toContain('s3cret')
    expect(sent).toContain('why does this 401?')
  })

  test('a terse follow-up carries the previous intent and reply as evidence', async ($, on) => {
    const w = world(on, [{ intent: 'plan', confidence: 0.95 }, { intent: 'plan', confidence: 0.94 }])
    await say($, 'plan the auth rewrite, no code yet')
    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete({ answer: 'Question 1: which DB? A) Postgres B) MySQL', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await say($, '1. A 2. yes')
    const second = JSON.parse(w.sent[1] ?? '{}') as { state: { previous_turn: Record<string, string> } }
    expect(second.state.previous_turn.intent).toBe('plan')
    expect(second.state.previous_turn.assistant_reply_tail).toContain('which DB?')
  })

  test('only prompts a person wrote are classified', async ($, on) => {
    const w = world(on, [{ intent: 'question', confidence: 0.9 }])
    await say($, 'build finished', 'task-notification')
    expect(w.sent).toHaveLength(0)
    await say($, 'what does this do?', 'sdk')
    expect(w.sent).toHaveLength(1)
    expect((await edit($)).deny).toContain('"question"')
  })

  test('/intent overrides the next prompt, and off/auto switch the gate', async ($, on) => {
    const w = world(on, [{ intent: 'review', confidence: 0.96 }])
    expect((await intent($, 'execute')).text).toContain('your next prompt')
    await say($, 'review it')
    expect(w.sent).toHaveLength(0)
    expect((await edit($)).deny).toBeUndefined()

    await say($, 'review it')
    expect((await edit($)).deny).toContain('"review"')

    await intent($, 'off')
    expect(w.statuses.at(-1)).toBe('intent: off')
    expect((await edit($)).deny).toBeUndefined()

    await intent($, 'auto')
    expect((await edit($)).deny).toContain('"review"')
    expect((await intent($, 'bogus')).text).toContain('Usage')
  })

  test('/intent mid-turn applies to the running turn', async ($, on) => {
    world(on, [{ intent: 'execute', confidence: 1 }])
    await say($, 'implement it')
    await $.turn.start({ text: 'implement it', turnId: 't1' })
    expect((await intent($, 'review')).text).toContain('the running turn')
    expect((await edit($)).deny).toContain('set by /intent')
  })
})
