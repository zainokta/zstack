import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { parseStatus, testHead } from '../hooks/register'

const STATUS = [
  '# branch.oid 1234567890abcdef',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -0',
  '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
  '1 .M N... 100644 100644 100644 aaa bbb edited.ts',
  '1 MM N... 100644 100644 100644 aaa bbb both.ts',
  '? new.ts',
  '',
].join('\n')

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

type World = { gitRuns: number; failing: Set<string>; clock: MockClock }

function engine(on: On, status: Partial<ProcessRunResult> = { exitCode: 0, stdout: STATUS }): World {
  const world: World = { gitRuns: 0, failing: new Set(), clock: mock.clock(on, { now: 1_000_000 }) }
  on('process.run', () => {
    world.gitRuns += 1
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...status } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) =>
    e.tool === 'Bash' && world.failing.has(e.command)
      ? { isError: true, result: undefined, text: 'Exit code 1' }
      : { result: { stdout: '', stderr: '', interrupted: false } },
  )
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  return world
}

const start = { cwd: '/r', surface: 'terminal', isInteractive: true } as const

describe('ship-state', () => {
  test('the band shows branch, ahead/behind and dirty counts', async ($, on) => {
    engine(on)
    await $.session.start(start)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'ship-state', surface, component: 'AbovePrompt', props: BAND })
      expect((await ui.find({ key: 'ship-state' }))?.text).toContain('main ↑2 ↓0 · +2 ~2 ?1')
      expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
      await ui.unmount()
    }
  })

  test('outside a git repo, or under a survey, it draws nothing of its own', async ($, on) => {
    engine(on, { exitCode: 128, stdout: '' })
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'ship-state', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ key: 'ship-state' })).toBeUndefined()
    await ui.unmount()
  })

  test('a survey takes the band', async ($, on) => {
    engine(on)
    await $.session.start(start)
    const ui = await $.ui.mount({ plugin: 'ship-state', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
    expect(await ui.find({ key: 'ship-state' })).toBeUndefined()
    await ui.unmount()
  })

  test('the last test run shows with its result and age', async ($, on) => {
    const world = engine(on)
    await $.session.start(start)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'ship-state', surface, component: 'AbovePrompt', props: BAND, requestId: `band-${surface}` })

      await $.tool.call({ tool: 'Bash', command: 'cd api && go test ./...' })
      expect((await ui.find({ key: 'ship-state' }))?.text).toContain('✓ go test ./... 0s ago')

      await world.clock.advance(4 * 60_000)
      expect((await ui.find({ key: 'ship-state' }))?.text).toContain('✓ go test ./... 4m ago')

      world.failing.add('pnpm test --filter api')
      await $.tool.call({ tool: 'Bash', command: 'pnpm test --filter api' })
      expect((await ui.find({ key: 'ship-state' }))?.text).toContain('✗ pnpm test --filter api')
      await ui.unmount()
    }
  })

  test('a narrow band drops the test command before the branch', async ($, on) => {
    engine(on)
    await $.session.start(start)
    await $.tool.call({ tool: 'Bash', command: 'cargo test --workspace --all-features' })
    const ui = await $.ui.mount({ plugin: 'ship-state', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 36 } })
    const text = (await ui.find({ key: 'ship-state' }))?.text ?? ''
    expect(text).toContain('main ↑2 ↓0')
    expect(text).toContain('✓ 0s ago')
    expect(text).not.toContain('cargo')
    await ui.unmount()
  })

  test('git commands refresh the counts; other commands do not', async ($, on) => {
    const world = engine(on)
    await $.session.start(start)
    const before = world.gitRuns
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(world.gitRuns).toBe(before)
    await $.tool.call({ tool: 'Bash', command: 'git add . && git commit -m x && git push' })
    expect(world.gitRuns).toBe(before + 1)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    expect(world.gitRuns).toBe(before + 2)
  })

  test('test commands are matched at command positions only', () => {
    expect(testHead('cd api && go test ./...')).toBe('go test ./...')
    expect(testHead('rtk go test ./...')).toBe('go test ./...')
    expect(testHead('pnpm test --filter api')).toBe('pnpm test --filter api')
    expect(testHead('npx vitest run')).toBe('vitest run')
    expect(testHead('python -m pytest -q')).toBe('python -m pytest -q')
    expect(testHead('./gradlew test')).toBe('./gradlew test')
    expect(testHead('CI=1 uv run pytest -q')).toBe('pytest -q')
    expect(testHead('go test -run TestVeryLongName ./internal/...')).toBe('go test -run TestVeryLo…')
    expect(testHead('grep -rn pytest .')).toBeUndefined()
    expect(testHead("echo 'run cargo test later'")).toBeUndefined()
    expect(testHead('git status')).toBeUndefined()
  })

  test('detached heads and conflicts are counted', () => {
    const g = parseStatus('# branch.oid abcdef1234\n# branch.head (detached)\nu UU N... 1 2 3 4 a b c f.ts\n')
    expect(g).toMatchObject({ branch: 'HEAD@abcdef1', hasUpstream: false, conflicted: 1 })
  })
})
