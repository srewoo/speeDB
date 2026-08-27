import type { DbFamily } from '@/config/engines'
import type { DbEngine, FindingCategory } from '@/core/types'

/**
 * Verification, keyed on the claim as well as the engine.
 *
 * `explainFor(engine, family)` answers one question — "how do I get a query
 * plan on this store?" — and every finding got the same answer. For most
 * categories that is right: a missing index, a full scan and a bad join are all
 * decided by reading a plan.
 *
 * For five of the fifteen categories it is not merely unhelpful, it tests the
 * wrong mechanism. A `plan-cache-miss` finding on Postgres was handed
 *
 *     EXPLAIN (ANALYZE, BUFFERS, VERBOSE) <query>
 *     look for: Seq Scan becoming Index Scan
 *
 * and a plan cannot answer a question about plan *reuse*. Running EXPLAIN on
 * the statement tells you what the planner does when asked; the claim is about
 * how often it is asked at all. Same for `connection-handling`, where the
 * instrument is `pg_stat_activity` and a plan is irrelevant; `transaction-scope`,
 * where it is transaction age; and `redundant-index`, where it is index usage
 * counters and size. A reader following those instructions would run the
 * command, see a plan that looked fine, and conclude the finding was wrong —
 * the worst available outcome for a product whose whole thesis is checkability.
 *
 * ## Two dimensions, not one
 *
 * A recipe is `(category, engine)`. Same category, unrelated instruments:
 *
 *   plan-cache-miss on Postgres   pg_stat_statements + plan_cache_mode
 *   plan-cache-miss on MySQL      performance_schema.prepared_statements_instances
 *   plan-cache-miss on SQL Server sys.dm_exec_cached_plans.usecounts
 *
 * So overlays are keyed by engine id first, then by family as the fallback, and
 * the family recipe from `explain.ts` underneath that.
 *
 * ## Confirms and refutes
 *
 * Every overlay states what evidence would *confirm* the claim and what would
 * *refute* it. This is the part that makes a recipe a prediction rather than an
 * instruction: a command with no stated failure condition can be run, produce
 * any output at all, and be read as agreement. Naming the refutation up front is
 * what lets the reader — and later, a machine comparing two captures — reach
 * "this finding was wrong" as a real outcome rather than an absence of one.
 */

export interface CategoryOverlay {
  /**
   * The single metric under test. One clause, no hedging: if this cannot be
   * stated, the recipe does not know what it is measuring.
   */
  measures: string
  /** Run against the current code. Omitted when the family plan is right. */
  commandOriginal?: string
  /** Run against the rewrite. Omitted when it is the same command. */
  commandProposed?: string
  /** Statements exposing data the source cannot contain. */
  stats?: string[]
  /** Output consistent with the claim. */
  confirms: string[]
  /** Output that kills the claim. Never empty. */
  refutes: string[]
  /**
   * True when a query plan is not the instrument at all, so the family's
   * EXPLAIN commands should be dropped rather than shown alongside these.
   * Offering both invites the reader to run the one that cannot answer.
   */
  replacesPlan?: boolean
}

type ByEngine = Partial<Record<DbEngine | DbFamily | 'default', CategoryOverlay>>

/* --------------------------------------------------------------- overlays -- */

const roundTrip: CategoryOverlay = {
  measures: 'the number of database round trips for one unit of work',
  confirms: [
    'The query count drops to the number the finding claims, for the same input.',
    'The rows the application ends up with are unchanged.',
  ],
  refutes: [
    'The query count is unchanged — the work moved rather than being eliminated.',
    'The count drops but a second query appears elsewhere in the request.',
    'Fewer queries, but the batch now fetches rows the original never loaded.',
  ],
  replacesPlan: true,
}

