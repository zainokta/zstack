import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ShipGit, ShipTest } from '../types'

const git = atom({ plugin: 'ship-state', key: 'git' } as const, null)
const lastTest = atom({ plugin: 'ship-state', key: 'test' } as const, null)
// The band's clock: a tick keeps "4m ago" moving while the session is idle.
const now = atom({ plugin: 'ship-state', key: 'now' } as const, 0)

const TICK_MS = 30_000
const HEAD_CHARS = 24

// Test runners at the start of a command segment, after any wrapper is stripped.
const TEST = /^(go test|pytest|python3? -m (pytest|unittest)|(npm|pnpm|yarn|bun)( run)? test|npx (vitest|jest)|vitest|jest|cargo (test|nextest)|make test|mvn\b.*\btest|(\.\/)?gradlew?\b.*\btest|deno test)\b/
const WRAPPER = /^(\w+=\S*\s+|rtk\s+|npx\s+(?=vitest|jest)|bunx\s+|pnpm exec\s+|time\s+|env\s+|uv run\s+|poetry run\s+)/
const GIT = /(^|[\s;&|(])git\s/

// The test command a shell line runs, cut to its head, or undefined.
export function testHead(command: string): string | undefined {
  for (const raw of command.split(/&&|\|\||[;|\n()]/)) {
    let segment = raw.trim()
    for (let stripped = segment.replace(WRAPPER, ''); stripped !== segment; stripped = segment.replace(WRAPPER, '')) {
      segment = stripped
    }
    if (TEST.test(segment)) {
      return segment.length > HEAD_CHARS ? `${segment.slice(0, HEAD_CHARS - 1)}…` : segment
    }
  }
  return undefined
}

export function runsGit(command: string): boolean {
  return GIT.test(command)
}

// `git status --porcelain=v2 --branch` into counts.
export function parseStatus(out: string): ShipGit {
  const g: ShipGit = { branch: '?', hasUpstream: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 }
  let oid = ''
  for (const line of out.split('\n')) {
    const [kind, a, b] = line.split(' ')
    if (kind === '#' && a === 'branch.oid') {
      oid = b ?? ''
    } else if (kind === '#' && a === 'branch.head') {
      g.branch = b ?? '?'
    } else if (kind === '#' && a === 'branch.upstream') {
      g.hasUpstream = true
    } else if (kind === '#' && a === 'branch.ab') {
      g.ahead = Math.abs(Number(b ?? 0))
      g.behind = Math.abs(Number(line.split(' ')[3] ?? 0))
    } else if (kind === '1' || kind === '2') {
      if (a?.[0] !== '.') g.staged += 1
      if (a?.[1] !== '.') g.modified += 1
    } else if (kind === 'u') {
      g.conflicted += 1
    } else if (kind === '?') {
      g.untracked += 1
    }
  }
  if (g.branch === '(detached)') {
    g.branch = `HEAD@${oid.slice(0, 7)}`
  }
  return g
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

type Part = { text: string; color?: string }

// The band's line, shortened to fit `columns`: the test's command goes first,
// then the whole test part; the branch part always stays.
export function shipLine(g: ShipGit, test: ShipTest | null, at: number, columns: number): Part[] {
  const sync = g.hasUpstream ? `↑${g.ahead} ↓${g.behind}` : 'no upstream'
  const dirty = [
    g.staged ? `+${g.staged}` : '',
    g.modified ? `~${g.modified}` : '',
    g.untracked ? `?${g.untracked}` : '',
    g.conflicted ? `!${g.conflicted}` : '',
  ].filter(Boolean).join(' ') || 'clean'
  const base: Part[] = [{ text: `${g.branch} ${sync}`, color: g.hasUpstream && g.ahead === 0 ? undefined : 'warning' }, { text: ` · ${dirty}` }]
  if (test === null) return base

  const mark: Part = { text: ` · ${test.isPassed ? '✓' : '✗'}`, color: test.isPassed ? 'success' : 'error' }
  const width = (parts: Part[]) => parts.reduce((n, p) => n + p.text.length, 0)
  for (const tail of [` ${test.command} ${ago(at - test.at)}`, ` ${ago(at - test.at)}`]) {
    const line = [...base, mark, { text: tail }]
    if (width(line) <= columns) return line
  }
  return base
}

type Live = { tick?: Timer }

async function refreshGit($: EngineInterface, live: Live): Promise<void> {
  let next: ShipGit | null = null
  try {
    const run = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 5000 })
    next = run.exitCode === 0 ? parseStatus(run.stdout) : null
  } catch {
    next = null
  }
  await update($, git, () => next)
  await tickNow($)
  // Started lazily so a hot reload, which drops timers, gets its tick back.
  live.tick ??= $.clock.every(TICK_MS, () => {
    tickNow($).catch(() => undefined)
  })
}

async function tickNow($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  await update($, now, () => t)
}

export const register: Register = on => {
  const live: Live = {}

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refreshGit($, live)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await refreshGit($, live)
    }
    return done
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const head = testHead(e.command)
    const isFinished = ran.deny === undefined && (ran.isError === true || (!ran.result.interrupted && ran.result.backgroundTaskId === undefined))
    if (head !== undefined && isFinished) {
      const at = await $.clock.now()
      await update($, lastTest, () => ({ isPassed: ran.isError !== true, command: head, at }))
      await update($, now, () => at)
    }
    if (runsGit(e.command)) {
      await refreshGit($, live)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = await read($, git)
    if (e.props.hasSurvey || g === null) {
      return next(e)
    }
    const parts = shipLine(g, await read($, lastTest), await read($, now), e.props.bodyColumns)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box key="ship-state">
          <Text dimColor wrap="truncate-end">
            {parts.map(p => (p.color ? <Text color={p.color}>{p.text}</Text> : p.text))}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })
}
