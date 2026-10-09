import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const PANE = 'stack-blast-radius'
const SURFACES = ['terminal', 'desktop'] as const

type World = { ran: string[]; surfaces: RenderSurface[]; isPlaced: boolean; runs: string[]; counted: string[]; opened: number; sleepMs: number }

const world = (over: Partial<World> = {}): World => ({ ran: [], surfaces: ['terminal'], isPlaced: true, runs: [], counted: [], opened: 0, sleepMs: 250, ...over })

// The engine beneath the plugin.
function engine(on: On, w: World): MockClock {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.root', () => ({ value: '/home/me/repo' }))
  on('session.cwd', () => ({ value: '/home/me/repo' }))
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  on('ui.open', () => {
    w.opened += 1
    return { value: w.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow terminal' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('fs.read', ($, e) => ({ value: e.path === '/home/me/repo/db/reset.sql' ? 'SELECT 1;\nDROP TABLE users;' : 'INSERT INTO t VALUES (1);' }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', ($, e) => {
    const sql = (e as unknown as { sql?: string }).sql
    if (sql?.startsWith('SELECT COUNT')) {
      w.counted.push(sql)
      return { result: { content: [] }, text: '[{"n": 42}]' }
    }
    w.ran.push(e.tool === 'Bash' ? e.command : `${String(e.tool)}: ${sql}`)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: 'ran' }
  })
  on('process.run', async ($, e) => {
    const argv = e.argv.join(' ')
    if (e.argv[0] === 'sleep') await clock.sleep(w.sleepMs) // a slow sleep stands for many polls
    if (e.argv[0] !== 'sleep') w.runs.push(argv)
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.includes('workspace show')) return out('prod\n')
    if (argv.includes(' plan ')) return out('  # aws_db_instance.main must be replaced\nPlan: 1 to add, 0 to change, 1 to destroy.\n')
    if (argv.startsWith('kubectl config current-context')) return out('gke_prod\n')
    return out('')
  })
  return clock
}

/** Waits (yielding to the held call) until `done` holds. */
async function until(clock: MockClock, done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 5000; i += 1) {
    if (await done()) return
    await clock.settle()
  }
  throw new Error('gave up waiting')
}

/** Mounts the pane once the call is held, and waits for its dry run. */
async function heldPane($: Engine, clock: MockClock, w: World, surface: RenderSurface = 'terminal', component: 'Pane' | 'AbovePrompt' = 'Pane') {
  const before = w.opened
  await until(clock, () => w.opened > before)
  const ui = component === 'Pane'
    ? await $.ui.mount({ plugin: PANE, surface, component, props: PANE_PROPS, requestId: PANE })
    : await $.ui.mount({ plugin: PANE, surface, component, props: BAND_PROPS })
  await until(clock, async () => (await ui.find({ type: 'Text', text: /Blast Radius/ })) !== undefined && (await ui.find({ type: 'Text', text: /Running the dry run/ })) === undefined)
  return ui
}

const PANE_PROPS = {
  title: 'Blast Radius',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }

