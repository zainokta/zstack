import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ZstackPaneMessage, ZstackPaneRun, ZstackPaneView } from '../types'

const PANE = 'zstack'
const EVERY_MS = 3000
const ALERTS = 5
export const NO_RUN = 'no zstack run — start one with `zstack`'

const view = atom({ plugin: 'zstack-pane', key: 'view' } as const, { kind: 'loading' })
const draft = atom({ plugin: 'zstack-pane', key: 'draft' } as const, '')
const notice = atom({ plugin: 'zstack-pane', key: 'notice' } as const, '')

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {})
const str = (v: unknown, or = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : or)
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? ''

export function clip(s: string, width: number): string {
  if (width <= 0) return ''
  return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`
}

// `zstack status --json` plus the blocker/question messages, flattened for drawing.
export function toRun(status: unknown, messages: unknown[]): ZstackPaneRun {
  const s = obj(status)
  const meta = obj(s.run)
  const unread = obj(s.unread)
  const agents = Object.values(obj(s.agents)).map(raw => {
    const a = obj(raw)
    const id = str(a.id)
    return {
      id,
      role: str(a.role),
      harness: str(a.harness),
      model: str(a.model),
      state: str(a.state),
      task: typeof a.task === 'string' ? a.task : null,
      unread: num(unread[id]),
    }
  })
  const tasks = Object.values(obj(s.tasks)).map(raw => {
    const t = obj(raw)
    return {
      id: str(t.id),
      state: str(t.state),
      owner: typeof t.owner === 'string' ? t.owner : null,
      rounds: num(t.rounds),
      title: str(t.title),
    }
  })
  const alerts: ZstackPaneMessage[] = messages
    .map(raw => {
      const m = obj(raw)
      return { seq: num(m.seq), kind: str(m.kind), from: str(m.from), to: str(m.to), body: str(m.body) }
    })
    .sort((a, b) => a.seq - b.seq)
    .slice(-ALERTS)
  return {
    id: str(meta.id),
    goal: str(meta.goal),
    state: str(meta.state),
    maxAgents: num(meta.max_agents),
    maxParallel: num(meta.max_parallel),
    agents,
    tasks,
    alerts,
  }
}

const ACTIVE = new Set(['running', 'waiting'])

async function zstack($: EngineInterface, args: string[]) {
  return $.process.run(['zstack', ...args], { timeoutMs: 10_000 })
}

async function load($: EngineInterface): Promise<ZstackPaneView> {
  let status, blockers, questions
  try {
    ;[status, blockers, questions] = await Promise.all([
      zstack($, ['status', '--json']),
      zstack($, ['msg', 'log', '--json', '--kind', 'blocker', '--tail', String(ALERTS)]),
      zstack($, ['msg', 'log', '--json', '--kind', 'question', '--tail', String(ALERTS)]),
    ])
  } catch (err) {
    return { kind: 'error', text: `zstack did not run (${firstLine(String(err)) || 'not on PATH?'})` }
  }
  if (status.exitCode !== 0) {
    return /no run/.test(status.stderr) ? { kind: 'none' } : { kind: 'error', text: firstLine(status.stderr) || `zstack status exited ${status.exitCode}` }
  }
  try {
    const parse = (r: { exitCode: number; stdout: string }): unknown[] => {
      const v: unknown = r.exitCode === 0 ? JSON.parse(r.stdout) : []
      return Array.isArray(v) ? v : []
    }
    const run = toRun(JSON.parse(status.stdout), [...parse(blockers), ...parse(questions)])
    return { kind: 'run', run, at: new Date().toTimeString().slice(0, 8) }
  } catch {
    return { kind: 'error', text: 'zstack status --json did not return JSON' }
  }
}

// Module state: the poll timer dies with the module on reload, and session.start restarts it.
let timer: Timer | undefined
let isLoading = false

async function refresh($: EngineInterface): Promise<void> {
  if (isLoading) return
  isLoading = true
  try {
    const next = await load($)
    await update($, view, () => next)
  } finally {
    isLoading = false
  }
}

function startPolling($: EngineInterface): void {
  timer ??= $.clock.every(EVERY_MS, () => void refresh($))
}

function stopPolling(): void {
  timer?.cancel()
  timer = undefined
}

async function steer($: EngineInterface, text: string): Promise<void> {
  const body = text.trim()
  if (!body) return
  // Sent as `user`, not `manager`: zstack skips a sender's own messages, so a
  // manager-signed steer to `all` would never reach the manager itself.
  const sent = await zstack($, ['msg', 'send', '--as', 'user', '--to', 'all', '--kind', 'steer', `--body=${body}`, '--json']).catch(
    (err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }),
  )
  if (sent.exitCode === 0) {
    let seq = ''
    try {
      seq = ` #${str(obj(JSON.parse(sent.stdout)).seq)}`
    } catch {}
    await update($, draft, () => '')
    await update($, notice, () => `steer${seq} sent to all agents`)
    await refresh($)
  } else {
    await update($, notice, () => `steer failed: ${firstLine(sent.stderr) || `exit ${sent.exitCode}`}`)
  }
}

type Col<T> = { head: string; width: number; rank: number; flex?: true; cell: (row: T) => string }

// Keeps the columns that fit `room` in rank order, shown in their own order;
// the flex column takes whatever room is left.
export function fit<T>(cols: Col<T>[], room: number): Col<T>[] {
  const kept = new Set<Col<T>>()
  let used = 0
  for (const col of [...cols].sort((a, b) => a.rank - b.rank)) {
    const need = col.width + (kept.size ? 1 : 0)
    if (used + need <= room) {
      kept.add(col)
      used += need
    }
  }
  return cols.filter(c => kept.has(c)).map(c => (c.flex ? { ...c, width: c.width + room - used } : c))
}

