import type { CatalogEvidence, ObservedColumnStats, ObservedIndex, ObservedTableStats } from './types'

/**
 * What is actually in the database, as opposed to what migrations say.
 *
 * `schema-facts.ts` builds a catalog from `CREATE INDEX`, Prisma `@@index`,
 * Rails `add_index` and Alembic `op.create_index`, and uses it to kill the most
 * common wrong recommendation — an index that already exists. That check is
 * good and it is built on the wrong source. **Migrations record intent.** They
 * do not record the index someone added by hand during an incident, the one a
 * DBA dropped because it was never used, or the one created concurrently
 * outside the migration tool. The report header says so and then has no way to
 * do anything about it.
 *
 * This closes that gap with the only source that is authoritative: the live
 * catalog, pasted by someone who can read it. Three shapes are accepted,
 * because those are the three people actually have to hand.
 */

export interface CatalogParseResult {
  catalog: CatalogEvidence
  notes: string[]
  error?: string
}

const EMPTY: CatalogEvidence = { indexes: [], columns: [], tables: [] }

export function parseCatalog(raw: string): CatalogParseResult {
  const text = raw.trim()
  if (!text) return { catalog: EMPTY, notes: [], error: 'Nothing was pasted.' }

  for (const parser of [parsePgIndexes, parseShowIndex, parsePgStats, parseTableStats, parseIndexUsage]) {
    const result = parser(text)
    if (result) return result
  }

  return {
    catalog: EMPTY,
    notes: [],
    error:
      'This was not recognised as an index catalog or a statistics dump. Expected the output of one of:\n' +
      "  SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '<table>';\n" +
      '  SHOW INDEX FROM `<table>`;\n' +
      "  SELECT attname, n_distinct, null_frac, avg_width FROM pg_stats WHERE tablename = '<table>';\n" +
      "  SELECT relname, seq_scan, idx_scan, n_live_tup FROM pg_stat_user_tables;\n" +
      "  SELECT relname, indexrelname, idx_scan FROM pg_stat_user_indexes;",
  }
}

/* --------------------------------------------------------- pg_indexes ---- */

/**
 * `CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id, tenant_id)`
 *
 * The column list is located but deliberately **not** captured by the regex.
 * `\(([^)]*)\)` stops at the first close paren, so `(lower(email))` came back
 * as `lower(email` — a mangled column name that would then fail every
 * comparison silently. The list is extracted by balancing parens instead, which
 * also handles a partial index's trailing `WHERE (...)`.
 */