describe('stack-blast-radius', () => {
  test('holds terraform apply with the plan, runs it on Proceed', async ($, on) => {
    const w = world()
    const clock = engine(on, w)
    for (const surface of SURFACES) {
      w.ran = []
      const call = $.tool.call({ tool: 'Bash', command: 'terraform apply -auto-approve' })
      const ui = await heldPane($, clock, w, surface)
      expect((await ui.find({ type: 'Text', text: /Blast Radius/ }))?.text).toContain('terraform apply')
      expect(await ui.find({ type: 'Text', text: /workspace: prod/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /Plan: 1 to add/ }))).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /must be replaced/ }))).toBeDefined()
      expect(w.ran).toEqual([])
      await ui.press({ key: 'proceed' })
      await clock.advance(250)
      const result = await call
      expect(result.deny).toBeUndefined()
      expect(w.ran).toEqual(['terraform apply -auto-approve'])
      expect(w.runs.some(r => r.includes('plan -no-color -input=false -lock=false'))).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Cancel refuses it with a reason', async ($, on) => {
    const w = world()
    const clock = engine(on, w)
    const call = $.tool.call({ tool: 'Bash', command: 'kubectl --context gke_prod -n api delete deploy web' })
    const ui = await heldPane($, clock, w)
    expect(await ui.find({ type: 'Text', text: /context: gke_prod  ·  namespace: api/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await clock.advance(250)
    expect((await call).deny).toContain('the user pressed Cancel')
    expect(w.ran).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  })

  test('with no screen (claude -p) it refuses at once', async ($, on) => {
    const w = world({ surfaces: [] })
    const clock = engine(on, w)
    const result = await $.tool.call({ tool: 'Bash', command: 'pulumi destroy --yes' })
    expect(result.deny).toContain('no screen')
    expect(w.ran).toEqual([])
  })

  test('no answer in five minutes refuses it', async ($, on) => {
    const w = world({ sleepMs: 60_000 })
    const clock = engine(on, w)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf src' })
    await heldPane($, clock, w)
    await clock.advance(6 * 60_000)
    expect((await call).deny).toContain('no answer within 5 minutes')
    expect(w.ran).toEqual([])
  })

  test('a range DELETE through the MySQL MCP tool shows a live count, in the band when no pane fits', async ($, on) => {
    const w = world({ isPlaced: false })
    const clock = engine(on, w)
    const tool = 'mcp__mcp_server_mysql__mysql_query'
    const call = $.tool.call({ tool, sql: "DELETE FROM sessions WHERE created_at < '2024-01-01'" } as never)
    const band = await heldPane($, clock, w, 'terminal', 'AbovePrompt')
    expect(w.counted).toEqual(["SELECT COUNT(*) AS n FROM sessions WHERE created_at < '2024-01-01'"])
    expect(await band.find({ type: 'Text', text: /range WHERE/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /42 row\(s\) match/ })).toBeDefined()
    await band.press({ key: 'proceed' })
    await clock.advance(250)
    expect((await call).deny).toBeUndefined()
    expect(w.ran).toEqual([`${tool}: DELETE FROM sessions WHERE created_at < '2024-01-01'`])
  })

  test('an UPDATE with no WHERE is flagged, and passwords are masked', async ($, on) => {
    const w = world()
    const clock = engine(on, w)
    const call = $.tool.call({ tool: 'Bash', command: 'mysql -uroot -pHunter2 app -e "UPDATE users SET plan = \'free\'"' })
    const ui = await heldPane($, clock, w, 'desktop')
    expect(await ui.find({ type: 'Text', text: /No WHERE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /mysql -uroot -p\*\*\* app/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).not.toContain('Hunter2')
    expect(await ui.find({ type: 'Text', text: /not run for the mysql\/psql CLI/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await clock.advance(250)
    expect((await call).deny).toContain('Cancel')
  })

  test('SQL fed from a file is read and held only when it is destructive', async ($, on) => {
    const w = world()
    const clock = engine(on, w)
    expect((await $.tool.call({ tool: 'Bash', command: 'mysql app < db/seed.sql' })).deny).toBeUndefined()
    const call = $.tool.call({ tool: 'Bash', command: 'cd db && mysql app < reset.sql' })
    const ui = await heldPane($, clock, w)
    expect(await ui.find({ type: 'Text', text: /Drops table users/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await clock.advance(250)
    expect((await call).deny).toContain('Cancel')
    expect(w.ran).toEqual(['mysql app < db/seed.sql'])
  })

  test('safe commands and reads pass straight through', async ($, on) => {
    const w = world()
    const clock = engine(on, w)
    expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf dist && terraform plan' })).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'mcp__mcp_server_mysql__mysql_query', sql: 'SELECT * FROM users WHERE id = 1' } as never)).deny).toBeUndefined()
    expect(w.ran).toHaveLength(2)
    expect(w.opened).toBe(0)
  })
})
