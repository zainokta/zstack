import { commands, program, stripHeredocs } from './shell'
import { DESTRUCTIVE, analyze } from './sql'
import type { SqlStatement } from './sql'

export type Kind = 'terraform' | 'pulumi' | 'gcloud' | 'aws' | 'kubectl' | 'docker' | 'rm' | 'sql' | 'sql-file'

export type Risk = {
  kind: Kind
  label: string
  /** The risky command's words (after sudo, env and the like). */
  words: string[]
  /** Where it runs: a `cd` earlier on the line; null = the session folder. */
  dir: string | null
  sql: SqlStatement[]
  /** For `sql-file`: the file the client reads. */
  file?: string
  warnings: string[]
}

/** Folders a build makes and `rm -rf` may clear without asking. */
const BUILD_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', 'coverage',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.parcel-cache', '.svelte-kit', '.output', 'tmp', '.tmp',
])

/** The words that aren't flags, skipping the values of the flags named in `valued`. */
function positional(args: readonly string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!
    if (valued.has(a)) i += 1
    else if (!a.startsWith('-')) out.push(a)
  }
  return out
}

const AWS_VALUED = new Set(['--profile', '--region', '--output', '--endpoint-url', '--query', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout'])
const KUBECTL_VALUED = new Set(['--context', '-n', '--namespace', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--as', '-l', '--selector', '-f', '--filename', '-k', '--kustomize', '-o', '--output'])
const GCLOUD_VALUED = new Set(['--project', '--account', '--region', '--zone', '--format', '--configuration', '--impersonate-service-account'])

/** True when every target is under /tmp or inside a build folder of the repo. */
export function isSafeRm(targets: readonly string[], dir: string | null, root: string): boolean {
  if (targets.length === 0) return true
  return targets.every(t => {
    if (/[$`~]/.test(t) || t.split('/').includes('..')) return false
    if (t.startsWith('/tmp/') && t.length > 5) return true
    let rel: string
    if (t.startsWith('/')) {
      if (root === '' || root === '/') return false
      if (!t.startsWith(`${root.replace(/\/$/, '')}/`)) return false
      rel = t.slice(root.replace(/\/$/, '').length + 1)
    } else {
      if (dir !== null && (dir.startsWith('/') || dir.startsWith('~') || dir === '-' || dir.split('/').includes('..'))) return false
      rel = t
    }
    const parts = rel.split('/').filter(p => p !== '' && p !== '.')
    const at = parts.findIndex(p => BUILD_DIRS.has(p))
    // Globs only below the build folder: `dist/*` yes, `*/dist` no.
    return at >= 0 && parts.slice(0, at + 1).every(p => !/[*?[]/.test(p))
  })
}

function sqlClient(words: readonly string[]): { sources: string[]; file?: string } {
  const sources: string[] = []
  let file: string | undefined
  for (let i = 1; i < words.length; i += 1) {
    const a = words[i]!
    if (a === '-e' || a === '--execute' || a === '-c' || a === '--command') sources.push(words[(i += 1)] ?? '')
    else if (/^--(execute|command)=/.test(a)) sources.push(a.replace(/^--\w+=/, ''))
    else if (/^-[ec].+/.test(a)) sources.push(a.slice(2))
    else if (a === '-f' || a === '--file') file = words[(i += 1)]
    else if (a.startsWith('--file=')) file = a.slice(7)
  }
  return { sources, file }
}

/** The first risky command on a Bash line, or null. `root` is the session's project root. */
export function classifyBash(line: string, root: string): Risk | null {
  const { bodies } = stripHeredocs(line)
  const cmds = commands(line)
  const risk = (kind: Kind, label: string, words: string[], dir: string | null, extra: Partial<Risk> = {}): Risk =>
    ({ kind, label, words, dir, sql: [], warnings: [], ...extra })

  for (const { words, dir } of cmds) {
    const cmd = program(words[0])
    const args = words.slice(1)
    const pos = (valued: ReadonlySet<string> = new Set()) => positional(args, valued)

    if (cmd === 'terraform' || cmd === 'tofu') {
      const sub = pos()[0]
      if (sub === 'apply' || sub === 'destroy') return risk('terraform', `${cmd} ${sub}`, words, dir)
    } else if (cmd === 'pulumi') {
      const sub = pos(new Set(['-s', '--stack', '-C', '--cwd']))[0]
      if (sub === 'up' || sub === 'update' || sub === 'destroy') return risk('pulumi', `pulumi ${sub}`, words, dir)
    } else if (cmd === 'gcloud') {
      const p = pos(GCLOUD_VALUED)
      const verb = p.find(w => w === 'deploy' || w === 'delete') ?? (p[0] === 'sql' && p.includes('patch') ? 'patch' : undefined)
      if (verb) return risk('gcloud', `gcloud ${p.slice(0, p.indexOf(verb) + 1).join(' ')}`, words, dir)
    } else if (cmd === 'aws') {
      const [service, op] = pos(AWS_VALUED)
      const isS3 = service === 's3' && (op === 'rb' || (op === 'rm' && args.includes('--recursive')))
      if (isS3 || (op !== undefined && /^(delete|terminate)/.test(op))) return risk('aws', `aws ${service} ${op}`, words, dir)
    } else if (cmd === 'kubectl') {
      const sub = pos(KUBECTL_VALUED)[0]
      if (sub === 'delete' || sub === 'apply') return risk('kubectl', `kubectl ${sub}`, words, dir)
    } else if (cmd === 'docker') {
      if (args[0] === 'system' && args[1] === 'prune') return risk('docker', 'docker system prune', words, dir)
    } else if (cmd === 'rm') {
      const flags = args.filter(a => /^-/.test(a) && a !== '-' && a !== '--')
      const recursive = flags.some(f => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
      const force = flags.some(f => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))
      const targets = args.filter(a => !/^-/.test(a) || a === '-')
      if (recursive && force && !isSafeRm(targets, dir, root)) {
        return risk('rm', `rm ${flags.join(' ')}`, words, dir, { warnings: [`Deletes ${targets.join(' ')} for good: rm has no undo.`] })
      }
    } else if (cmd === 'mysql' || cmd === 'mariadb' || cmd === 'psql') {
      const client = sqlClient(words)
      const echoed = cmds.filter(c => ['echo', 'printf'].includes(program(c.words[0]))).flatMap(c => c.words.slice(1))
      const sql = analyze([...client.sources, ...bodies, ...echoed].join(';\n'))
      if (sql.length > 0) return risk('sql', `${cmd} ${sql.map(s => s.verb).join(', ')}`, words, dir, { sql })
      const redirect = new RegExp(`\\b${cmd}\\b[^|;&\\n]*<\\s*([^\\s|;&<>]+)`).exec(line)?.[1]
      const file = client.file ?? redirect
      if (file !== undefined) return risk('sql-file', `${cmd} < ${file}`, words, dir, { file })
      if (DESTRUCTIVE.test(line)) {
        return risk('sql', `${cmd} (SQL)`, words, dir, { warnings: ["Couldn't pick the SQL out of the command line; read the command."] })
      }
    }
  }
  return null
}

/** The SQL a DB MCP tool call carries, by tool name and argument, or null. */
export function mcpSql(tool: string, input: Record<string, unknown>): { key: string; sql: string } | null {
  if (!tool.startsWith('mcp__') || !/mysql|postgres|sql/i.test(tool)) return null
  for (const key of ['sql', 'query', 'statement', 'command']) {
    const v = input[key]
    if (typeof v === 'string') return { key, sql: v }
  }
  return null
}
