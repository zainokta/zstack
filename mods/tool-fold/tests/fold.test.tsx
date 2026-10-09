import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Stands in for the engine's own drawing of the row, beneath the plugin.
function engineRows(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine {e.component}</Text>
  })
}

const BASH = {
  tool_use_id: 'tu-bash',
  tool: 'Bash',
  input: { command: 'cd repo\npnpm test --filter api' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
}

const SURFACES = ['terminal', 'desktop'] as const

describe('tool-fold', () => {
  test('a tool row starts folded and toggles on each press', async ($, on) => {
    engineRows(on)
    for (const surface of SURFACES) {
      const id = `${BASH.tool_use_id}-${surface}`
      const ui = await $.ui.mount({ plugin: 'tool-fold', surface, component: 'ToolUse', props: BASH, requestId: id })

      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      expect((await ui.find({ key: 'fold' }))?.text).toContain('▸')

      await ui.press({ key: 'fold' })
      expect((await ui.find({ type: 'Code' }))?.text).toContain('pnpm test --filter api')
      expect((await ui.find({ key: 'fold' }))?.text).toContain('▾')

      await ui.press({ key: 'fold' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('an edit unfolds into a diff of old and new text', async ($, on) => {
    engineRows(on)
    const props = {
      ...BASH,
      tool_use_id: 'tu-edit',
      tool: 'Edit',
      input: { file_path: '/r/calc.py', old_string: 'return a + 1', new_string: 'return a' },
    }
    const ui = await $.ui.mount({ plugin: 'tool-fold', surface: 'terminal', component: 'ToolUse', props, requestId: 'tu-edit' })
    await ui.press({ key: 'fold' })
    const diff = await ui.find({ type: 'Code' })
    expect(diff?.text).toContain('-return a + 1')
    expect(diff?.text).toContain('+return a')
    expect(JSON.stringify(diff)).toContain('"format":"diff"')
    await ui.unmount()
  })

  test('a small input keeps the engine row with no toggle', async ($, on) => {
    engineRows(on)
    const props = { ...BASH, tool_use_id: 'tu-read', tool: 'Read', input: { file_path: '/r/a.ts' } }
    const ui = await $.ui.mount({ plugin: 'tool-fold', surface: 'terminal', component: 'ToolUse', props, requestId: 'tu-read' })
    expect(await ui.find({ key: 'fold' })).toBeUndefined()
    await ui.unmount()
  })

  test('opening the row shows the full Bash output in its result', async ($, on) => {
    engineRows(on)
    const id = 'tu-out'
    const row = await $.ui.mount({ plugin: 'tool-fold', surface: 'terminal', component: 'ToolUse', props: { ...BASH, tool_use_id: id }, requestId: id })
    const result = await $.ui.mount({
      plugin: 'tool-fold',
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: id, tool: 'Bash', output: { stdout: 'line 1\nline 2\nline 300', stderr: '' }, isErrored: false },
      requestId: id,
    })
    expect(await result.find({ type: 'Code' })).toBeUndefined()
    expect((await result.find({ type: 'Text' }))?.text).toContain('engine')

    await row.press({ key: 'fold' })
    await result.redraw()
    expect((await result.find({ type: 'Code' }))?.text).toContain('line 300')

    await row.unmount()
    await result.unmount()
  })
})
