import { commands, joinDir, program } from './shell'

export type GitCall = {
  sub: string
  args: string[]
  /** Where git runs: the line's `cd`s, then `-C`; null = the session folder. */
  dir: string | null
}

/** Every `git <sub>` on the line, in order. */
export function gitCalls(line: string): GitCall[] {
  const out: GitCall[] = []
  for (const { words, dir } of commands(line)) {
    if (program(words[0]) !== 'git') continue
    let at = dir
    let i = 1
    while (i < words.length && words[i]!.startsWith('-')) {
      const opt = words[i]!
      if (opt === '-C') {
        at = joinDir(at, words[i + 1])
        i += 2
      } else if (opt === '-c' || opt === '--git-dir' || opt === '--work-tree' || opt === '--namespace') {
        i += 2
      } else {
        i += 1
      }
    }
    const sub = words[i]
    if (sub !== undefined) out.push({ sub, args: words.slice(i + 1), dir: at })
  }
  return out
}

// ---- What the prompt asked for ----------------------------------------------

const NEGATION = /\b(don'?t|dont|do not|never|no|not|stop|why|jangan|gak|ga|nggak|tidak|tanpa|without)\b/i

/**
 * True when the prompt names the thing and the few words before it, in the same
 * clause, don't negate it: "just push" yes, "why rebase" and "don't push" no.
 */
export function asks(prompt: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, 'gi')
  for (const m of prompt.matchAll(global)) {
    const clause = prompt.slice(0, m.index).split(/[.,!?;:\n]/).pop() ?? ''
    const before = clause.trim().split(/\s+/).slice(-3).join(' ')
    if (!NEGATION.test(before)) return true
  }
  return false
}

export const ASK = {
  push: /\b(push|ship|deploy)\w*/,
  force: /\bforce|\bpush\s+-f\b/,
  rebase: /\brebas\w*/,
  amend: /\bamend\w*/,
  resetHard: /\breset\s+(--)?hard\b|\bhard[- ]reset\b/,
  clean: /\bgit\s+clean\b|\buntracked\b/,
  discard: /\bdiscard\w*|\bbuang\w*|\bgit\s+(checkout|restore)\s+(--\s+)?\./,
  all: /\ball\b|\bsemua\b/,
  docs: /\b(docs?|documentation|readme|adrs?|dokumen\w*)\b/,
}

/** "don't DO any git command", "jangan pakai git": no git writes this turn. */
const NO_GIT = /\b(don'?t|dont|do not|never|jangan)\s+((do|run|use|touch|make|execute|any|pakai|pake|jalankan|lakukan)\s+){0,2}git\b/i

const READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'describe',
  'shortlog', 'cat-file', 'merge-base', 'help', 'version', 'reflog', 'rev-list', 'whatchanged',
])

function readsOnly({ sub, args }: GitCall): boolean {
  if (READ_ONLY.has(sub)) return sub !== 'reflog' || args[0] === undefined || args[0] === 'show'
  if (sub === 'branch') return args.every(a => /^(-v+|-a|-r|--list|--show-current|--contains|--merged|--no-merged)$/.test(a))
  if (sub === 'remote') return args.length === 0 || args[0] === '-v' || args[0] === 'show' || args[0] === 'get-url'
  if (sub === 'stash') return args[0] === 'list' || args[0] === 'show'
  if (sub === 'config') return args.some(a => a === '--get' || a === '--list' || a === '-l' || a === '--get-all')
  if (sub === 'worktree') return args[0] === 'list'
  return false
}

const short = (args: readonly string[], letter: string) =>
  args.some(a => new RegExp(`^-[a-zA-Z]*${letter}[a-zA-Z]*$`).test(a))

