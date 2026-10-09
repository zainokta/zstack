// A shell command line read well enough to find the commands in it: quotes,
// escapes, separators (&& || ; | & newline), ( ) subshells and `cd`. Heredoc
// bodies are cut out first; $( ... ) stays inside its word. Not a full shell.

export type Command = {
  /** The words, unquoted, with redirects, VAR=value, sudo and the like removed. */
  words: string[]
  /** Where a `cd`/`pushd` earlier on the line moved to; null = the session folder. */
  dir: string | null
}

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g

/** The command with heredoc bodies removed, and the bodies. */
export function stripHeredocs(input: string): { text: string; bodies: string[] } {
  const bodies: string[] = []
  const text = input.replace(HEREDOC, (_m, q: string, tag: string, rest: string, body: string) => {
    bodies.push(body)
    return `<<${q}${tag}${q}${rest}`
  })
  return { text, bodies }
}

type Raw = { words: string[]; depth: number }

function split(input: string): Raw[] {
  const out: Raw[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let depth = 0
  let segDepth = 0
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSeg = () => {
    endWord()
    if (words.length > 0) out.push({ words, depth: segDepth })
    words = []
    segDepth = depth
  }
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]!
    if (c === '\\') {
      if (i + 1 < input.length && input[i + 1] !== '\n') {
        word += input[i + 1]
        inWord = true
      }
      i += 1
    } else if (c === "'") {
      const j = input.indexOf("'", i + 1)
      const end = j < 0 ? input.length : j
      word += input.slice(i + 1, end)
      inWord = true
      i = end
    } else if (c === '"') {
      let j = i + 1
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length && '"\\$`'.includes(input[j + 1]!)) {
          word += input[j + 1]
          j += 2
        } else {
          word += input[j]
          j += 1
        }
      }
      inWord = true
      i = j
    } else if (c === '$' && input[i + 1] === '(') {
      let j = i + 2
      let d = 1
      while (j < input.length && d > 0) {
        if (input[j] === '(') d += 1
        else if (input[j] === ')') d -= 1
        j += 1
      }
      word += input.slice(i, j)
      inWord = true
      i = j - 1
    } else if (c === '#' && !inWord) {
      while (i + 1 < input.length && input[i + 1] !== '\n') i += 1
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '\n' || c === ';') {
      endSeg()
    } else if (c === '&' && (input[i - 1] === '>' || input[i + 1] === '>')) {
      word += c
      inWord = true
    } else if (c === '&' || c === '|') {
      if (input[i + 1] === c) i += 1
      endSeg()
    } else if (c === '(' && !inWord) {
      endSeg()
      depth += 1
      segDepth = depth
    } else if (c === ')') {
      endSeg()
      depth = Math.max(0, depth - 1)
      segDepth = depth
    } else {
      word += c
      inWord = true
    }
  }
  endSeg()
  return out
}

const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!', 'builtin'])
const SUDO_VALUE = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
const REDIRECT = /^(\d*|&)(>>?|<<?-?|<)/

function normalize(input: readonly string[]): string[] {
  const words: string[] = []
  for (let i = 0; i < input.length; i += 1) {
    const w = input[i]!
    const m = REDIRECT.exec(w)
    if (m) {
      if (m[0] === w) i += 1 // `> file`: drop the target too
      continue
    }
    words.push(w)
  }
  for (;;) {
    const first = words[0]
    if (first === undefined) break
    if (/^[A-Za-z_]\w*=/.test(first) || PREFIXES.has(first)) {
      words.shift()
    } else if (first === 'sudo' || first === 'doas') {
      words.shift()
      while (words[0]?.startsWith('-')) {
        const opt = words.shift()!
        if (SUDO_VALUE.has(opt)) words.shift()
      }
    } else if (first === 'nice') {
      words.shift()
      if (words[0] === '-n') words.splice(0, 2)
      else if (/^-\d+$/.test(words[0] ?? '')) words.shift()
    } else {
      break
    }
  }
  return words
}

export function joinDir(dir: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) return arg ?? '~'
  return dir === null ? arg : `${dir}/${arg}`
}

/** Every simple command on the line, in order, each with the folder it runs in. */
export function commands(line: string): Command[] {
  const raws = split(stripHeredocs(line).text)
  const out: Command[] = []
  let dir: string | null = null
  let depth = 0
  const scopes: (string | null)[] = []
  const pushed: (string | null)[] = []
  for (const raw of raws) {
    while (depth < raw.depth) {
      scopes.push(dir)
      depth += 1
    }
    while (depth > raw.depth) {
      dir = scopes.pop() ?? null
      depth -= 1
    }
    const words = normalize(raw.words)
    const [cmd, arg] = words
    if (cmd === 'cd') {
      dir = arg === '-' ? '-' : joinDir(dir, arg)
    } else if (cmd === 'pushd') {
      pushed.push(dir)
      dir = joinDir(dir, arg)
    } else if (cmd === 'popd') {
      dir = pushed.length > 0 ? (pushed.pop() ?? null) : '-'
    }
    if (words.length > 0) out.push({ words, dir })
  }
  return out
}

/** The program's bare name: `/usr/bin/git` and `\git` are `git`. */
export function program(word: string | undefined): string {
  return (word ?? '').replace(/^\\/, '').replace(/^.*\//, '')
}
