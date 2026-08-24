/**
 * Lightweight structural reader for SQL statements.
 *
 * Not a parser — it does not build a tree, resolve names, or understand
 * dialect quirks. It extracts the handful of clauses whose difference is
 * *mechanically* decidable as an output change: the projection, DISTINCT,
 * GROUP BY, set operations, ORDER BY, and row limits.
 *
 * Everything it cannot decide it reports as undecided rather than guessing.
 * That distinction is the whole point: a claim we can check, we check; a claim
 * we cannot, we label.
 */

export interface SqlShape {
  kind: 'select' | 'insert' | 'update' | 'delete' | 'ddl-index' | 'other'
  distinct: boolean
  /** Normalised output expressions, in order. `['*']` for a star projection. */
  projection: string[]
  from: string
  where: string
  groupBy: string[]
  having: string
  orderBy: string[]
  limit: string
  offset: string
  /** UNION / INTERSECT / EXCEPT present at top level. */
  setOps: string[]
  joins: number
}

const CLAUSES = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'WINDOW', 'QUALIFY',
  'ORDER BY', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT',
] as const

/** Strip comments and string/identifier literals so clause scanning is safe. */
export function stripLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)

    if (two === '--') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      out += ' '
      continue
    }

    const ch = sql[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      // Keep a placeholder so a literal still occupies a token position.
      const quote = ch
      i++
      let body = ''
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { body += quote; i += 2; continue } // escaped
          i++
          break
        }
        if (sql[i] === '\\') { body += sql[i]! + (sql[i + 1] ?? ''); i += 2; continue }
        body += sql[i]!
        i++
      }
      // Quoted identifiers matter to the projection; string values do not.
      out += quote === "'" ? `'§'` : `"${body}"`
      continue
    }

    out += ch
    i++
  }
  return out
}

export function normaliseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Split on a separator that appears at paren depth 0. */
export function splitTopLevel(input: string, separator: RegExp): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '(') depth++
    else if (ch === ')') depth--

    if (depth === 0) {
      const rest = input.slice(i)
      const m = separator.exec(rest)
      if (m && m.index === 0) {
        parts.push(current)
        current = ''
        i += m[0].length - 1
        continue
      }
    }
    current += ch
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Locate top-level clause keywords, in the order they appear. */
function clausePositions(sql: string): { name: string; start: number; end: number }[] {
  const found: { name: string; start: number; end: number }[] = []
  let depth = 0

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (depth !== 0) continue
    // Only match on a word boundary.
    if (i > 0 && /[\w$]/.test(sql[i - 1]!)) continue

    for (const clause of CLAUSES) {
      const slice = sql.slice(i, i + clause.length)
      if (slice.toUpperCase() !== clause) continue
      const after = sql[i + clause.length]
      if (after !== undefined && /[\w$]/.test(after)) continue
      found.push({ name: clause, start: i, end: i + clause.length })
      i += clause.length - 1
      break
    }
  }
  return found
}

export function readSqlShape(rawInput: string): SqlShape | null {
  const raw = normaliseWhitespace(stripLiterals(rawInput))
  if (!raw) return null

  const upper = raw.toUpperCase()

  // Index DDL is handled specially: it never changes a result set.
  if (/^\s*(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\b/i.test(raw) ||
      /^\s*ALTER\s+TABLE\s+\S+\s+(?:ADD|DROP)\s+(?:CONSTRAINT|INDEX|KEY)\b/i.test(raw)) {
    return emptyShape('ddl-index')
  }

  let kind: SqlShape['kind'] = 'other'
  if (/^\s*(?:WITH\b[\s\S]*?\)\s*)?SELECT\b/i.test(raw)) kind = 'select'
  else if (upper.startsWith('INSERT')) kind = 'insert'
  else if (upper.startsWith('UPDATE')) kind = 'update'
  else if (upper.startsWith('DELETE')) kind = 'delete'
  else return emptyShape('other')

  if (kind !== 'select') {
    const shape = emptyShape(kind)
    const wherePos = clausePositions(raw).find((p) => p.name === 'WHERE')
    if (wherePos) shape.where = normaliseWhitespace(raw.slice(wherePos.end))
    return shape
  }

  const positions = clausePositions(raw)
  const selectAt = positions.find((p) => p.name === 'SELECT')
  if (!selectAt) return emptyShape('other')

  const shape = emptyShape('select')

  const section = (name: string): string => {
    const idx = positions.findIndex((p) => p.name === name)
    if (idx === -1) return ''
    const start = positions[idx]!.end
    const next = positions[idx + 1]?.start ?? raw.length
    return raw.slice(start, next).trim()
  }

  let projection = section('SELECT')
  if (/^(?:ALL|DISTINCT)\b/i.test(projection)) {
    shape.distinct = /^DISTINCT\b/i.test(projection)
    projection = projection.replace(/^(?:ALL|DISTINCT)\b/i, '').trim()
  }
  // T-SQL row limiting lives inside the projection.
  const top = /^TOP\s*\(?\s*(\d+)\s*\)?/i.exec(projection)
  if (top) {
    shape.limit = top[1]!
    projection = projection.slice(top[0].length).trim()
  }

  shape.projection = projection === '*'
    ? ['*']
    : splitTopLevel(projection, /^,/).map(normaliseProjectionItem)

  shape.from = normaliseWhitespace(section('FROM'))
  shape.where = normaliseWhitespace(section('WHERE'))
  shape.having = normaliseWhitespace(section('HAVING'))
  shape.groupBy = splitTopLevel(section('GROUP BY'), /^,/).map((s) => s.toLowerCase())
  shape.orderBy = splitTopLevel(section('ORDER BY'), /^,/).map(normaliseOrderItem)
  shape.limit = shape.limit || normaliseWhitespace(section('LIMIT'))
  shape.offset = normaliseWhitespace(section('OFFSET'))

  const fetch = section('FETCH')
  if (fetch) shape.limit = shape.limit || normaliseWhitespace(fetch)

  shape.setOps = positions
    .filter((p) => p.name === 'UNION' || p.name === 'INTERSECT' || p.name === 'EXCEPT')
    .map((p) => p.name)

  shape.joins = (shape.from.match(/\bJOIN\b/gi) ?? []).length

  return shape
}

/** Lower-case and collapse, but keep an explicit alias — it names the column. */
function normaliseProjectionItem(item: string): string {
  return normaliseWhitespace(item)
    .replace(/\s+AS\s+/i, ' as ')
    .toLowerCase()
}

function normaliseOrderItem(item: string): string {
  const s = normaliseWhitespace(item).toLowerCase()
  // ASC is the default; make it explicit so `x` and `x asc` compare equal.
  if (/\b(?:asc|desc)$/.test(s)) return s
  return `${s} asc`
}

function emptyShape(kind: SqlShape['kind']): SqlShape {
  return {
    kind, distinct: false, projection: [], from: '', where: '',
    groupBy: [], having: '', orderBy: [], limit: '', offset: '',
    setOps: [], joins: 0,
  }
}
