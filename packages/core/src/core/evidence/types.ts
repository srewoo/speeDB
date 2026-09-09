import type { DbEngine } from '@/core/types'

/**
 * Runtime evidence: facts from a real database, supplied by the person who has
 * one.
 *
 * speeDB executes nothing and connects to nothing — NG1, and it stays that way.
 * That is a deliberate refusal, not a missing feature: no credentials means no
 * prod risk, and it is most of why this tool is safe to point at a repository
 * you do not own. But it left the product structurally unable to answer its own
 * central question. `performance.ts` names four things it cannot know — row
 * counts, selectivity, which indexes exist in production, index bloat — and
 * then has to leave them named and unanswered forever.
 *
 * The way out is not a connection. It is that the user *already has* the
 * answers: they can run `EXPLAIN`, they can `SELECT` from `pg_indexes`, they
 * have a query log. What was missing is a way to hand those back. So evidence
 * is pasted or uploaded, parsed here, and merged into the same grounding the
 * declared schema already feeds.
 *
 * ## Provenance is not optional
 *
 * Every piece of evidence carries when it was captured, against which commit,
 * and from which environment. This is the same discipline as
 * `PRICES_VERIFIED_ON`: a six-month-old staging plan rendered as "measured"
 * would be exactly the confident-wrong-number failure that table exists to
 * avoid. Stale evidence is *labelled and demoted*, never silently trusted, and
 * `isStale` is the single place that decides.
 *
 * ## It is more sensitive than an API key
 *
 * `EXPLAIN ANALYZE` output contains production row values inside filter
 * predicates and index conditions. A query log contains bound parameters. A key
 * is revocable; a leaked customer row is not. So evidence follows the same
 * storage rule as secrets and defaults to `chrome.storage.session` — see
 * `evidence/store.ts`.
 */

export type EvidenceKind =
  /** A query plan, with or without actual timings. */
  | 'plan'
  /** The indexes that actually exist, as opposed to those migrations declare. */
  | 'index-catalog'
  /** Row counts, distinct counts, null fractions, average widths. */
  | 'column-stats'
  /** Queries issued for one unit of work, from an ORM or the server log. */
  | 'query-log'
  /** Statement-level aggregates: calls, planning time, execution time. */
  | 'statement-stats'

/** Which side of the comparison a capture describes. */
export type EvidenceSide = 'original' | 'proposed'

export interface EvidenceProvenance {
  /** ISO 8601. Parsed from the output where possible, else stated by the user. */
  capturedAt: string
  /**
   * The commit the database was running when this was captured.
   *
   * Absent is honest and common — most people cannot say. Present and
   * *different* from the scanned commit is the case that matters: the plan
   * describes code that is not the code being reviewed.
   */
  commitSha?: string
  /** 'production', 'staging', or whatever the user calls it. */
  environment?: string
}

export interface RuntimeEvidence<T = unknown> {
  kind: EvidenceKind
  engine: DbEngine
  side?: EvidenceSide
  provenance: EvidenceProvenance
  /**
   * Kept verbatim, so it can be quoted as `Evidence` exactly like a source
   * file. A parsed structure that cannot be traced back to what the user
   * actually pasted is the same class of unverifiable claim the grounding pass
   * exists to reject.
   */
  raw: string
  parsed: T
  /** Non-fatal problems: unknown fields, a partial plan, a truncated log. */
  notes: string[]
}

/* ------------------------------------------------------------------ plan -- */

/**
 * One node of a query plan, normalised across engines.
 *
 * Deliberately small. Every engine reports dozens of fields and they do not
 * correspond; these six are the ones that decide whether a rewrite helped, and
 * they have a defensible equivalent everywhere:
 *
 *   Postgres  Node Type / Actual Rows / Plan Rows / Shared Read Blocks / Actual Total Time / Actual Loops
 *   MySQL     access_type / rows_examined_per_scan / rows_produced_per_join / — / query_cost / —
 *   Mongo     stage / nReturned / — / totalDocsExamined / executionTimeMillis / works
 *
 * A field an engine cannot supply is `undefined`, never zero. Zero is a
 * measurement.
 */
export interface PlanNode {
  /** `Seq Scan`, `Index Scan`, `COLLSCAN`, `ref` — verbatim from the engine. */
  nodeType: string
  /** The table or index this node touches, when the engine names it. */
  relation?: string
  /** Rows the engine actually produced. Undefined when the plan is not timed. */
  actualRows?: number
  /** Rows the planner expected. A large gap means stale statistics. */
  estimatedRows?: number
  /** Rows read and then discarded by a filter. */
  rowsRemovedByFilter?: number
  /** Blocks or documents read from disk. The comparison metric that matters. */
  blocksRead?: number
  /** Blocks served from cache. */
  blocksHit?: number
  /** Milliseconds, inclusive of children. */
  actualTotalMs?: number
  /** How many times this node ran. A per-iteration query shows up here. */
  loops?: number
  /** `quicksort Memory: 25kB` / `external merge Disk: 4096kB`. */
  sortMethod?: string
  /** Free-form extras the comparison does not read but a human might. */
  detail?: Record<string, string | number>
  children: PlanNode[]
}

