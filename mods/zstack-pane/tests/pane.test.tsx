import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const STATUS = {
  run: { id: '20261009-x', goal: 'split league service', repo: '/r', state: 'open', max_agents: 100, max_parallel: 8 },
  agents: {
    'worker-1': { id: 'worker-1', role: 'worker', harness: 'claude', model: 'sonnet', state: 'running', task: 't1' },
    'reviewer-1': { id: 'reviewer-1', role: 'reviewer', harness: 'codex', model: 'gpt-6-sol', state: 'done', task: null },
  },
  tasks: { t1: { id: 't1', title: 'move handlers out of cmd/', owner: 'worker-1', state: 'doing', rounds: 2 } },
  unread: { 'worker-1': 3, 'reviewer-1': 0, manager: 1 },
}
const BLOCKERS = [{ seq: 4, kind: 'blocker', from: 'worker-1', to: 'manager', ref: 't1', body: 'no db creds\nmore' }]
const QUESTIONS = [{ seq: 2, kind: 'question', from: 'worker-1', to: 'manager', ref: null, body: 'pg 16 or 18?' }]

type Fake = { status: 'run' | 'none' | 'missing'; calls: string[][] }

const ok = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// Everything beneath the plugin: the zstack CLI, panes and commands.
function engine(on: On, fake: Fake) {
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    fake.calls.push(argv)
    if (fake.status === 'missing') return { deny: 'ENOENT: zstack' }
    const args = argv.slice(1).join(' ')
    if (fake.status === 'none') {
      return { value: { ...ok(''), exitCode: 1, stderr: 'zstack: no run: pass --run, set ZSTACK_RUN, or `zstack init` first' } }
    }
    if (args.startsWith('status')) return { value: ok(JSON.stringify(STATUS)) }
    if (args.includes('--kind blocker')) return { value: ok(JSON.stringify(BLOCKERS)) }
    if (args.includes('--kind question')) return { value: ok(JSON.stringify(QUESTIONS)) }
    if (args.startsWith('msg send')) return { value: ok(JSON.stringify({ seq: 9 })) }
    return { value: { ...ok(''), exitCode: 2, stderr: 'unexpected' } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

async function openPane($: Engine) {
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  return $.command.run({ command: 'zs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

function mountPane($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 100) {
  return $.ui.mount({
    plugin: 'zstack-pane',
    surface,
    component: 'Pane',
    requestId: 'zstack',
    props: { title: 'zstack', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

const statusCalls = (fake: Fake) => fake.calls.filter(c => c[1] === 'status').length

describe('zstack-pane', () => {
  test('/zs draws the run: header, agents, tasks and the latest blockers and questions', async ($, on) => {
    const fake: Fake = { status: 'run', calls: [] }
    engine(on, fake)
    mock.clock(on)
    expect((await openPane($)).text).toContain('opened')

    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ key: 'goal' }))?.text).toBe('split league service')
      const header = (await ui.find({ key: 'header' }))?.text
      expect(header).toContain('run 20261009-x · open')
      expect(header).toContain('agents 2/100')
      expect(header).toContain('active 1/8')

      const worker = (await ui.find({ key: 'agent:worker-1' }))?.text ?? ''
      for (const part of ['worker-1', 'worker', 'claude/sonnet', 'running', 't1', '3']) expect(worker).toContain(part)
      const task = (await ui.find({ key: 'task:t1' }))?.text ?? ''
      for (const part of ['t1', 'doing', 'worker-1', '2', 'move handlers out of cmd/']) expect(task).toContain(part)

      expect((await ui.find({ key: 'alert:2' }))?.text).toContain('question worker-1→manager: pg 16 or 18?')
      const blocker = (await ui.find({ key: 'alert:4' }))?.text
      expect(blocker).toContain('blocker worker-1→manager: no db creds')
      expect(blocker).not.toContain('more')
      expect(await ui.find({ key: 'steer' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('with no run it shows the one-line hint and no steer field', async ($, on) => {
    const fake: Fake = { status: 'none', calls: [] }
    engine(on, fake)
    mock.clock(on)
    await openPane($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ key: 'hint' }))?.text).toBe('no zstack run — start one with `zstack`')
      expect(await ui.find({ key: 'steer' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a missing zstack is reported in the pane, not thrown', async ($, on) => {
    const fake: Fake = { status: 'missing', calls: [] }
    engine(on, fake)
    mock.clock(on)
    await openPane($)
    const ui = await mountPane($, 'terminal')
    expect((await ui.find({ key: 'error' }))?.text).toContain('zstack did not run')
    await ui.unmount()
  })

  test('a narrow pane drops the low-value columns but keeps id, state and task', async ($, on) => {
    engine(on, { status: 'run', calls: [] })
    mock.clock(on)
    await openPane($)
    for (const surface of SURFACES) {
      const wide = await mountPane($, surface, 100)
      expect((await wide.find({ key: 'agent:head' }))?.text).toContain('harness/model')
      await wide.unmount()

      const narrow = await mountPane($, surface, 36)
      const head = (await narrow.find({ key: 'agent:head' }))?.text ?? ''
      expect(head).toContain('agent')
      expect(head).toContain('state')
      expect(head).toContain('task')
      expect(head).not.toContain('harness/model')
      expect(head).not.toContain('role')
      expect((await narrow.find({ key: 'task:head' }))?.text).toContain('title')
      expect((await narrow.find({ key: 'task:head' }))?.text).not.toContain('owner')
      await narrow.unmount()
    }
  })

  test('the steer field sends one steer message to all agents and clears', async ($, on) => {
    const fake: Fake = { status: 'run', calls: [] }
    engine(on, fake)
    mock.clock(on)
    await openPane($)
    for (const surface of SURFACES) {
      fake.calls.length = 0
      const ui = await mountPane($, surface)
      await ui.input({ key: 'steer', text: 'use postgres 18', kind: 'change' })
      await ui.input({ key: 'steer', text: 'use postgres 18' })
      const sent = fake.calls.filter(c => c[1] === 'msg' && c[2] === 'send')
      expect(sent).toEqual([['zstack', 'msg', 'send', '--as', 'user', '--to', 'all', '--kind', 'steer', '--body=use postgres 18', '--json']])
      expect((await ui.find({ key: 'notice' }))?.text).toBe('steer #9 sent to all agents')
      expect((await ui.find({ key: 'steer' }))?.props.value).toBe('')
      await ui.unmount()
    }
  })

  test('it refreshes every 3 s and on Refresh, and stops once closed', async ($, on) => {
    const fake: Fake = { status: 'run', calls: [] }
    engine(on, fake)
    const clock = mock.clock(on)
    await openPane($)
    const seen = [statusCalls(fake)]
    await clock.advance(3000)
    seen.push(statusCalls(fake))
    await clock.advance(6000)
    seen.push(statusCalls(fake))
    expect(seen).toEqual([1, 2, 4])

    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'refresh' })
    expect(statusCalls(fake)).toBe(5)
    await ui.press({ key: 'close' })
    await clock.advance(9000)
    expect(statusCalls(fake)).toBe(5)
    await ui.unmount()
  })
})
