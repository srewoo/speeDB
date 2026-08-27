import type { SchemaFacts, IndexFact } from '@/core/analyze/schema-facts'
import type { CatalogEvidence } from './types'

/**
 * Declared catalog ⊕ observed catalog.
 *
 * `schema-facts.ts` reads migrations, and `UNKNOWABLE` states the consequence
 * plainly: *"Which indexes actually exist in production, versus which were
 * declared in a migration that may have been superseded, reverted, or never
 * run."* That sentence is the honest description of a real hole, and it is the
 * single largest source of wrong index advice — the failure the PRD names in
 * §1.4 as the one that burns reviewer trust.
 *
 * An imported catalog closes it, and the merge has to be careful about which
 * direction each source is authoritative in:
 *
 *   declared only   the migration ran, or it did not. Unproven either way.
 *   observed only   it exists. Someone added it outside the migration tool,
 *                   which is exactly the case migrations cannot show.
 *   both            the strongest fact available here.
 *
 * The asymmetry that matters: a declared index the live catalog does **not**
 * contain is not evidence of absence unless the capture covered that table. A
 * paste of `pg_indexes WHERE tablename = 'orders'` says nothing about `users`,
 * and treating it as a complete catalog would invent a missing index. So the
 * merge tracks which tables were actually covered and refuses to reason beyond
 * them.
 */

export type IndexOrigin = 'declared' | 'observed' | 'both'

export interface GroundedIndex extends IndexFact {
  origin: IndexOrigin
  /** Times used since statistics were reset, when the capture supplied it. */
  scans?: number
  sizeBytes?: number
}