export const CATEGORY_OVERLAYS: Partial<Record<FindingCategory, ByEngine>> = {
  /* -- claims about round trips: a counter, never a plan -------------------- */
  'n-plus-one': { default: roundTrip },
  'round-trip': { default: roundTrip },
  batching: {
    default: {
      ...roundTrip,
      measures: 'round trips and the transaction duration that spans them',
      confirms: [
        ...roundTrip.confirms,
        'Total time inside the transaction falls, not just the number of statements.',
      ],
      refutes: [
        ...roundTrip.refutes,
        'The batch holds one transaction open longer than the individual statements did, trading round trips for lock duration.',
      ],
    },
  },

  /* -- plan cache: about reuse, not about the plan -------------------------- */
  'plan-cache-miss': {
    postgres: {
      measures: 'whether one query shape reuses a plan, or replans on every execution',
      replacesPlan: true,
      commandOriginal:
        "SELECT queryid, calls, mean_plan_time, mean_exec_time, left(query, 90) AS q\n" +
        "FROM pg_stat_statements ORDER BY calls DESC LIMIT 50;",
      stats: [
        'SHOW plan_cache_mode;',
        '-- Requires: CREATE EXTENSION pg_stat_statements; and shared_preload_libraries.',
      ],
      confirms: [
        'Many rows whose `query` differs only in literals — that is one shape being planned repeatedly, and the queryid differs for each.',
        'mean_plan_time is a significant fraction of mean_exec_time.',
        'After the change: one queryid with a high `calls`, where there were many with low ones.',
      ],
      refutes: [
        'The shape already appears as a single parameterised row with a high call count — it is already reusing a plan and there is nothing to fix.',
        'mean_plan_time is negligible beside mean_exec_time; planning is not the cost here.',
      ],
    },
    mysql: {
      measures: 'whether statements are prepared once and executed many times, or re-prepared',
      replacesPlan: true,
      commandOriginal:
        "SELECT statement_name, count_execute, count_reprepare, sum_timer_execute\n" +
        'FROM performance_schema.prepared_statements_instances;',
      stats: ["SHOW GLOBAL STATUS LIKE 'Com_stmt_%';"],
      confirms: [
        'Com_stmt_prepare is close to Com_stmt_execute — the statement is being prepared for nearly every execution.',
        'count_reprepare is non-zero and rising.',
      ],
      refutes: [
        'Com_stmt_execute far exceeds Com_stmt_prepare; preparation is already amortised.',
        'The application does not use prepared statements at all, so the finding is about the wrong mechanism.',
      ],
    },
    mssql: {
      measures: 'whether compiled plans are reused across executions',
      replacesPlan: true,
      commandOriginal:
        'SELECT usecounts, cacheobjtype, objtype, LEFT(t.text, 90) AS q\n' +
        'FROM sys.dm_exec_cached_plans p CROSS APPLY sys.dm_exec_sql_text(p.plan_handle) t\n' +
        'ORDER BY usecounts ASC;',
      confirms: [
        'Many `Adhoc` plans with usecounts = 1 and near-identical text — every execution compiled its own plan.',
        'After the change: one `Prepared` plan with a rising usecount.',
      ],
      refutes: [
        'The plans are already `Prepared` with high usecounts.',
        "'optimize for ad hoc workloads' is on and the cache is behaving as configured.",
      ],
    },
  },

  /* -- connection and transaction: never a plan ----------------------------- */
  'connection-handling': {
    postgres: {
      measures: 'connection pool occupancy and how long connections are held',
      replacesPlan: true,
      commandOriginal:
        'SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY 2 DESC;',
      stats: ['SHOW max_connections;', 'SELECT count(*) FROM pg_stat_activity;'],
      confirms: [
        'Connection count sits near max_connections, or the pool reports waiters.',
        'After the change: the same workload holds measurably fewer connections.',
      ],
      refutes: [
        'The pool is nowhere near saturated, so connection handling is not the constraint — whatever is slow is slow for another reason.',
      ],
    },
    default: {
      measures: 'how many connections the workload holds, and for how long',
      replacesPlan: true,
      confirms: ['Concurrent connection count falls for the same workload.'],
      refutes: [
        'The pool was never near its limit, so this changes nothing that was constraining anything.',
      ],
    },
  },
  'transaction-scope': {
    postgres: {
      measures: 'how long a transaction stays open, and what it holds while open',
      replacesPlan: true,
      commandOriginal:
        "SELECT pid, state, now() - xact_start AS xact_age, now() - state_change AS idle_for,\n" +
        "       left(query, 90) AS q\n" +
        "FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_age DESC LIMIT 20;",
      stats: [
        'SELECT locktype, relation::regclass, mode, granted FROM pg_locks WHERE NOT granted;',
      ],
      confirms: [
        "Rows in state `idle in transaction` with a large xact_age — work is being done outside the database while a transaction is held open.",
        'Ungranted locks in pg_locks waiting on that transaction.',
        'After the change: xact_age for the same operation drops, and the ungranted locks clear.',
      ],
      refutes: [
        'Transaction ages are already short and nothing is waiting on locks.',
        'Narrowing the transaction split one atomic unit into two, so a partial failure can now leave inconsistent state — a correctness regression, whatever it did to lock time.',
      ],
    },
  },

  /* -- index claims: usage and size, not just the plan ---------------------- */
  'redundant-index': {
    postgres: {
      measures: 'whether the index is used at all, and what it costs to keep',
      replacesPlan: true,
      commandOriginal:
        "SELECT indexrelname, idx_scan, idx_tup_read,\n" +
        '       pg_size_pretty(pg_relation_size(indexrelid)) AS size\n' +
        "FROM pg_stat_user_indexes WHERE relname = '<table>' ORDER BY idx_scan;",
      stats: [
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '<table>';",
        'SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();',
      ],
      confirms: [
        'idx_scan is 0 or near it, over a window long enough to include the workload that would use it.',
        'A second index whose definition has this one as a leading prefix, so those lookups are already served.',
      ],
      refutes: [
        'idx_scan is non-trivial — something uses it, whatever the migration files suggest.',
        'Statistics were reset recently (see stats_reset), so a zero count means "not measured", not "not used".',
        'The index is UNIQUE, so it enforces a constraint and dropping it changes what the database will accept.',
      ],
    },
    mysql: {
      measures: 'whether the index is used at all, and what it costs to keep',
      replacesPlan: true,
      commandOriginal: 'SHOW INDEX FROM `<table>`;',
      stats: [
        'SELECT * FROM sys.schema_unused_indexes WHERE object_name = \'<table>\';',
        "SELECT index_name, count_star, count_read FROM performance_schema.table_io_waits_summary_by_index_usage WHERE object_name = '<table>';",
      ],
      confirms: ['count_star is 0 for this index over a representative window.'],
      refutes: [
        'count_read is non-zero.',
        'The index is UNIQUE or backs a foreign key, so it is a constraint rather than an optimisation.',
      ],
    },
  },

  /* -- claims a plan does answer, but not with the family default ----------- */
  'unbounded-result': {
    default: {
      measures: 'how many rows the predicate actually matches, and the memory that costs',
      commandOriginal: 'SELECT count(*) FROM <table> WHERE <the same predicate>;',
      confirms: [
        'The count is large enough that materialising it is the problem — that number *is* the finding.',
        'After the change: the plan shows a Limit node, and rows returned is bounded.',
      ],
      refutes: [
        'The count is small and bounded in practice, so the unbounded fetch never mattered.',
        'The added LIMIT has no ORDER BY, so which rows come back is now arbitrary — that is a behaviour change, not an optimisation.',
      ],
    },
  },
  'sort-in-memory': {
    postgres: {
      measures: 'whether the sort spills to disk, and whether it happens at all',
      commandOriginal: 'EXPLAIN (ANALYZE, BUFFERS) <query>;',
      stats: ['SHOW work_mem;'],
      confirms: [
        'The Sort node reports `Sort Method: external merge  Disk: NkB` — it spilled.',
        'After the change: the Sort node disappears, replaced by an ordered index scan.',
      ],
      refutes: [
        '`Sort Method: quicksort  Memory: NkB` with a small N — the sort fits in work_mem and was never the cost.',
        'The sort is gone but the output order changed, which is a different result rather than a faster one.',
      ],
    },
  },
  'implicit-cast': {
    postgres: {
      measures: 'whether the predicate can use the index, or is wrapped in a cast',
      commandOriginal: 'EXPLAIN (ANALYZE, BUFFERS) <query>;',
      stats: [
        "SELECT attname, atttypid::regtype FROM pg_attribute WHERE attrelid = '<table>'::regclass AND attnum > 0;",
      ],
      confirms: [
        'The plan shows the predicate under `Filter:` with a cast on the column side, e.g. `(col)::text = ...`.',
        'After the change: the same predicate appears under `Index Cond:` instead of `Filter:`.',
      ],
      refutes: [
        'The predicate is already an Index Cond — there is no cast blocking anything.',
        'Removing the cast changes which rows match (a numeric-to-text comparison is not the same comparison).',
      ],
    },
  },
  'over-fetch': {
    postgres: {
      measures: 'bytes read and transferred, not the number of rows',
      commandOriginal: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE) <query>;',
      stats: [
        "SELECT attname, avg_width FROM pg_stats WHERE tablename = '<table>' ORDER BY avg_width DESC;",
      ],
      confirms: [
        'Buffers: shared read falls between the two plans.',
        'The dropped columns have a large avg_width — narrowing a row of small integers saves nothing worth reporting.',
        'The plan becomes Index Only Scan, meaning the heap is no longer touched.',
      ],
      refutes: [
        'Buffer counts are identical: the row was read either way, and only the transfer narrowed.',
        'The application reads one of the dropped columns further down the call path, so this is a bug rather than an optimisation.',
      ],
    },
  },
  'missing-index': {
    postgres: {
      measures: 'whether the planner chooses the index, and what it costs to maintain',
      commandOriginal: 'EXPLAIN (ANALYZE, BUFFERS) <query>;',
      stats: [
        "SELECT seq_scan, idx_scan, n_live_tup FROM pg_stat_user_tables WHERE relname = '<table>';",
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '<table>';",
        "SELECT attname, n_distinct, null_frac FROM pg_stats WHERE tablename = '<table>';",
      ],
      confirms: [
        'Seq Scan becomes Index Scan or Index Only Scan on the target relation.',
        'Buffers: shared read falls by a large factor, not a few percent.',
        'seq_scan was high against a large n_live_tup — the precondition for the finding to matter at all.',
      ],
      refutes: [
        'pg_indexes already lists an index with these columns as a leading prefix — it exists, and migration files simply did not record it.',
        'The planner ignores the new index, usually because n_distinct shows the column is not selective.',
        'The table is small enough that a Seq Scan is correct and the planner is right to prefer it.',
        'Write throughput on the table drops measurably: the index is paid for on every insert and update.',
      ],
    },
  },

  /* -- recall is the metric here, and latency alone hides a regression ------ */
  'full-scan': {
    vector: {
      measures: 'latency **and** recall together — either alone is meaningless',
      replacesPlan: true,
      commandOriginal:
        '-- 1. Exact baseline: brute-force top-K for a fixed query set.\n' +
        '-- 2. Same query set through the index, at the proposed parameters.\n' +
        '-- 3. recall@K = |approx ∩ exact| / K, averaged over the set.',
      confirms: [
        'Latency falls at unchanged recall@K.',
        'Recall@K is measured against an exact search, not assumed.',
      ],
      refutes: [
        'Latency falls and recall@K falls with it — that is a quality regression sold as a speed-up.',
        'Recall was never measured, in which case nothing has been demonstrated either way.',
      ],
    },
  },
}

/** The overlay for a claim, or null when the family recipe is the right one. */
export function overlayFor(
  category: FindingCategory,
  engineId: string,
  family: DbFamily,
): CategoryOverlay | null {
  const byEngine = CATEGORY_OVERLAYS[category]
  if (!byEngine) return null
  // Engine first, then family, then a category-wide default. A Postgres
  // plan-cache question and a MySQL one are different instruments; a round-trip
  // count is the same everywhere.
  return (
    byEngine[engineId as DbEngine] ??
    byEngine[family as DbFamily] ??
    byEngine.default ??
    null
  )
}