/** Why this call is refused given the prompt, or null when it may run. */
export function refusal(call: GitCall, prompt: string): string | null {
  const { sub, args } = call
  const named = `git ${[sub, ...args].join(' ')}`.slice(0, 120)
  if (NO_GIT.test(prompt) && !readsOnly(call)) {
    return `\`${named}\` refused: the user said not to run git commands this turn. Do not run git; tell the user what you would run.`
  }
  if (sub === 'push') {
    const isForce = args.some(a => a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || /^\+/.test(a)) || short(args, 'f')
    if (isForce && !asks(prompt, ASK.force)) {
      return `\`${named}\` refused: a force push needs the user to ask for it this turn ("force push"). Ask the user instead.`
    }
    if (!asks(prompt, ASK.push)) {
      return `\`${named}\` refused: the user didn't ask to push this turn. Stop after committing and say it's ready to push.`
    }
  }
  if (sub === 'rebase' || (sub === 'pull' && args.some(a => a === '--rebase' || a.startsWith('--rebase=') || a === '-r'))) {
    if (!asks(prompt, ASK.rebase)) {
      return `\`${named}\` refused: the user didn't ask for a rebase this turn. Don't rebase; if a push is rejected, report it and ask.`
    }
  }
  if (sub === 'commit' && args.includes('--amend') && !asks(prompt, ASK.amend)) {
    return `\`${named}\` refused: the user didn't ask to amend this turn. Make a new commit instead.`
  }
  if (sub === 'reset' && args.includes('--hard') && !asks(prompt, ASK.resetHard)) {
    return `\`${named}\` refused: \`git reset --hard\` throws away work and the user didn't ask for it this turn.`
  }
  if (sub === 'clean' && (args.includes('--force') || short(args, 'f')) && !asks(prompt, ASK.clean)) {
    return `\`${named}\` refused: \`git clean -f\` deletes untracked files and the user didn't ask for it this turn.`
  }
  const dropsAll = (sub === 'checkout' && args.includes('.')) ||
    (sub === 'restore' && args.includes('.') && !(args.includes('--staged') && !args.includes('--worktree')))
  if (dropsAll && !asks(prompt, ASK.discard)) {
    return `\`${named}\` refused: it discards every uncommitted change and the user didn't ask for that this turn.`
  }
  if (isBroadAdd(call) && !asks(prompt, ASK.all)) {
    return `\`${named}\` refused: the user didn't say to commit "all". Stage explicit paths (\`git add <file> ...\`) for the files you changed for this task.`
  }
  return null
}

/** `git add -A/--all/./:/`, `git commit -a`: stages everything. */
export function isBroadAdd({ sub, args }: GitCall): boolean {
  if (sub === 'add') return args.some(a => a === '-A' || a === '--all' || a === '.' || a === ':/' || a === '*' || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(a))
  if (sub === 'commit') return args.includes('--all') || short(args, 'a')
  return false
}

// ---- Docs that shouldn't ride along in a commit -----------------------------

const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i

/** A path (from the repo root) that looks like a plan, spec, handover, ADR or agent note. */
export function isDocPath(path: string): boolean {
  const p = path.replace(/^\.\//, '')
  const base = p.split('/').pop() ?? p
  if (/^docs?\//i.test(p)) return true
  if (/(^|\/)(plans|specs)\//i.test(p) && DOC_EXT.test(p)) return true
  if (/(^|\/)(adrs?|decisions)\//i.test(p) && DOC_EXT.test(p)) return true
  if (/^adr[-_ ]?\d+/i.test(base)) return true
  if (/handover/i.test(base)) return true
  return /^(CLAUDE|AGENTS)(\.local)?\.md$/i.test(base)
}

/** Paths this commit's docs check should look at besides the index. */
export function addedPaths(calls: readonly GitCall[], commitAt: number): { paths: string[]; broad: boolean; all: boolean } {
  const paths: string[] = []
  let broad = false
  const VALUED = new Set(['-m', '--message', '-F', '--file', '-C', '-c', '--author', '--date', '-t', '--template', '--fixup', '--squash', '--reuse-message', '--reedit-message', '--pathspec-from-file'])
  calls.forEach((call, i) => {
    if (i > commitAt) return
    if (call.sub === 'add' && i < commitAt) {
      if (isBroadAdd(call)) broad = true
      else paths.push(...call.args.filter(a => !a.startsWith('-')))
    }
    if (i === commitAt) {
      for (let k = 0; k < call.args.length; k += 1) {
        const a = call.args[k]!
        if (VALUED.has(a)) k += 1
        else if (!a.startsWith('-')) paths.push(a)
      }
    }
  })
  const commit = calls[commitAt]
  return { paths, broad, all: commit !== undefined && isBroadAdd(commit) }
}

/** `prefix` + `path`, with `.` and `..` folded: a repo-root path. */
export function fromRoot(prefix: string, path: string): string {
  const parts: string[] = []
  for (const part of `${prefix}${path}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

// ---- Attribution --------------------------------------------------------------

/**
 * The command with Claude's Co-Authored-By trailer and "Generated with Claude
 * Code" line taken out of a commit or PR message. Quotes are left in place.
 */
export function stripAttribution(command: string): string {
  if (!/\bgit\b[\s\S]*\bcommit\b|\bgh\s+pr\s+(create|edit)\b/.test(command)) return command
  const out = command
    .replace(/[ \t]+-m[ \t]*(["'])\s*Co-Authored-By:[^"'\n]*(claude|anthropic)[^"'\n]*\1/gi, '')
    .replace(/[ \t]+-m[ \t]*(["'])\s*(🤖\s*)?Generated with \[?Claude Code[^"'\n]*\1/gi, '')
    .replace(/^[ \t]*Co-Authored-By:[^\n"']*(claude|anthropic)[^\n"']*/gim, '')
    .replace(/^[ \t]*(🤖[ \t]*)?Generated with \[?Claude Code[^\n"']*/gim, '')
  return out === command ? command : out.replace(/\n{3,}/g, '\n\n')
}