type Agent = ZstackPaneRun['agents'][number]
type Task = ZstackPaneRun['tasks'][number]

const AGENT_COLS: Col<Agent>[] = [
  { head: 'agent', width: 12, rank: 0, cell: a => a.id },
  { head: 'role', width: 8, rank: 5, cell: a => a.role },
  { head: 'harness/model', width: 18, rank: 4, cell: a => `${a.harness}/${a.model}` },
  { head: 'state', width: 8, rank: 1, cell: a => a.state },
  { head: 'task', width: 5, rank: 2, cell: a => a.task ?? '-' },
  { head: 'unread', width: 6, rank: 3, cell: a => String(a.unread) },
]

const TASK_COLS: Col<Task>[] = [
  { head: 'task', width: 5, rank: 0, cell: t => t.id },
  { head: 'state', width: 8, rank: 1, cell: t => t.state },
  { head: 'owner', width: 12, rank: 3, cell: t => t.owner ?? '-' },
  { head: 'rounds', width: 6, rank: 4, cell: t => String(t.rounds) },
  { head: 'title', width: 10, rank: 2, flex: true, cell: t => t.title },
]

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'zstack' })
  await refresh($)
  startPolling($)
  return { text: 'zstack pane opened.' }
}

// Our own $.ui.close skips our ui.close hook, so stop the timer here too.
async function closePane($: EngineInterface) {
  stopPolling()
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const description = 'Show the current zstack run: agents, tasks, blockers; steer all agents'
    await $.command.register({ name: 'zstack-pane', description })
    await $.command.register({ name: 'zs', description })
    // A reload keeps the pane up but drops the timer: pick polling back up.
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      void refresh($)
      startPolling($)
    }
    return next(e)
  })

  on('command.run', { command: 'zstack-pane' }, $ => openPane($))
  on('command.run', { command: 'zs' }, $ => openPane($))

  on('ui.close', { id: PANE }, ($, e, next) => {
    stopPolling()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined // mobile draws no field
    const width = Math.max(10, e.props.bodyColumns)
    const v = await read($, view)
    const said = await read($, notice)
    const typed = await read($, draft)

    const table = <T,>(key: string, cols: Col<T>[], rows: T[], rowKey: (row: T) => string) => {
      const shown = fit(cols, width)
      const line = (k: string, cells: string[], dim: boolean) => (
        <Box key={k} flexDirection="row" columnGap={1}>
          {shown.map((c, i) => (
            <Box width={c.width} flexShrink={0}>
              <Text dimColor={dim} wrap="truncate-end">
                {clip(cells[i] ?? '', c.width)}
              </Text>
            </Box>
          ))}
        </Box>
      )
      return (
        <Box key={key} flexDirection="column">
          {line(`${key}:head`, shown.map(c => c.head), true)}
          {rows.map(r => line(`${key}:${rowKey(r)}`, shown.map(c => c.cell(r)), false))}
        </Box>
      )
    }

    let body
    if (v.kind === 'loading') {
      body = <Text dimColor>reading zstack…</Text>
    } else if (v.kind === 'none') {
      body = (
        <Box key="hint">
          <Text>{NO_RUN}</Text>
        </Box>
      )
    } else if (v.kind === 'error') {
      body = (
        <Box key="error">
          <Text color="red">{clip(v.text, width * 2)}</Text>
        </Box>
      )
    } else {
      const r = v.run
      const active = r.agents.filter(a => ACTIVE.has(a.state)).length
      body = (
        <Box flexDirection="column">
          <Box key="goal">
            <Text bold>{clip(r.goal, width * 2)}</Text>
          </Box>
          <Box key="header">
            <Text dimColor>
              {`run ${r.id} · ${r.state} · agents ${r.agents.length}/${r.maxAgents} · active ${active}/${r.maxParallel} · ${v.at}`}
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {r.agents.length ? table('agent', AGENT_COLS, r.agents, a => a.id) : <Text dimColor>no agents yet</Text>}
          </Box>
          <Box marginTop={1} flexDirection="column">
            {r.tasks.length ? table('task', TASK_COLS, r.tasks, t => t.id) : <Text dimColor>no tasks yet</Text>}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>blockers / questions</Text>
            {r.alerts.length ? (
              r.alerts.map(m => (
                <Box key={`alert:${m.seq}`}>
                  <Text color={m.kind === 'blocker' ? 'red' : 'yellow'} wrap="truncate-end">
                    {clip(`#${m.seq} ${m.kind} ${m.from}→${m.to}: ${firstLine(m.body)}`, width)}
                  </Text>
                </Box>
              ))
            ) : (
              <Text dimColor>none</Text>
            )}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {body}
        {said ? (
          <Box key="notice">
            <Text dimColor>{clip(said, width)}</Text>
          </Box>
        ) : null}
        {Input && v.kind === 'run' ? (
          <Box marginTop={1}>
            <Input
              key="steer"
              label="steer all: "
              placeholder="message every agent"
              submitLabel="send"
              value={typed}
              onInput={(text: string) => void update($, draft, () => text)}
              onSubmit={(text: string) => void steer($, text)}
            />
          </Box>
        ) : null}
        <Box flexDirection="row" columnGap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => closePane($)} />
        </Box>
      </Box>
    )
  })
}
