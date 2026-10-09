// Reads destructive SQL closely enough to say what it touches: the verb, the
// table, the WHERE clause and how wide it is. 'String' literals and comments
// are masked first so a keyword inside them is not read as SQL.

export type Scope = 'none' | 'range' | 'equality' | 'schema'

export type SqlStatement = {
  verb: 'DELETE' | 'UPDATE' | 'DROP' | 'TRUNCATE' | 'ALTER'
  text: string
  table?: string
  where?: string
  scope: Scope
  /** A read-only `SELECT COUNT(*) AS n ...` over the same rows, when it can be derived. */
  count?: string
  note?: string
}

export const DESTRUCTIVE = /\b(DELETE\s+FROM|UPDATE\s+\S+\s+SET|DROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX|COLUMN)|TRUNCATE|ALTER\s+TABLE)\b/i

/** Same length as `sql`, with quoted text and comments blanked. */
function mask(sql: string): string {
  let out = ''
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]!
    if (c === "'") {
      let j = i + 1
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c || sql[j] === '\\' ? 2 : 1
      out += c + ' '.repeat(Math.max(0, Math.min(j, sql.length) - i - 1)) + (j < sql.length ? c : '')
      i = j
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i)
      const end = j < 0 ? sql.length : j
      out += ' '.repeat(end - i)
      i = end - 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2)
      const end = j < 0 ? sql.length : j + 2
      out += ' '.repeat(end - i)
      i = end - 1
    } else {
      out += c
    }
  }
  return out
}

/** Index of the first match of `re` outside parentheses, or -1. */
function topLevel(masked: string, re: RegExp, from = 0): number {
  const global = new RegExp(re.source, 'gi')
  global.lastIndex = from
  for (let m = global.exec(masked); m !== null; m = global.exec(masked)) {
    let depth = 0
    for (let k = 0; k < m.index; k += 1) {
      if (masked[k] === '(') depth += 1
      else if (masked[k] === ')') depth -= 1
    }
    if (depth === 0) return m.index
  }
  return -1
}

export function statements(sql: string): string[] {
  const masked = mask(sql)
  const out: string[] = []
  let start = 0
  for (let i = 0; i <= masked.length; i += 1) {
    if (i === masked.length || masked[i] === ';') {
      const one = sql.slice(start, i).trim()
      if (one !== '') out.push(one)
      start = i + 1
    }
  }
  return out
}

const RANGE = /(<|>|\bBETWEEN\b|\bLIKE\b|\bNOT\b|\bIS\s+(NOT\s+)?NULL\b|\bIN\s*\(\s*SELECT\b|\bOR\b)/i
const ALL_ROWS = /^\s*(1\s*=\s*1|true|1)\s*$/i
const NAME = '([\\w.$]+|`[^`]+`|"[^"]+")'

function rowsOf(verb: 'DELETE' | 'UPDATE', stmt: string, masked: string): SqlStatement {
  const head = verb === 'DELETE'
    ? new RegExp(`^\\s*DELETE\\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\\s+)*FROM\\s+(?:ONLY\\s+)?${NAME}(?:\\s+(?:AS\\s+)?(?!WHERE\\b|ORDER\\b|LIMIT\\b|RETURNING\\b|USING\\b)(\\w+))?\\s*(?=WHERE\\b|ORDER\\b|LIMIT\\b|RETURNING\\b|$)`, 'i')
    : new RegExp(`^\\s*UPDATE\\s+(?:(?:LOW_PRIORITY|IGNORE|ONLY)\\s+)*${NAME}(?:\\s+(?:AS\\s+)?(?!SET\\b)(\\w+))?\\s+SET\\b`, 'i')
  const m = head.exec(masked)
  const table = m?.[1]
  const alias = m?.[2]
  const whereAt = topLevel(masked, /\bWHERE\b/)
  const endAt = whereAt < 0 ? -1 : topLevel(masked, /\b(ORDER\s+BY|LIMIT|RETURNING)\b/, whereAt)
  const cut = (s: string) => s.slice(whereAt + 5, endAt < 0 ? undefined : endAt).trim()
  const where = whereAt < 0 ? undefined : cut(stmt)
  const scope: Scope = where === undefined || ALL_ROWS.test(where) ? 'none' : RANGE.test(cut(masked)) ? 'range' : 'equality'
  const limited = topLevel(masked, /\bLIMIT\b/) >= 0
  const count = table
    ? `SELECT COUNT(*) AS n FROM ${table}${alias ? ` ${alias}` : ''}${where ? ` WHERE ${where}` : ''}`
    : undefined
  return { verb, text: stmt, table, where, scope, count, note: limited ? 'LIMIT caps how many rows it touches.' : undefined }
}

/** The destructive statements in `sql`; reads and inserts are left out. */
export function analyze(sql: string): SqlStatement[] {
  const out: SqlStatement[] = []
  for (const stmt of statements(sql)) {
    const masked = mask(stmt)
    const verb = /^\s*(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/i.exec(masked)?.[1]?.toUpperCase()
    if (verb === 'DELETE' || verb === 'UPDATE') {
      out.push(rowsOf(verb, stmt, masked))
    } else if (verb === 'TRUNCATE') {
      const table = new RegExp(`^\\s*TRUNCATE\\s+(TABLE\\s+)?(ONLY\\s+)?${NAME}\\s*$`, 'i').exec(masked)?.[3]
      out.push({ verb, text: stmt, table, scope: 'none', count: table ? `SELECT COUNT(*) AS n FROM ${table}` : undefined, note: 'Removes every row.' })
    } else if (verb === 'DROP') {
      const m = new RegExp(`^\\s*DROP\\s+(TEMPORARY\\s+)?(\\w+)\\s+(IF\\s+EXISTS\\s+)?${NAME}\\s*(CASCADE)?\\s*$`, 'i').exec(masked)
      const kind = m?.[2]?.toUpperCase()
      const table = kind === 'TABLE' ? m?.[4] : undefined
      out.push({ verb, text: stmt, table, scope: 'schema', count: table ? `SELECT COUNT(*) AS n FROM ${table}` : undefined, note: `Drops ${kind?.toLowerCase() ?? 'an object'}${m?.[4] ? ` ${m[4]}` : ''}${m?.[5] ? ' and everything that depends on it' : ''}.` })
    } else if (verb === 'ALTER') {
      const drops = /\bDROP\s+(COLUMN|INDEX|CONSTRAINT|PRIMARY|FOREIGN)\b/i.test(masked)
      out.push({ verb, text: stmt, scope: 'schema', note: drops ? 'Drops part of the schema.' : 'Changes the schema; a big table may lock while it runs.' })
    }
  }
  return out
}

/** One line on how wide the statement is. */
export function scopeLine(s: SqlStatement): string {
  if (s.scope === 'none') return `${s.verb} with no WHERE: every row${s.table ? ` of ${s.table}` : ''}.`
  if (s.scope === 'range') return `${s.verb} with a range WHERE (${(s.where ?? '').slice(0, 80)}): may match many rows.`
  if (s.scope === 'equality') return `${s.verb} WHERE ${(s.where ?? '').slice(0, 80)}.`
  return s.note ?? s.verb
}
