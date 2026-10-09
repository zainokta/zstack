import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput } from 'claude-code'

import { commandHead, errorLine } from '../hooks/register'

const TSC_FAIL = (line: number, col: number) =>
  `Exit code 2\nsrc/api/handler.ts(${line},${col}): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`

const PASTE = (port: number, at: string) =>
  `deploy broke again:\n${at} ERROR connect ECONNREFUSED 127.0.0.1:${port}\n    at TCPConnectWrap.afterConnect (node:net:1555:16)\nError: Redis connection to localhost:${port} failed`

const submit = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

// Stands in for the engine beneath the plugin.
function engine(on: On) {
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  const prompts: PromptSubmitInput[] = []
  let answer: { isError: boolean; text: string } = { isError: false, text: '' }

  on('tool.call', ($, e) =>
    answer.isError
      ? { isError: true as const, result: answer.text, text: answer.text }
      : { result: { stdout: answer.text, stderr: '', interrupted: false }, text: answer.text },
  )
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e)
    return { text: e.text, context: e.context }
  })
  const session = mock.session(on)
  const notes = () => session.appended().filter(r => r.door === 'note').map(r => JSON.stringify(r.message.content))

  return {
    toasts,
    status,
    prompts,
    notes,
    fail: (text: string) => (answer = { isError: true, text }),
    pass: () => (answer = { isError: false, text: 'ok' }),
  }
}

describe('loop-breaker', () => {
  test('a rerun of the same failure gets the same signature', () => {
    expect(errorLine(TSC_FAIL(46, 19))).toBe(errorLine(TSC_FAIL(52, 3)))
    expect(errorLine('Traceback (most recent call last):\n  File "/a/b.py", line 3\nModuleNotFoundError: No module named foo')).toBe(
      'modulenotfounderror: no module named foo',
    )
    expect(commandHead('cd repo && FORCE=1 pnpm test --filter api 2>&1 | tail -50')).toBe('pnpm test')
    expect(commandHead('python -m pytest tests/test_a.py -x')).toBe('python pytest')
    expect(commandHead('curl -H "Authorization: Bearer abc" https://x')).toBe('curl')
  })

  test('the second identical Bash failure asks the model to diagnose; the third pins a status', async ($, on) => {
    const seen = engine(on)
    seen.fail(TSC_FAIL(46, 19))

    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    expect(seen.notes()).toHaveLength(0)
    expect(seen.toasts).toHaveLength(0)

    seen.fail(TSC_FAIL(47, 2))
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    expect(seen.notes()).toHaveLength(1)
    expect(seen.notes()[0]).toContain('Stop patching')
    expect(seen.notes()[0]).toContain('npx tsc :: <path>(n,n): error tsn')
    expect(seen.toasts[0]).toContain('`npx tsc` failed the same way 2 times')
    expect(seen.status.at(-1)).toBeUndefined()

    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    expect(seen.notes()).toHaveLength(2)
    expect(seen.status.at(-1)).toContain('same failure 3x')
  })

  test('a success of the same command resets the count', async ($, on) => {
    const seen = engine(on)
    seen.fail(TSC_FAIL(46, 19))
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    seen.pass()
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    seen.fail(TSC_FAIL(46, 19))
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })

    expect(seen.notes()).toHaveLength(0)
  })

  test('different errors, and a run the user interrupted, are not a loop', async ($, on) => {
    const seen = engine(on)
    seen.fail(TSC_FAIL(46, 19))
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    seen.fail('Exit code 2\nsrc/a.ts(1,1): error TS2304: Cannot find name foo.')
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    seen.fail('Command was interrupted by user')
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
    await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })

    expect(seen.notes()).toHaveLength(0)
  })

  test('the same error pasted again, or "still same", adds a diagnosis note to the prompt', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit(PASTE(6379, '2026-10-09T10:00:01Z')))
    expect(seen.prompts[0]?.context).toBeUndefined()

    await $.prompt.submit(submit(PASTE(6380, '2026-10-09T10:04:52Z')))
    expect(seen.prompts[1]?.context?.[0]).toContain('reported the same error 2 times')

    await $.prompt.submit(submit('still same ahh'))
    expect(seen.prompts[2]?.context?.[0]).toContain('3 times')
    expect(seen.status.at(-1)).toContain('same failure 3x')

    await $.prompt.submit(submit('ok now add a README section'))
    expect(seen.prompts[3]?.context).toBeUndefined()
  })

  test('"same" with no earlier error, or a new error, starts no loop', async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(submit('oof, same'))
    await $.prompt.submit(submit(PASTE(6379, '10:00')))
    await $.prompt.submit(submit('Error: ENOSPC: no space left on device, write'))

    expect(seen.prompts.every(p => p.context === undefined)).toBe(true)
    expect(seen.toasts).toHaveLength(0)
  })
})