const INDEXDEF =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(\S+)\s+ON\s+(?:[\w"]+\.)?([\w"]+)\s+USING\s+\w+\s*\(/i

function parsePgIndexes(text: string): CatalogParseResult | null {
  const matches = [...text.matchAll(new RegExp(INDEXDEF.source, 'gi'))]
  if (matches.length === 0) return null

  const indexes: ObservedIndex[] = matches.map((m) => ({
    table: unquote(m[3]!),
    name: unquote(m[2]!),
    // Expression indexes and opclasses appear here too. Splitting on top-level
    // commas is right for the ordinary case; `lower(email)` is kept verbatim
    // rather than reduced to `email`, because a half-understood expression
    // index is worse than an opaque one — the prefix check would treat it as
    // covering a bare `email` lookup, which it does not.
    columns: splitColumns(balanced(text, m.index! + m[0].length)),
    unique: Boolean(m[1]),
  }))

  const notes: string[] = []
  const expressions = indexes.filter((i) => i.columns.some((c) => c.includes('(')))
  if (expressions.length) {
    notes.push(
      `${expressions.length} expression index(es) were read verbatim rather than parsed. ` +
      'An index on `lower(email)` does not serve a lookup on `email`, so they are not treated as covering anything.',
    )
  }

  return { catalog: { ...EMPTY, indexes }, notes }
}

/* --------------------------------------------------------- SHOW INDEX ---- */

function parseShowIndex(text: string): CatalogParseResult | null {
  const rows = tabular(text)
  if (!rows) return null
  const head = rows.header.map((h) => h.toLowerCase())
  if (!head.includes('key_name') || !head.includes('column_name')) return null

  const byName = new Map<string, ObservedIndex>()
  for (const row of rows.rows) {
    const get = (k: string) => row[head.indexOf(k)] ?? ''
    const name = get('key_name')
    if (!name) continue
    const existing = byName.get(name)
    const column = get('column_name')
    if (existing) {
      // MySQL reports one row per column; Seq_in_index gives the order, and the
      // order is the whole point of a composite index prefix check.
      existing.columns.push(column)
    } else {
      byName.set(name, {
        table: get('table'),
        name,
        columns: [column],
        unique: get('non_unique') === '0',
      })
    }
  }

  if (byName.size === 0) return null
  return { catalog: { ...EMPTY, indexes: [...byName.values()] }, notes: [] }
}

/* ------------------------------------------------------------ pg_stats ---- */

function parsePgStats(text: string): CatalogParseResult | null {
  const rows = tabular(text)
  if (!rows) return null
  const head = rows.header.map((h) => h.toLowerCase())
  if (!head.includes('attname')) return null
  if (!head.includes('n_distinct') && !head.includes('null_frac') && !head.includes('avg_width')) return null

  const table = head.includes('tablename') ? null : '<unknown>'
  const columns: ObservedColumnStats[] = rows.rows.map((row) => {
    const get = (k: string) => (head.includes(k) ? row[head.indexOf(k)] : undefined)
    return {
      table: table ?? get('tablename') ?? '<unknown>',
      column: get('attname') ?? '',
      distinct: numeric(get('n_distinct')),
      nullFraction: numeric(get('null_frac')),
      averageWidth: numeric(get('avg_width')),
    }
  }).filter((c) => c.column)

  if (columns.length === 0) return null

  return {
    catalog: { ...EMPTY, columns },
    notes: [
      'Postgres reports n_distinct as a negative number when it is a fraction of the row count ' +
      '(-1 means every value is distinct). Selectivity is read with that in mind.',
    ],
  }
}

/* ------------------------------------------------- pg_stat_user_tables ---- */

function parseTableStats(text: string): CatalogParseResult | null {
  const rows = tabular(text)
  if (!rows) return null
  const head = rows.header.map((h) => h.toLowerCase())
  if (!head.includes('relname') || !head.includes('seq_scan')) return null
  if (head.includes('indexrelname')) return null   // that is the index table

  const tables: ObservedTableStats[] = rows.rows.map((row) => {
    const get = (k: string) => (head.includes(k) ? row[head.indexOf(k)] : undefined)
    return {
      table: get('relname') ?? '',
      liveRows: numeric(get('n_live_tup')),
      sequentialScans: numeric(get('seq_scan')),
      indexScans: numeric(get('idx_scan')),
    }
  }).filter((t) => t.table)

  return tables.length ? { catalog: { ...EMPTY, tables }, notes: [] } : null
}

/* ------------------------------------------------ pg_stat_user_indexes ---- */

function parseIndexUsage(text: string): CatalogParseResult | null {
  const rows = tabular(text)
  if (!rows) return null
  const head = rows.header.map((h) => h.toLowerCase())
  if (!head.includes('indexrelname') || !head.includes('idx_scan')) return null

  const indexes: ObservedIndex[] = rows.rows.map((row) => {
    const get = (k: string) => (head.includes(k) ? row[head.indexOf(k)] : undefined)
    return {
      table: get('relname') ?? '<unknown>',
      name: get('indexrelname') ?? '',
      // Usage output names the index but not its columns; a separate pg_indexes
      // capture supplies those. Merging is `merge.ts`'s job.
      columns: [],
      unique: false,
      scans: numeric(get('idx_scan')),
      sizeBytes: numeric(get('size_bytes')),
    }
  }).filter((i) => i.name)

  if (indexes.length === 0) return null

  return {
    catalog: { ...EMPTY, indexes },
    notes: [
      'idx_scan counts usage since statistics were last reset. Capture ' +
      '`SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();` alongside this — ' +
      'a zero count after a recent reset means "not measured", not "not used", and dropping an index on ' +
      'that reading is an outage rather than a saving.',
    ],
  }
}

/* ----------------------------------------------------------------- utils -- */

interface Tabular { header: string[]; rows: string[][] }

/**
 * psql and the mysql client both print `col | col` with a `---+---` rule under
 * it. Tab- and comma-separated output is accepted too, because that is what
 * comes out of `\copy`, a CSV export or a GUI client.
 */
function tabular(text: string): Tabular | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return null

  const sep = lines[0]!.includes('|') ? '|' : lines[0]!.includes('\t') ? '\t' : ','
  const split = (l: string) => l.split(sep).map((c) => c.trim()).filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''))

  const header = split(lines[0]!)
  if (header.length < 2) return null

  const rows = lines
    .slice(1)
    // The `----+----` rule, and psql's `(3 rows)` footer.
    .filter((l) => !/^[-+\s|]+$/.test(l) && !/^\(\d+ rows?\)$/.test(l))
    .map(split)
    .filter((r) => r.length === header.length)

  return rows.length ? { header, rows } : null
}

/**
 * The text from `start` up to the paren that closes the one just consumed.
 *
 * Nesting matters: `(lower(email), tenant_id)` has to come back whole.
 */
function balanced(text: string, start: number): string {
  let depth = 1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(start, i)
    }
    // A newline before the parens balance means the paste was wrapped; the
    // definition is unusable rather than half-read.
    else if (ch === '\n' && depth > 1) break
  }
  return text.slice(start, text.indexOf('\n', start) === -1 ? undefined : text.indexOf('\n', start))
}

function splitColumns(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  // Strip sort direction and opclass, keep expressions intact.
  return out.map((c) => unquote(c.replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))\b/gi, '').trim()))
}

function unquote(s: string): string {
  return s.replace(/^["`]|["`]$/g, '')
}

function numeric(v?: string): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Merge captures of different shapes into one catalog. */
export function mergeCatalogs(parts: CatalogEvidence[]): CatalogEvidence {
  const indexes = new Map<string, ObservedIndex>()
  for (const part of parts) {
    for (const idx of part.indexes) {
      const key = `${idx.table}.${idx.name}`
      const existing = indexes.get(key)
      if (!existing) {
        indexes.set(key, { ...idx })
        continue
      }
      // A usage capture names the index but not its columns; a definition
      // capture is the reverse. Neither should overwrite the other's half.
      indexes.set(key, {
        ...existing,
        columns: existing.columns.length ? existing.columns : idx.columns,
        unique: existing.unique || idx.unique,
        scans: existing.scans ?? idx.scans,
        sizeBytes: existing.sizeBytes ?? idx.sizeBytes,
        statsResetAt: existing.statsResetAt ?? idx.statsResetAt,
        table: existing.table === '<unknown>' ? idx.table : existing.table,
      })
    }
  }
  return {
    indexes: [...indexes.values()],
    columns: parts.flatMap((p) => p.columns),
    tables: parts.flatMap((p) => p.tables),
  }
}
