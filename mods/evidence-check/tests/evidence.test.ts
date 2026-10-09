import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Jev = number | 'down'

// Stands in for the engine and the host beneath the plugin: tools, Jev's answers, toasts and the transcript.
function world(on: On, answers: Jev[]) {
  const asked: string[] = []
  const toasts: string[] = []
  mock.env(on, { HOME: '/home/u' })
  const session = mock.session(on)
  on('process.run', ($, e) => {
    asked.push(e.init?.stdin ?? '')
    const next = answers.shift() ?? 'down'
    if (next === 'down') return { deny: 'jev timed out' }
    const stdout = JSON.stringify({ claims: { type: 'noul', noul: next } })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) =>
    String(e.tool) === 'Bash' && String((e as Record<string, unknown>).command).startsWith('curl') ? { deny: 'not allowed' } : ({ result: {} } as never),
  )
  const notices = () => session.appended().filter(r => r.message.type === 'system').map(r => JSON.stringify(r.message.content))
  return { asked, toasts, notices }
}

async function turn($: Engine, answer: string, tools: Record<string, unknown>[] = [], agentId?: string) {
  await $.turn.start({ text: 'go', turnId: 't' })
  for (const call of tools) await $.tool.call(call as never)
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) })
}

const EDIT = { tool: 'Edit', file_path: '/r/a.go', old_string: 'a', new_string: 'b' }

describe('evidence-check', () => {
  test('a success claim with no check ran is flagged in the transcript and a toast', async ($, on) => {
    const w = world(on, [0.89])
    await turn($, 'Fixed the race in worker.go. All tests pass now.', [EDIT])
    expect(w.notices()).toHaveLength(1)
    expect(w.notices()[0]).toContain('evidence-check: the reply claims \\"Fixed\\" but no test or check ran this turn')
    expect(w.toasts[0]).toContain('no test or check ran this turn')
  })

  test('a test run or a check-like MCP call is evidence', async ($, on) => {
    const w = world(on, [0.9])
    await turn($, 'All tests pass now.', [EDIT, { tool: 'Bash', command: 'cd api && go test ./...' }])
    await turn($, 'Verified, the page works now.', [{ tool: 'mcp__playwright__browser_snapshot' }])
    await turn($, 'Berhasil, sudah jalan.', [{ tool: 'Bash', command: 'uv run pytest -q' }])
    expect(w.asked).toHaveLength(0)
    expect(w.notices()).toHaveLength(0)
  })

  test('a check the gate denied is no evidence, and evidence does not carry over turns', async ($, on) => {
    const w = world(on, [0.9, 0.9])
    await turn($, 'It works now.', [{ tool: 'Bash', command: 'curl -s localhost:8080/health' }])
    await turn($, 'tests pass', [{ tool: 'Bash', command: 'pnpm test' }])
    await turn($, 'Done, tests pass.', [EDIT])
    expect(w.notices()).toHaveLength(2)
  })

  test('quoted, coded and hedged claims are not claims', async ($, on) => {
    const w = world(on, [0.9])
    await turn($, 'You asked "do the tests pass?" — I have not run them yet.')
    await turn($, 'Run this:\n```\ngo test ./... # all tests pass\n```\nand `it works now` should print.')
    await turn($, '> tests pass\nThat was the old log.')
    await turn($, 'This should pass once you run the suite. I could not verify it here.')
    await turn($, 'Belum berhasil, masih error.')
    expect(w.asked).toHaveLength(0)
    expect(w.notices()).toHaveLength(0)
  })

  test('Jev drops recaps and edit notes the phrase list cannot tell apart', async ($, on) => {
    const w = world(on, [0.18])
    await turn($, 'Yes, in the previous run go test ./... passed.')
    expect(w.asked).toHaveLength(1)
    expect(w.notices()).toHaveLength(0)
  })

  test('with Jev down the phrase match stands, and says so', async ($, on) => {
    const w = world(on, ['down'])
    await turn($, 'Sudah jalan sekarang.', [EDIT])
    expect(w.notices()[0]).toContain('Jev unavailable')
  })

  test("subagent turns and secrets in the reply stay out of Jev's request", async ($, on) => {
    const w = world(on, [0.9])
    await turn($, 'All tests pass.', [], 'agent-1')
    expect(w.asked).toHaveLength(0)
    await turn($, 'Fixed: login works now with password=hunter2 and token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', [EDIT])
    expect(w.asked[0]).not.toContain('hunter2')
    expect(w.asked[0]).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(w.notices()).toHaveLength(1)
  })
})