export interface ParsedPlan {
  root: PlanNode
  /** True when the plan carries real timings, false for a plan-only capture. */
  timed: boolean
  /** Total ms for the statement, when reported separately from the root node. */
  totalMs?: number
  /** Planning time, which is what a plan-cache claim is actually about. */
  planningMs?: number
}

/* --------------------------------------------------------------- catalog -- */

export interface ObservedIndex {
  table: string
  name: string
  columns: string[]
  unique: boolean
  /** Bytes, when the capture includes it. */
  sizeBytes?: number
  /** Times the index was used since statistics were last reset. */
  scans?: number
  /**
   * When the counters were last reset.
   *
   * Load-bearing: `scans === 0` shortly after a reset means "not measured", not
   * "not used", and dropping an index on that reading is an outage. Every
   * consumer of `scans` has to look at this.
   */
  statsResetAt?: string
}

export interface ObservedColumnStats {
  table: string
  column: string
  /** Postgres n_distinct semantics: negative means a fraction of the rows. */
  distinct?: number
  nullFraction?: number
  averageWidth?: number
}

export interface ObservedTableStats {
  table: string
  liveRows?: number
  sequentialScans?: number
  indexScans?: number
}

export interface CatalogEvidence {
  indexes: ObservedIndex[]
  columns: ObservedColumnStats[]
  tables: ObservedTableStats[]
}

/* ------------------------------------------------------------- query log -- */

export interface QueryLogEvidence {
  /** Total statements issued for the captured unit of work. */
  count: number
  /** Statements grouped by normalised shape, to expose an N+1 directly. */
  shapes: { shape: string; count: number }[]
  /** Wall-clock for the unit of work, when the log reports it. */
  totalMs?: number
}

/* ---------------------------------------------------------------- verdict -- */

/**
 * The four answers, and the reason there are four rather than three.
 *
 * `no-difference` and `insufficient-evidence` are not the same result and
 * collapsing them would hide the most common honest outcome. "I measured it and
 * nothing moved" is a finished measurement that refutes a speed claim. "You
 * gave me one untimed plan" is an absence of measurement. A product built on
 * separating what was checked from what was not cannot merge those two.
 */
export type VerdictKind =
  | 'confirmed'
  | 'no-difference'
  | 'regression'
  | 'insufficient-evidence'

export interface PerformanceVerdict {
  kind: VerdictKind
  /** Each reason cites the metric and both numbers. Never a bare adjective. */
  because: string[]
  /** What would have to be captured to move off `insufficient-evidence`. */
  missing?: string[]
  /** Provenance of everything the verdict rests on, for the report header. */
  basedOn: EvidenceProvenance[]
  /** True when any input was stale; the verdict is reported but qualified. */
  stale: boolean
}

/* ------------------------------------------------------------- staleness -- */

/** Evidence older than this is reported with its age rather than as current. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface StalenessCheck {
  stale: boolean
  /** One clause naming why, for display next to the figure it qualifies. */
  reason?: string
}

/**
 * Is this evidence describing the code being reviewed?
 *
 * Two independent ways to be stale, and the second is the one that bites. Age
 * is the obvious one. A *different commit* is the dangerous one: a plan
 * captured yesterday against a build that predates the rewrite is fresh by the
 * clock and describes different code.
 *
 * `now` is a parameter rather than a `Date.now()` call so this is testable
 * without freezing time globally.
 */
export function checkStaleness(
  provenance: EvidenceProvenance,
  scannedCommitSha: string,
  now: number,
): StalenessCheck {
  const captured = Date.parse(provenance.capturedAt)

  if (Number.isNaN(captured)) {
    return { stale: true, reason: 'the capture time could not be read, so its age is unknown' }
  }
  if (captured > now + 60_000) {
    // A clock skew of a minute is ordinary; an hour in the future is a wrong
    // date, and treating it as current would make it permanently fresh.
    return { stale: true, reason: 'the capture time is in the future, so it cannot be trusted as a date' }
  }
  if (provenance.commitSha && provenance.commitSha !== scannedCommitSha) {
    return {
      stale: true,
      reason:
        `it was captured against commit ${provenance.commitSha.slice(0, 8)}, not the scanned ` +
        `${scannedCommitSha.slice(0, 8)} — it describes different code`,
    }
  }
  const ageMs = now - captured
  if (ageMs > STALE_AFTER_MS) {
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000))
    return { stale: true, reason: `it is ${days} day(s) old; indexes and data volume move` }
  }
  return { stale: false }
}
