import { atom, read, update } from 'claude-code'
import type { ApiContentBlock, Register } from 'claude-code'

import type { Vault, VaultEntry } from '../types'

const vault = atom({ plugin: 'secret-vault', key: 'vault' } as const, { entries: [], issued: 0 } as Vault)

const PLACEHOLDER = /⟨secret:(\d+)⟩/g
const placeholder = (n: number) => `⟨secret:${n}⟩`

// Masking a value shorter than this would rewrite ordinary words in output.
const MIN_VALUE = 4

// `group` names the capture that is the secret; without it the whole match is.
type Rule = { kind: string; re: RegExp; group?: number }

// Order matters: a JWT is taken before the Bearer rule sees it.
const RULES: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', re: /\beyJ[\w-]{4,}\.eyJ[\w-]{4,}\.[\w-]*/g },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,})/g },
  { kind: 'aws-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'aws-secret', re: /aws_secret_access_key["']?\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})/gi, group: 1 },
  { kind: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'api-key', re: /\bsk-(?:ant-)?[\w-]{20,}/g },
  { kind: 'bearer', re: /\bBearer\s+([\w.~+/=-]{16,})/gi, group: 1 },
  { kind: 'basic-auth', re: /\bAuthorization["']?\s*:\s*["']?(?:Basic|Token)\s+([\w.~+/=-]{8,})/gi, group: 1 },
  { kind: 'url-password', re: /\b[a-z][\w+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, group: 1 },
  { kind: 'password', re: /\b(?:password|passwd|pwd)["']?\s*[=:]\s*["']?([^\s"'&;,]{4,})/gi, group: 1 },
  { kind: 'api-key', re: /\bx-api-key["']?\s*[=:]\s*["']?([\w.~+/=-]{12,})/gi, group: 1 },
  {
    kind: 'token',
    re: /\b(?:session_?id|access_token|refresh_token|auth_token|api_?key|client_secret)["']?\s*[=:]\s*["']?([\w%.~+/=-]{16,})/gi,
    group: 1,
  },
]

// A Cookie header (or curl -b / --cookie) carries several name=value pairs.
const COOKIE_LINE = /^.*(?:\bcookie\s*:|--cookie\b|\s-b\s+['"]).*$/gim
const COOKIE_VALUE = /=([^;\s'"]{16,})/g

export function mask(text: string, entries: readonly VaultEntry[]): string {
  const longestFirst = [...entries].sort((a, b) => b.value.length - a.value.length)
  return longestFirst.reduce(
    (s, e) => (e.value.length >= MIN_VALUE ? s.split(e.value).join(placeholder(e.n)) : s),
    text,
  )
}

export function reveal(text: string, entries: readonly VaultEntry[]): string {
  return text.replace(PLACEHOLDER, (whole, n: string) => entries.find(e => e.n === Number(n))?.value ?? whole)
}

// Replaces known values and newly detected secrets; `vault` gains the new ones.
export function redact(text: string, start: Vault): { text: string; vault: Vault; hits: number } {
  const entries = [...start.entries]
  let issued = start.issued
  let hits = 0

  const take = (value: string, kind: string): string => {
    hits += 1
    const known = entries.find(e => e.value === value)
    if (known) {
      return placeholder(known.n)
    }
    issued += 1
    entries.push({ n: issued, kind, value })
    return placeholder(issued)
  }

  const sub = (whole: string, value: string | undefined, kind: string): string => {
    if (!value || value.length < MIN_VALUE || value.includes('⟨')) {
      return whole
    }
    const at = whole.lastIndexOf(value)
    return whole.slice(0, at) + take(value, kind) + whole.slice(at + value.length)
  }

  let out = text
  const knownHits = entries.filter(e => e.value.length >= MIN_VALUE && out.includes(e.value)).length
  out = mask(out, entries)
  hits += knownHits

  for (const rule of RULES) {
    out = out.replace(rule.re, (...m: unknown[]) => {
      const whole = m[0] as string
      return sub(whole, (rule.group ? m[rule.group] : whole) as string | undefined, rule.kind)
    })
  }
  out = out.replace(COOKIE_LINE, line => line.replace(COOKIE_VALUE, (whole, v: string) => sub(whole, v, 'cookie')))

  return { text: out, vault: { entries, issued }, hits }
}

function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') {
    return f(value)
  }
  if (Array.isArray(value)) {
    return value.map(v => mapStrings(v, f))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)]))
  }
  return value
}

function someString(value: unknown, test: (s: string) => boolean): boolean {
  if (typeof value === 'string') {
    return test(value)
  }
  if (Array.isArray(value)) {
    return value.some(v => someString(v, test))
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(v => someString(v, test))
  }
  return false
}

const holdsSecret = (value: unknown, entries: readonly VaultEntry[]) =>
  someString(value, s => entries.some(e => e.value.length >= MIN_VALUE && s.includes(e.value)))

// The engine pins these keys; the rest are the tool's own arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

// Inputs left literal: a file or another agent's transcript would keep the real value.
const LITERAL_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'SendMessage'])

