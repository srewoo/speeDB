import type { QueryLogEvidence } from './types'

/**
 * Query counts, from the instrument that fits the stack.
 *
 * The most valuable findings this tool produces are round-trip claims — "401
 * database calls become 1" — and they are the ones a query plan cannot verify
 * at all. A plan describes one statement; the claim is about how many
 * statements run. `performance.ts` already knows this and hands over
 * `CaptureQueriesContext` for Django, `assert_queries` for ActiveRecord,
 * `log: ['query']` for Prisma. What was missing is the other half: a way to
 * hand the output back.
 *
 * Counting is the easy part. The part that matters is **normalising the shape**,
 * because that is what turns a list of 400 lines into the sentence "one query
 * shape ran 400 times" — which is the N+1, stated as a measurement rather than
 * as an inference from source.
 */

export interface QueryLogParseResult {
  log: QueryLogEvidence | null
  notes: string[]
  error?: string
}

/** Formats people actually paste, in the order they are cheapest to detect. */
const DJANGO_JSON = /^\s*\[\s*\{/           // list(CaptureQueriesContext) or connection.queries
const PRISMA_LINE = /prisma:query\s+(.+)$/gim
const RAILS_LINE = /^\s*(?:\w+\s+)?(?:Load|Exists\?|Count|Create|Update|Destroy|Pluck)\s+\(([\d.]+)ms\)\s+(.+)$/gim
const SQL_LINE = /^\s*(?:\[[^\]]*\]\s*)?((?:SELECT|INSERT|UPDATE|DELETE|WITH)\b.+)$/gim

export function parseQueryLog(raw: string): QueryLogParseResult {
  const text = raw.trim()
  if (!text) return { log: null, notes: [], error: 'Nothing was pasted.' }

  const statements: string[] = []
  const notes: string[] = []
  let totalMs: number | undefined

  if (DJANGO_JSON.test(text)) {
    try {
      const rows = JSON.parse(text) as { sql?: string; time?: string | number }[]
      let ms = 0
      for (const row of rows) {
        if (typeof row?.sql === 'string') statements.push(row.sql)
        const t = Number(row?.time)
        if (Number.isFinite(t)) ms += t * 1000   // Django reports seconds
      }
      if (ms > 0) totalMs = Math.round(ms * 10) / 10
    } catch {
      return {
        log: null,
        notes,
        error: 'That looked like JSON but could not be parsed. Paste `list(ctx.captured_queries)` or `connection.queries`.',
      }
    }
  }

  if (statements.length === 0) {
    for (const m of text.matchAll(PRISMA_LINE)) statements.push(m[1]!.trim())
  }
  if (statements.length === 0) {
    let ms = 0
    for (const m of text.matchAll(RAILS_LINE)) {
      statements.push(m[2]!.trim())
      ms += Number(m[1])
    }
    if (ms > 0) totalMs = Math.round(ms * 10) / 10
  }
  if (statements.length === 0) {
    for (const m of text.matchAll(SQL_LINE)) statements.push(m[1]!.trim())
  }

  if (statements.length === 0) {
    return {
      log: null,
      notes,
      error:
        'No SQL statements were found. Supported: Django `list(ctx.captured_queries)`, ' +
        "Prisma `log: ['query']` output, Rails log lines, or one statement per line.",
    }
  }

  const shapes = new Map<string, number>()
  for (const s of statements) {
    const shape = normaliseShape(s)
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1)
  }

  const ranked = [...shapes.entries()]
    .map(([shape, count]) => ({ shape, count }))
    .sort((x, y) => y.count - x.count)

  // The whole point of normalising: a repeated shape *is* the N+1, observed
  // rather than argued from a `for` loop nine lines above the query.
  const worst = ranked[0]
  if (worst && worst.count > 10) {
    notes.push(
      `One query shape ran ${worst.count} times in this capture. That is the round trip count the ` +
      'finding is about, measured rather than inferred from the source.',
    )
  }

  return {
    log: { count: statements.length, shapes: ranked.slice(0, 20), totalMs },
    notes,
  }
}

/**
 * Collapse a statement to its shape.
 *
 * Literals out, whitespace flattened, IN-lists collapsed. Two queries that
 * differ only in a bound id are one shape; that equivalence is the measurement.
 *
 * This also removes the data. A log paste is the most sensitive thing this
 * product touches — bound parameters are production row values — and the shape
 * is what the comparison needs. Only the shape is what gets stored or shown.
 */
export function normaliseShape(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')          // string literals
    .replace(/\$\d+/g, '?')                   // pg placeholders
    .replace(/\b\d+\b/g, '?')                 // numbers
    .replace(/\bIN\s*\(\s*(?:\?\s*,\s*)*\?\s*\)/gi, 'IN (?)')  // IN-lists of any length
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