export interface GroundedFacts extends Omit<SchemaFacts, 'indexes' | 'unknowable'> {
  indexes: GroundedIndex[]
  /**
   * Tables the imported catalog actually covered. Outside this set, absence of
   * an index in the capture means "not looked at", not "not there".
   */
  observedTables: Set<string>
  /** Row counts and selectivity, where a stats capture supplied them. */
  rowCounts: Map<string, number>
  selectivity: Map<string, { distinct?: number; nullFraction?: number; averageWidth?: number }>
  readonly unknowable: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/^["`]|["`]$/g, '')

export function groundSchemaFacts(
  facts: SchemaFacts,
  observed: CatalogEvidence | null,
): GroundedFacts {
  if (!observed) {
    return {
      ...facts,
      indexes: facts.indexes.map((i) => ({ ...i, origin: 'declared' as const })),
      observedTables: new Set(),
      rowCounts: new Map(),
      selectivity: new Map(),
      unknowable: [...facts.unknowable],
    }
  }

  const observedTables = new Set<string>([
    ...observed.indexes.map((i) => norm(i.table)),
    ...observed.tables.map((t) => norm(t.table)),
    ...observed.columns.map((c) => norm(c.table)),
  ])
  observedTables.delete('<unknown>')

  const out: GroundedIndex[] = []
  const claimed = new Set<string>()

  for (const declared of facts.indexes) {
    const match = observed.indexes.find(
      (o) =>
        norm(o.table) === norm(declared.table) &&
        (norm(o.name) === norm(declared.name) || sameColumns(o.columns, declared.columns)),
    )
    if (match) {
      claimed.add(`${norm(match.table)}.${norm(match.name)}`)
      out.push({
        ...declared,
        // The live name wins: a migration's index name and the catalog's can
        // differ, and the catalog's is the one someone would type to drop it.
        name: match.name || declared.name,
        columns: match.columns.length ? match.columns : declared.columns,
        origin: 'both',
        scans: match.scans,
        sizeBytes: match.sizeBytes,
      })
    } else {
      out.push({ ...declared, origin: 'declared' })
    }
  }

  for (const o of observed.indexes) {
    const key = `${norm(o.table)}.${norm(o.name)}`
    if (claimed.has(key)) continue
    out.push({
      name: o.name,
      table: o.table,
      columns: o.columns,
      unique: o.unique,
      // These exist and no migration in the tree declares them — a hand-added
      // index, a concurrently-created one, or a migration that lives in another
      // repository. Every one of them is a reason an index suggestion would
      // have been wrong.
      source: { file: '(live database)', line: 0 },
      origin: 'observed',
      scans: o.scans,
      sizeBytes: o.sizeBytes,
    })
  }

  const rowCounts = new Map<string, number>()
  for (const t of observed.tables) {
    if (t.liveRows !== undefined) rowCounts.set(norm(t.table), t.liveRows)
  }

  const selectivity = new Map<string, { distinct?: number; nullFraction?: number; averageWidth?: number }>()
  for (const c of observed.columns) {
    selectivity.set(`${norm(c.table)}.${norm(c.column)}`, {
      distinct: c.distinct,
      nullFraction: c.nullFraction,
      averageWidth: c.averageWidth,
    })
  }

  return {
    ...facts,
    indexes: out,
    observedTables,
    rowCounts,
    selectivity,
    // The list shrinks by exactly what was supplied, and no further. Removing an
    // entry the capture did not actually answer would be the same overstatement
    // the list exists to prevent.
    unknowable: remainingUnknowable(facts.unknowable, observed),
  }
}

function remainingUnknowable(base: readonly string[], observed: CatalogEvidence): string[] {
  const answered = new Set<string>()
  if (observed.tables.some((t) => t.liveRows !== undefined)) answered.add('Row counts')
  if (observed.columns.some((c) => c.distinct !== undefined)) answered.add('Column selectivity')
  if (observed.indexes.length > 0) answered.add('Which indexes actually exist')
  if (observed.indexes.some((i) => i.scans !== undefined)) answered.add('Index bloat')

  return base.filter((line) => ![...answered].some((a) => line.startsWith(a)))
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((c, i) => norm(c) === norm(b[i]!))
}

/* --------------------------------------------------------------- checks -- */

export interface ObservedIndexVerdict {
  /** True when the live catalog already serves this proposal. */
  alreadyExists: boolean
  /** Whether the capture actually covered the table in question. */
  tableWasObserved: boolean
  notes: string[]
}

/**
 * Does the index this finding proposes already exist in the live database?
 *
 * This is the check the whole import is for. A `missing-index` finding whose
 * index is already there is not a small inaccuracy — it is the tool confidently
 * recommending work that is already done, against a table it cannot see, which
 * is precisely the generic-chatbot failure the product defines itself against.
 */
export function checkAgainstObserved(
  table: string,
  columns: string[],
  grounded: GroundedFacts,
): ObservedIndexVerdict {
  const t = norm(table)
  const tableWasObserved = grounded.observedTables.has(t)

  if (!tableWasObserved) {
    return {
      alreadyExists: false,
      tableWasObserved: false,
      notes: [
        `The imported catalog does not cover ${table}, so whether this index exists in production is still unknown. ` +
        'An index absent from a capture that never looked at the table is not an index that is absent.',
      ],
    }
  }

  const live = grounded.indexes.filter(
    (i) => norm(i.table) === t && (i.origin === 'observed' || i.origin === 'both'),
  )

  const exact = live.find((i) => sameColumns(i.columns, columns))
  if (exact) {
    return {
      alreadyExists: true,
      tableWasObserved: true,
      notes: [
        `This index already exists in the live database as ${exact.name}` +
        `${exact.origin === 'observed' ? ' — and no migration in this repository declares it' : ''}. ` +
        `${exact.scans !== undefined ? `It has been used ${exact.scans.toLocaleString()} time(s) since statistics were last reset. ` : ''}` +
        'There is nothing to create.',
      ],
    }
  }

  const covering = live.find(
    (i) => i.columns.length >= columns.length && columns.every((c, k) => norm(i.columns[k] ?? '') === norm(c)),
  )
  if (covering) {
    return {
      alreadyExists: true,
      tableWasObserved: true,
      notes: [
        `A live index ${covering.name} on (${covering.columns.join(', ')}) already leads with these columns, ` +
        'so it serves the same lookups. Creating this one would duplicate it and add write cost for nothing.',
      ],
    }
  }

  const notes = [`No live index on ${table} covers (${columns.join(', ')}).`]

  // Selectivity, where it was captured. This is the second-most-common reason
  // an index recommendation is wrong: the planner will decline to use an index
  // on a column with few distinct values, whatever the finding argued.
  const stats = grounded.selectivity.get(`${t}.${norm(columns[0] ?? '')}`)
  if (stats?.distinct !== undefined) {
    // Postgres reports a negative n_distinct as a fraction of the row count.
    const distinctLabel = stats.distinct < 0
      ? `${Math.round(Math.abs(stats.distinct) * 100)}% of rows are distinct`
      : `${stats.distinct.toLocaleString()} distinct value(s)`
    notes.push(`Leading column ${columns[0]}: ${distinctLabel}.`)
    if (stats.distinct >= 0 && stats.distinct > 0 && stats.distinct <= 10) {
      notes.push(
        `That is low enough that the planner may ignore this index and scan anyway — a boolean or small ` +
        'enum rarely benefits from one on its own.',
      )
    }
  }

  const rows = grounded.rowCounts.get(t)
  if (rows !== undefined) {
    notes.push(`${table} holds about ${rows.toLocaleString()} live row(s).`)
    if (rows < 1_000) {
      notes.push(
        'At that size a sequential scan is usually the correct plan and the planner is right to prefer it. ' +
        'An index here costs write throughput and saves nothing measurable.',
      )
    }
  }

  return { alreadyExists: false, tableWasObserved: true, notes }
}
