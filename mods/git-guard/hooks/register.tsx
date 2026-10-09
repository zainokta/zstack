import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { ASK, addedPaths, asks, fromRoot, gitCalls, isDocPath, refusal, stripAttribution } from './rules'
import type { GitCall } from './rules'

const lastPrompt = atom({ plugin: 'git-guard', key: 'prompt' } as const, '')
const paused = atom({ plugin: 'git-guard', key: 'paused' } as const, false)

const GIT = /\bgit\b/

async function absDir($: EngineInterface, dir: string | null): Promise<string | undefined> {
  if (dir === null) return undefined
  if (dir === '~' || dir.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}${dir.slice(1)}`
  return dir
}

async function gitLines($: EngineInterface, cwd: string | undefined, args: string[]): Promise<string[]> {
  const run = await $.process.run(['git', ...args], { cwd, timeoutMs: 8000 })
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim().slice(0, 160)}`)
  return run.stdout.split('\n').filter(l => l !== '')
}

/** Repo-root paths the commit at `at` would record: the index plus what the line stages first. */
async function committedPaths($: EngineInterface, calls: GitCall[], at: number): Promise<string[]> {
  const cwd = await absDir($, calls[at]!.dir)
  const probe = await $.process.run(['git', 'rev-parse', '--show-prefix'], { cwd, timeoutMs: 8000 })
  if (probe.exitCode !== 0) return [] // not a repo: the commit fails on its own
  const prefix = probe.stdout.trim()
  const { paths, broad, all } = addedPaths(calls, at)
  const found = new Set(await gitLines($, cwd, ['diff', '--cached', '--name-only']))
  for (const p of paths) found.add(fromRoot(prefix, p))
  if (broad || all) for (const p of await gitLines($, cwd, ['diff', '--name-only', 'HEAD'])) found.add(p)
  if (broad) for (const p of await gitLines($, cwd, ['ls-files', '--others', '--exclude-standard', '--full-name'])) found.add(p)
  return [...found]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-guard',
      description: 'Pause (off) or resume (on) git-guard for this session',
      argumentHint: 'on|off',
    })
    return next(e)
  })

  on('command.run', { command: 'git-guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await update($, paused, () => arg === 'off')
      return { text: arg === 'off' ? 'git-guard paused for this session.' : 'git-guard is on.' }
    }
    return { text: `git-guard is ${(await read($, paused)) ? 'paused' : 'on'}. Use /git-guard off or /git-guard on.` }
  })

  // What the person asked this turn. Their own Enter or their phone; not a
  // script, a notification or another session.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      await update($, lastPrompt, () => e.text)
    }
    return next(e)
  })

  on('attribution.text', ($, e, next) => (e.kind === 'commit' || e.kind === 'pr' ? { text: '' } : next(e)))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = stripAttribution(e.command)
    const pass = () => next(command === e.command ? e : { ...e, command })
    if (!GIT.test(command) || (await read($, paused))) return pass()

    const prompt = await read($, lastPrompt)
    const calls = gitCalls(command)
    for (const call of calls) {
      const why = refusal(call, prompt)
      if (why !== null) return { deny: `git-guard: ${why}` }
    }

    const at = calls.findIndex(c => c.sub === 'commit')
    if (at >= 0 && !asks(prompt, ASK.docs)) {
      const named = prompt.toLowerCase()
      const docs = (await committedPaths($, calls, at))
        .filter(isDocPath)
        .filter(p => !named.includes((p.split('/').pop() ?? p).toLowerCase()))
      if (docs.length > 0) {
        const list = docs.slice(0, 15).join(', ') + (docs.length > 15 ? `, +${docs.length - 15} more` : '')
        return {
          deny: `git-guard: this commit would include docs/plans/notes the user didn't ask to commit: ${list}. Leave them out (\`git restore --staged <path>\`) and commit the rest; mention them to the user instead.`,
        }
      }
    }
    return pass()
  }).catch(($, e, next) => {
    // Fail closed for git (Jev: fail_closed 0.83); anything else goes on.
    if (next.called) return next(e)
    return e.tool === 'Bash' && GIT.test(e.command)
      ? { deny: 'git-guard: its check failed, so this git command was not run. Retry, or the user can run /git-guard off.' }
      : next(e)
  })
}
