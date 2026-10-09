import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult, PromptComposeResult } from 'claude-code'

const HOME = '/home/u/.local/state/zstack'
const HOUSE = '/opt/zstack/rules/house.md'

function listing(houseBody = '- Never commit docs.') {
  return [
    `## ${HOUSE}\n# House rules\n\n## Git\n${houseBody}\n`,
    `## ${HOME}/rules/global.md\n- use postgres 18 for uuidv7  <!-- added 2026-10-09T17:32:30 -->\n`,
    `## ${HOME}/rules/r.md\n- never put anything inside cmd/  <!-- added 2026-10-09T17:32:31 -->\n`,
  ].join('\n')
}

type World = {
  zstack: 'ok' | 'missing' | 'failing'
  out: string
  calls: string[][]
  mtime: number
  statuses: (string | undefined)[]
}

const ok = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function engine(on: On, w: World) {
  on('process.run', ($, e) => {
    w.calls.push([...e.argv])
    if (w.zstack === 'missing') return { deny: 'ENOENT: zstack' }
    if (w.zstack === 'failing') return { value: { ...ok(''), exitCode: 1, stderr: 'boom' } }
    if (e.argv[2] === 'list') return { value: ok(w.out) }
    return { value: ok(`did ${e.argv.slice(1).join(' ')}`) }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.list', () => ({ value: [{ name: 'global.md', kind: 'file' as const, size: 40, mtimeMs: w.mtime, isLink: false }] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 3700, mtimeMs: 1, isLink: false } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine prompt', scope: 'shared' as const }] }))
}

const world = (over: Partial<World> = {}): World => ({ zstack: 'ok', out: listing(), calls: [], mtime: 1, statuses: [], ...over })

function compose($: Engine): Promise<PromptComposeResult> {
  return $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
}

async function rules($: Engine, args: string) {
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'rules', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  return r.text ?? ''
}

const listCalls = (w: World) => w.calls.filter(c => c[2] === 'list').length

describe('rules-injector', () => {
  test('appends one session section: project rules first, comments stripped', async ($, on) => {
    const w = world()
    engine(on, w)
    const { sections } = await compose($)
    expect(sections.map(s => s.id)).toEqual(['intro', 'rules-injector:rules'])
    const mine = sections[1]
    expect(mine?.scope).toBe('session')
    const text = mine?.text ?? ''
    expect(w.calls[0]).toEqual(['zstack', 'rule', 'list', '--repo', '/r'])
    expect(text).not.toContain('<!--')
    expect(text).not.toMatch(/^# House rules$/m)
    expect(text).toContain('## House rules\n### Git\n- Never commit docs.')
    const at = (s: string) => text.indexOf(s)
    expect(at('## Project rules (/r)')).toBeGreaterThan(-1)
    expect(at('never put anything inside cmd/')).toBeLessThan(at('use postgres 18'))
    expect(at('use postgres 18')).toBeLessThan(at('Never commit docs'))
  })

  test('reads zstack once per change of the rules files', async ($, on) => {
    const w = world()
    engine(on, w)
    await compose($)
    await compose($)
    await compose($)
    expect(listCalls(w)).toBe(1)

    w.mtime = 2
    w.out = listing().replace('cmd/', 'cmd/ or internal/cmd')
    const { sections } = await compose($)
    expect(listCalls(w)).toBe(2)
    expect(sections[1]?.text).toContain('internal/cmd')
  })

  test('caps the section and cuts house rules before the user’s own', async ($, on) => {
    const w = world({ out: listing('- a long generic rule about something.\n'.repeat(1000)) })
    engine(on, w)
    const text = (await compose($)).sections[1]?.text ?? ''
    expect(text.length).toBeLessThan(12_100)
    expect(text).toContain('never put anything inside cmd/')
    expect(text).toContain('use postgres 18')
    expect(text).toMatch(/more characters of rules cut; run \/rules to see all\]$/)
  })

  test('without zstack it leaves the prompt alone and says so once', async ($, on) => {
    const w = world({ zstack: 'missing' })
    engine(on, w)
    expect((await compose($)).sections.map(s => s.id)).toEqual(['intro'])
    expect((await compose($)).sections.map(s => s.id)).toEqual(['intro'])
    expect(w.statuses).toEqual(['rules-injector: zstack not found, standing rules are not injected'])
    expect(w.calls.length).toBe(1)
  })

  test('a failed re-read keeps the last good rules', async ($, on) => {
    const w = world()
    engine(on, w)
    const first = (await compose($)).sections[1]?.text
    w.zstack = 'failing'
    w.mtime = 2
    expect((await compose($)).sections[1]?.text).toBe(first)
    expect(listCalls(w)).toBe(2)
  })

  test('/rules lists, adds, adds per project and forgets through zstack', async ($, on) => {
    const w = world()
    engine(on, w)
    expect(await rules($, '')).toContain('never put anything inside cmd/')

    await rules($, 'add never commit docs')
    await rules($, 'add-project use postgres 18 for uuidv7')
    await rules($, 'forget postgres 18')
    expect(w.calls.filter(c => c[2] !== 'list')).toEqual([
      ['zstack', 'rule', 'add', '--', 'never commit docs'],
      ['zstack', 'rule', 'add', '--project', '--repo', '/r', '--', 'use postgres 18 for uuidv7'],
      ['zstack', 'rule', 'forget', '--', 'postgres 18'],
    ])

    // A change made through /rules is re-read on the next prompt even with the same mtimes.
    const before = listCalls(w)
    await compose($)
    expect(listCalls(w)).toBe(before + 1)
  })

  test('/rules refuses a too-broad forget and explains its usage', async ($, on) => {
    const w = world()
    engine(on, w)
    expect(await rules($, 'forget pg')).toContain('pattern too short')
    expect(await rules($, 'add')).toContain('usage: /rules')
    expect(await rules($, 'frobnicate')).toContain('usage: /rules')
    expect(w.calls.filter(c => c[2] === 'forget' || c[2] === 'add')).toEqual([])
  })
})
