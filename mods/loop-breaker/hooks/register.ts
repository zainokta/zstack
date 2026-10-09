import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LoopFailure, LoopPaste } from '../types'

const failures = atom({ plugin: 'loop-breaker', key: 'failures' } as const, {} as Record<string, LoopFailure>)
const paste = atom({ plugin: 'loop-breaker', key: 'paste' } as const, null as LoopPaste | null)

// Lines that say nothing about which failure this is.
const NOISE = /^(exit code \d+|traceback \(most recent call last\)|at\s|\^+$|-+$|npm err! (a complete log|this is probably))/i
const ERROR_WORD =
  /\b(error|exception|fatal|panic|failed|failure|cannot|can't|unable|denied|not found|no such|undefined|refused|timed? ?out|invalid|unexpected|missing)\b/i
const ERROR_TYPE = /\b[A-Z]\w*(Error|Exception)\b/

// A run the user stopped or refused is not a failure of the fix.
const NOT_A_FAILURE = /interrupted|doesn't want to proceed|was rejected/i

// "still same ahh", "oof, same", "same error again", "still failing".
const STILL_SAME =
  /\b(still|again)\b[^.\n]{0,30}\b(same|fail\w*|error|broken|not work\w*)\b|\bsame\b[^.\n]{0,15}\b(ahh|error|issue|again|thing|problem|result|output)\b|^\W*(\w+\W+)?same\W*$/i

const WRAPPERS = new Set(['sudo', 'time', 'env', 'nohup', 'command', 'exec'])
const SETUP = /^(cd|pushd|popd|export|source|set|\.)$/

export function normalize(line: string): string {
  return line
    .replace(/[\w.~-]*\/[\w./-]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hash>')
    .replace(/[\w+/=-]{24,}/g, '<token>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160)
}

const isErrorLine = (line: string) => ERROR_WORD.test(line) || ERROR_TYPE.test(line)

// The command's program and, when it is a plain word, its subcommand: `pnpm test`, `python pytest`.
export function commandHead(command: string): string {
  for (const segment of command.split(/\n|&&|\|\||[;|]/)) {
    const words = segment.trim().split(/\s+/).filter(w => w !== '' && !/^\w+=/.test(w))
    while (words.length > 0 && WRAPPERS.has(words[0] ?? '')) {
      words.shift()
    }
    const program = words[0]
    if (program === undefined || SETUP.test(program)) {
      continue
    }
    const sub = words.slice(1).find(w => !w.startsWith('-'))
    const name = program.split('/').pop() ?? program
    return sub !== undefined && /^[a-z][\w:.-]*$/.test(sub) ? `${name} ${sub}` : name
  }
  return command.trim().slice(0, 40)
}

// The first line that names the failure, normalized so a rerun matches it.
export function errorLine(output: string): string {
  const lines = output.split('\n').map(l => l.trim()).filter(l => l !== '' && !NOISE.test(l))
  return normalize(lines.find(isErrorLine) ?? lines[0] ?? '')
}

export function errorLines(text: string): string[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '' && !NOISE.test(l) && isErrorLine(l))
  return [...new Set(lines.map(normalize))].slice(0, 20)
}

// Two pastes are the same error when at least half of the shorter one's error lines recur.
const isSameError = (a: readonly string[], b: readonly string[]) =>
  a.length > 0 && b.length > 0 && a.filter(l => b.includes(l)).length * 2 >= Math.min(a.length, b.length)

const DIAGNOSE =
  'Stop patching. Run the diagnosis loop before changing more code:\n' +
  '1. Reproduce it with one command and confirm it fails the same way.\n' +
  '2. List 2-4 hypotheses for the cause, each with a check that tells it apart from the others.\n' +
  '3. Run those checks and name the root cause with its evidence (output, code lines).\n' +
  '4. Only then make one fix, and rerun the reproduction to confirm it.'

async function showStatus($: EngineInterface) {
  const worst = Object.values(await read($, failures)).reduce((n, f) => Math.max(n, f.count), 0)
  const pasted = (await read($, paste))?.count ?? 0
  const count = Math.max(worst, pasted)
  $.ui.status(count >= 3 ? `loop: same failure ${count}x — diagnose, don't patch` : undefined)
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) {
      return ran
    }
    const head = commandHead(e.command)

    if (!ran.isError) {
      const known = await read($, failures)
      if (Object.values(known).some(f => f.head === head)) {
        await update($, failures, all => Object.fromEntries(Object.entries(all).filter(([, f]) => f.head !== head)))
        await showStatus($)
      }
      return ran
    }

    const output = ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
    if (NOT_A_FAILURE.test(output)) {
      return ran
    }
    const error = errorLine(output)
    const signature = `${head} :: ${error}`
    const all = await update($, failures, was => ({
      ...was,
      [signature]: { head, error, count: (was[signature]?.count ?? 0) + 1 },
    }))
    const count = all[signature]?.count ?? 0

    if (count >= 2) {
      $.ui.toast(`loop-breaker: \`${head}\` failed the same way ${count} times; asked Claude to diagnose`)
      const text = `loop-breaker: this Bash failure has now happened ${count} times with the same signature (${signature}). ${DIAGNOSE}`
      await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text }] },
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      })
      await showStatus($)
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    const lines = errorLines(e.text)
    const last = await read($, paste)
    const isRepeat = last !== null && (lines.length > 0 ? isSameError(lines, last.lines) : STILL_SAME.test(e.text.trim()))

    if (!isRepeat) {
      if (lines.length > 0) {
        await update($, paste, () => ({ lines, count: 1 }))
        await showStatus($)
      }
      return next(e)
    }

    const now = await update($, paste, was => ({ lines: lines.length > 0 ? lines : (was?.lines ?? []), count: (was?.count ?? 0) + 1 }))
    const count = now?.count ?? 0
    $.ui.toast(`loop-breaker: the same error is back (${count} times); asked Claude to diagnose`)
    await showStatus($)
    const note = `loop-breaker: the user has now reported the same error ${count} times, so the previous fixes did not work. ${DIAGNOSE}`
    return next({ ...e, context: [...(e.context ?? []), note] })
  })
}
