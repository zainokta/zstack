import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = { ran: string[]; staged: string; untracked: string; failGit: boolean; failStaged: boolean }

// The engine beneath the plugin: Bash records what reached it, git answers from `w`.
function engine(on: On, w: World) {
  on('tool.call', ($, e) => {
    w.ran.push(e.tool === 'Bash' ? e.command : String(e.tool))
    return { result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'boom' : '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (w.failGit) return out('', 128)
    if (argv.includes('rev-parse --show-prefix')) return out('\n')
    if (argv.includes('diff --cached')) return out(w.staged, w.failStaged ? 1 : 0)
    if (argv.includes('ls-files --others')) return out(w.untracked)
    return out('')
  })
}

const world = (): World => ({ ran: [], staged: '', untracked: '', failGit: false, failStaged: false })

async function say($: Engine, text: string, kind: 'composer' | 'sdk' = 'composer') {
  await $.prompt.submit({ text, wait: false, origin: { kind } })
}

async function bash($: Engine, command: string): Promise<string | undefined> {
  const r = await $.tool.call({ tool: 'Bash', command })
  return r.deny
}

describe('git-guard', () => {
  test('push needs the prompt to ask for it', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, 'fix the failing test')
    expect(await bash($, 'git push origin main')).toContain("didn't ask to push")
    await say($, 'just push dude, why rebase')
    expect(await bash($, 'git push origin main')).toBeUndefined()
    expect(await bash($, 'git pull --rebase && git push')).toContain('rebase')
    expect(w.ran).toEqual(['git push origin main'])
  })

  test('force push, amend and hard reset need their own words', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, 'push it')
    expect(await bash($, 'git push --force-with-lease')).toContain('force push')
    expect(await bash($, 'cd api && git -C sub commit --amend --no-edit')).toContain('amend')
    expect(await bash($, 'git reset --hard HEAD~1')).toContain('reset --hard')
    await say($, 'force push it, I rewrote history')
    expect(await bash($, 'git push -f')).toBeUndefined()
  })

  test('staging everything needs "all"', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, 'commit the fix')
    expect(await bash($, 'git add -A && git commit -m "fix"')).toContain('Stage explicit paths')
    expect(await bash($, 'git commit -am "fix"')).toContain('Stage explicit paths')
    await say($, 'commit all, I said all')
    expect(await bash($, 'git add . && git commit -m "fix"')).toBeUndefined()
  })

  test('a commit carrying docs is refused unless docs were asked for', async ($, on) => {
    const w = world()
    engine(on, w)
    w.staged = 'src/a.ts\ndocs/superpowers/plans/2026-10-09-auth.md\n'
    await say($, 'commit the auth fix')
    const why = await bash($, 'git commit -m "fix auth"')
    expect(why).toContain('docs/superpowers/plans/2026-10-09-auth.md')
    expect(why).not.toContain('src/a.ts')

    w.staged = 'src/a.ts\n'
    expect(await bash($, 'git add HANDOVER.md src/a.ts && git commit -m x')).toContain('HANDOVER.md')
    expect(await bash($, 'git add src/billing/plans/pricing.ts && git commit -m x')).toBeUndefined()

    w.staged = 'CLAUDE.md\n'
    expect(await bash($, 'git commit -m x')).toContain('CLAUDE.md')
    await say($, 'commit the CLAUDE.md change')
    expect(await bash($, 'git commit -m x')).toBeUndefined()
    await say($, 'commit the docs too')
    w.staged = 'docs/adr/0003-queue.md\n'
    expect(await bash($, 'git commit -m x')).toBeUndefined()
  })

  test('the co-author trailer is stripped before the command runs', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, 'commit it')
    const cmd = [
      'git commit -m "$(cat <<\'EOF\'',
      'fix: auth',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      '',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'EOF',
      ')"',
    ].join('\n')
    expect(await bash($, cmd)).toBeUndefined()
    expect(await bash($, 'git commit -m "fix" -m "Co-Authored-By: Claude Opus <noreply@anthropic.com>"')).toBeUndefined()
    expect(w.ran[0]).toContain('fix: auth')
    expect(w.ran[0]).not.toContain('Co-Authored-By')
    expect(w.ran[0]).not.toContain('Generated with')
    expect(w.ran[0]).toContain("EOF\n)\"")
    expect(w.ran[1]).toBe('git commit -m "fix"')
  })

  test('attribution text is empty for commits and PRs', async $ => {
    expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: Claude' })).text).toBe('')
    expect((await $.attribution.text({ kind: 'pr', text: 'Generated with Claude Code' })).text).toBe('')
  })

  test('"don\'t do any git command" stops git writes but not reads', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, "don't DO any git command, I currently doing some changes")
    expect(await bash($, 'git stash')).toContain('not to run git')
    expect(await bash($, 'git status && git diff')).toBeUndefined()
  })

  test('/git-guard off pauses it, on resumes', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, 'fix it')
    const run = (args: string) => $.command.run({ command: 'git-guard', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect((await run('off')).text).toContain('paused')
    expect(await bash($, 'git push')).toBeUndefined()
    await run('on')
    expect(await bash($, 'git push')).toContain("didn't ask")
  })

  test('only the person\'s own prompts count', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, 'tidy the code')
    await say($, 'push everything', 'sdk')
    expect(await bash($, 'git push')).toContain("didn't ask")
  })

  test('fails closed for git when it cannot read the index, open for other commands', async ($, on) => {
    const w = world()
    engine(on, w)
    await say($, 'commit it')
    w.failGit = true
    expect(await bash($, 'git commit -m x')).toBeUndefined() // not a repo: git fails on its own
    w.failGit = false
    w.failStaged = true
    expect(await bash($, 'git commit -m x')).toContain('its check failed')
    expect(await bash($, 'ls -la')).toBeUndefined()
  })
})