function maskBlock(block: ApiContentBlock, entries: readonly VaultEntry[]): ApiContentBlock {
  const m = (s: string) => mask(s, entries)
  if (block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: m(block.text) }
  }
  if (block.type === 'tool_result') {
    return { ...block, content: mapStrings(block.content, m) }
  }
  return block
}

const NOTE =
  'secret-vault: secrets in this prompt were replaced with ⟨secret:N⟩ placeholders. Use a placeholder verbatim ' +
  'where its value is needed in a Bash command, WebFetch or MCP tool input; the real value is put in just before ' +
  'the tool runs and masked again in its output. Do not ask the user to paste the value again.'

const SECTION =
  '# Secret placeholders\n' +
  'A value written ⟨secret:N⟩ stands for a real secret the user gave in this session (a token, password or key). ' +
  'Use the placeholder verbatim where the value is needed in Bash commands, WebFetch and MCP tool inputs: the real ' +
  'value is put in just before the tool runs and masked back to the placeholder in the output. Inputs of Write, ' +
  'Edit, MultiEdit, NotebookEdit, Agent and SendMessage are not substituted, so a placeholder written there stays ' +
  'literal; to put a secret into a file, write it with a Bash command. Do not try to print or decode a placeholder.'

const statusOf = (n: number) => (n > 0 ? `vault: ${n} secret${n === 1 ? '' : 's'}` : undefined)

const hint = (value: string) => (value.length >= 12 ? `${value.slice(0, 4)}… (${value.length} chars)` : `… (${value.length} chars)`)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vault',
      description: 'List or clear the secrets replaced with ⟨secret:N⟩ placeholders this session',
      argumentHint: '[list|clear]',
    })
    $.ui.status(statusOf((await read($, vault)).entries.length))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const scan = redact(e.text, await read($, vault))
    if (scan.hits === 0) {
      return next(e)
    }
    const saved = await update($, vault, v => redact(e.text, v).vault)
    $.ui.status(statusOf(saved.entries.length))
    return next({ ...e, text: redact(e.text, saved).text, context: [...(e.context ?? []), NOTE] })
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await read($, vault)).entries.length === 0) {
      return composed
    }
    return { sections: [...composed.sections, { id: 'secret-vault:placeholders', text: SECTION, scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    const { entries } = await read($, vault)
    if (entries.length === 0) {
      return next(e)
    }

    const literal = LITERAL_TOOLS.has(String(e.tool))
    const input = literal
      ? e
      : (Object.fromEntries(
          Object.entries(e).map(([k, v]) => [k, RESERVED.has(k) ? v : mapStrings(v, s => reveal(s, entries))]),
        ) as typeof e)
    const ran = await next(input)

    if (ran.deny !== undefined) {
      return { deny: mask(ran.deny, entries) }
    }
    if (!holdsSecret([ran.result, ran.text, ran.context], entries)) {
      return ran
    }

    // Answering without `ref` makes core record and map our masked copy instead of its own.
    const m = (s: string) => mask(s, entries)
    const context = ran.context?.map(m)
    if (ran.isError) {
      return { isError: true, result: mapStrings(ran.result, m), text: ran.text === undefined ? undefined : m(ran.text), context }
    }
    return { result: mapStrings(ran.result, m) as typeof ran.result, context }
  })

  // Backstop for what the model reads and the transcript stores, whatever the row.
  on('session.append', async ($, e, next) => {
    const { entries } = await read($, vault)
    if (entries.length === 0 || !holdsSecret(e.message.content, entries)) {
      return next(e)
    }
    return next({ ...e, message: { ...e.message, content: e.message.content.map(b => maskBlock(b, entries)) } })
  })

  on('command.run', { command: 'vault' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === 'clear') {
      await update($, vault, v => ({ entries: [], issued: v.issued }))
      $.ui.status(undefined)
      return { text: 'Vault cleared. Placeholders already in the conversation no longer resolve.' }
    }
    if (arg !== '' && arg !== 'list') {
      return { text: 'Usage: /vault [list|clear]' }
    }

    const { entries } = await read($, vault)
    if (entries.length === 0) {
      return { text: 'The vault is empty.' }
    }
    return { text: entries.map(x => `${placeholder(x.n)}  ${x.kind.padEnd(12)}  ${hint(x.value)}`).join('\n') }
  })
}
