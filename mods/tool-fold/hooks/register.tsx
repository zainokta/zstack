import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// One open/closed flag per tool call. ToolUse and ToolResult rows share it:
// both are drawn with the call's tool_use_id as their requestId.
const open = atom({ plugin: 'tool-fold', key: 'open' } as const, false)

// Inputs at or under this size already fit in the engine's own one-line row.
const SMALL_JSON = 160

type Fold = { source: string; language?: string; path?: string; format?: 'diff' }

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function hunk(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  return [`@@ -1,${a.length} +1,${b.length} @@`, ...a.map(l => `-${l}`), ...b.map(l => `+${l}`)].join('\n')
}

// What a call's row unfolds into: the code the model actually sent.
export function foldOf(tool: string, input: unknown): Fold | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  const i = input as Record<string, unknown>
  const path = str(i.file_path) ?? str(i.notebook_path)

  switch (tool) {
    case 'Bash': {
      const command = str(i.command)
      return command ? { source: command, language: 'bash' } : undefined
    }
    case 'Write': {
      const content = str(i.content)
      return content !== undefined ? { source: content, path } : undefined
    }
    case 'Edit': {
      const before = str(i.old_string)
      const after = str(i.new_string)
      return before !== undefined && after !== undefined
        ? { source: hunk(before, after), format: 'diff', path }
        : undefined
    }
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : []
      const hunks = edits.flatMap(e => {
        const before = str(e.old_string)
        const after = str(e.new_string)
        return before !== undefined && after !== undefined ? [hunk(before, after)] : []
      })
      return hunks.length ? { source: hunks.join('\n'), format: 'diff', path } : undefined
    }
    case 'NotebookEdit': {
      const source = str(i.new_source)
      return source !== undefined ? { source, language: 'python' } : undefined
    }
    case 'Agent':
    case 'Task': {
      const prompt = str(i.prompt)
      return prompt ? { source: prompt, language: 'markdown' } : undefined
    }
  }

  const json = JSON.stringify(input, null, 2)
  return json.length > SMALL_JSON ? { source: json, language: 'json' } : undefined
}

// The full result text for tools whose engine row only shows a preview.
export function outputOf(tool: string, output: unknown): string | undefined {
  if (tool !== 'Bash' || typeof output !== 'object' || output === null) {
    return undefined
  }
  const o = output as Record<string, unknown>
  const parts = [str(o.stdout), str(o.stderr)].filter((p): p is string => !!p && p.trim() !== '')
  return parts.length ? parts.join('\n') : undefined
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    const fold = foldOf(e.props.tool, e.props.input)
    const { Box, Button, Code } = $.ui.resolve(e)

    if (!fold || !Button || !Code) {
      return row
    }

    const member = memberOf(open, e)
    const isOpen = await read($, member)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button
            key="fold"
            plain
            label={isOpen ? '▾' : '▸'}
            onPress={() => update($, member, was => !was)}
          />
          <Box marginLeft={1}>{row}</Box>
        </Box>
        {isOpen ? (
          <Box key="code" paddingLeft={2}>
            <Code {...fold} />
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const full = e.props.isErrored ? undefined : outputOf(e.props.tool, e.props.output)
    const { Box, Code } = $.ui.resolve(e)

    if (full === undefined || !Code || !(await read($, memberOf(open, e)))) {
      return next(e)
    }

    return (
      <Box key="output" paddingLeft={2}>
        <Code source={full} />
      </Box>
    )
  })
}
