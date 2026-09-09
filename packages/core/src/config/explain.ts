import type { DbFamily } from './engines'
import type { FindingCategory } from '@/core/types'
import { overlayFor } from './verify/by-category'

/**
 * How to actually measure a proposed change, per engine.
 *
 * speeDB executes nothing. It cannot: it has no database connection, no
 * statistics, and no row counts. So every speed claim it relays is a
 * *hypothesis about a mechanism*, not a measurement — and the only honest
 * thing to do is hand over the command that settles it.
 *
 * `lookFor` matters as much as `command`: a plan is only useful if you know
 * which line in it decides the question.
 */
export interface ExplainRecipe {
  /** Prefix applied to a query to get a plan without running it. */
  plan: string
  /** Prefix that runs the query and reports real timings and row counts. */
  measure?: string
  /** What in the output actually answers "did this get faster?". */
  lookFor: string[]
  /** Statements that reveal the data facts speeDB cannot see. */
  stats?: string[]
}

const FAMILY_DEFAULT: Record<DbFamily, ExplainRecipe> = {
  rdbms: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN ANALYZE',
    lookFor: [
      'Scan type — a Seq Scan becoming an Index Scan is the change you are looking for.',
      'Rows removed by filter — a large number means the index is not selective.',
      'Actual time and loops on the slowest node.',
    ],
  },
  'distributed-sql': {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN ANALYZE',
    lookFor: [
      'Distribution or network rows — cross-node traffic usually dominates.',
      'Whether the partition/sharding key is used, or the query fans out to every range.',
    ],
  },
  warehouse: {
    plan: 'EXPLAIN',
    lookFor: [
      'Bytes or partitions scanned — that is the bill, and the thing to reduce.',
      'Whether pruning applied, or the whole table was read.',
    ],
  },
  bigdata: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN FORMATTED',
    lookFor: [
      'Partition pruning — a missing partition predicate reads everything.',
      'Join strategy: broadcast versus shuffle.',
      'Number of stages and shuffled bytes.',
    ],
  },
  document: {
    plan: "-- No SQL planner. Use the driver's own explain facility.",
    measure: "-- Driver explain, e.g. .explain('executionStats')",
    lookFor: [
      'winningPlan.stage — COLLSCAN means no index was used, IXSCAN means one was.',
      'totalDocsExamined versus nReturned — close to 1:1 is the goal.',
      'executionTimeMillis across runs, not a single sample.',
    ],
  },
  'wide-column': {
    plan: 'TRACING ON;',
    lookFor: [
      'Number of partitions or nodes touched — one is good, scatter-gather is not.',
      'Any mention of ALLOW FILTERING or a full-range scan.',
      'Tombstones read, which silently dominates some queries.',
    ],
  },
  'key-value': {
    // There is no planner here; the cost is round trips and blocking commands.
    plan: '-- No planner. Count round trips and check the slow log.',
    measure: '-- Sample latency over many calls; a single timing tells you nothing.',
    lookFor: [
      'Command latency percentiles, not a single timing.',
      'Number of round trips — pipelining changes this, not per-command speed.',
      'Whether a blocking command (KEYS, FLUSHALL) appears in SLOWLOG.',
    ],
  },
  graph: {
    plan: 'EXPLAIN',
    measure: 'PROFILE',
    lookFor: [
      'db hits per operator — that is the real cost unit, not wall time.',
      'Rows flowing between operators; an exploding row count means the traversal is unbounded.',
      'Whether an index seek or an AllNodesScan starts the plan.',
    ],
  },
  search: {
    plan: '-- Add "profile": true to the search request body.',
    measure: '-- Compare the profile output for both queries, not wall time.',
    lookFor: [
      'Time spent per query component in the profile output.',
      'Whether a clause sits in filter context (cacheable, unscored) or must.',
      'Documents examined versus returned.',
    ],
  },
  vector: {
    // Latency alone is the wrong measurement for an approximate index.
    plan: '-- Measure RECALL against an exact search before measuring latency.',
    measure: '-- Latency at a fixed recall. Latency alone hides a recall regression.',
    lookFor: [
      'Recall against an exact search — this is the number that matters, and it is the one that silently regresses.',
      'Latency at a fixed recall, never latency alone.',
      'Whether the index was used or the search fell back to a full scan.',
    ],
  },
  timeseries: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN ANALYZE',
    lookFor: [
      'Chunks or shards excluded — a missing time predicate reads all retention.',
      'Whether the aggregate was pushed down or computed after fetching raw points.',
    ],
  },
  'object-embedded': {
    plan: 'EXPLAIN',
    lookFor: [
      'Whether an index or a full scan was chosen.',
      'Rows read versus rows returned.',
    ],
  },
}

/** Engines whose tooling differs enough from their family to be worth stating. */
const OVERRIDES: Record<string, Partial<ExplainRecipe>> = {
  postgres: {
    measure: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE)',
    stats: [
      "SELECT reltuples::bigint AS estimated_rows FROM pg_class WHERE relname = '<table>';",
      "SELECT attname, n_distinct, most_common_freqs FROM pg_stats WHERE tablename = '<table>';",
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '<table>';",
      'SELECT idx_scan, idx_tup_read FROM pg_stat_user_indexes WHERE relname = \'<table>\';',
    ],
    lookFor: [
      'Scan type — Seq Scan becoming Index Scan is the change you are looking for.',
      'Buffers: shared read versus hit — read means it went to disk.',
      'Rows Removed by Filter — a large number means the index is not selective enough.',
      'Actual rows versus estimated rows; a big gap means the planner is working from bad statistics.',
    ],
  },
  mysql: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN ANALYZE',
    stats: ['SHOW INDEX FROM `<table>`;', 'SHOW TABLE STATUS LIKE \'<table>\';'],
    lookFor: [
      'type column — ALL is a full scan; ref/range/const use an index.',
      'rows column — the planner\'s estimate of rows examined.',
      'Extra column — "Using filesort" and "Using temporary" are the expensive ones.',
    ],
  },
  mssql: {
    plan: 'SET SHOWPLAN_XML ON;',
    measure: 'SET STATISTICS IO, TIME ON;',
    lookFor: [
      'Logical reads per table — the metric to compare, not elapsed time.',
      'Scan versus Seek in the plan.',
      'Any missing-index hint the plan emits.',
    ],
  },
  oracle: {
    plan: 'EXPLAIN PLAN FOR',
    measure: "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));",
    lookFor: ['Operation column — TABLE ACCESS FULL versus INDEX RANGE SCAN.', 'A-Rows versus E-Rows.'],
  },
  snowflake: {
    plan: 'EXPLAIN USING TEXT',
    lookFor: [
      'Partitions scanned versus partitions total — pruning is the whole game.',
      'Bytes spilled to local or remote storage.',
      'Query Profile in the UI for the slowest operator.',
    ],
    stats: ["SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY()) WHERE QUERY_TEXT ILIKE '%<fragment>%';"],
  },
  bigquery: {
    plan: '-- Run as a dry run: bq query --dry_run --use_legacy_sql=false',
    lookFor: [
      'Bytes processed in the dry run — that is the bill, before you pay it.',
      'Whether partition and cluster pruning applied.',
    ],
    stats: ['SELECT table_name, row_count, size_bytes FROM `<dataset>.__TABLES__`;'],
  },
  clickhouse: {
    plan: 'EXPLAIN indexes = 1',
    measure: 'EXPLAIN ESTIMATE',
    lookFor: ['Parts and granules selected versus total.', 'Whether the primary key was used for pruning.'],
  },
  hive: { plan: 'EXPLAIN', measure: 'EXPLAIN EXTENDED', lookFor: ['Partition pruning in the map operator tree.', 'Number of mappers and reducers.'] },
  spark: {
    plan: '.explain(true)  -- or EXPLAIN FORMATTED in SQL',
    lookFor: [
      'PushedFilters and PartitionFilters — pushdown is what avoids reading data.',
      'BroadcastHashJoin versus SortMergeJoin.',
      'Number of shuffle partitions and shuffle bytes in the Spark UI.',
    ],
  },
  mongodb: {
    plan: ".explain('queryPlanner')",
    measure: ".explain('executionStats')",
    lookFor: [
      'winningPlan.stage — COLLSCAN means no index was used.',
      'totalDocsExamined versus nReturned — close to 1:1 is the goal.',
      'For a pipeline, which stage the $match ran in relative to $lookup.',
    ],
    stats: ['db.<collection>.getIndexes()', 'db.<collection>.stats()'],
  },
  dynamodb: {
    plan: '-- Set ReturnConsumedCapacity: "INDEXES" on the request',
    lookFor: [
      'ConsumedCapacity — RCUs are the cost, and a Scan bills for rows it then filters away.',
      'ScannedCount versus Count — a large gap means the filter runs after the read.',
    ],
  },
  cassandra: {
    plan: 'TRACING ON;',
    lookFor: [
      'Number of partitions and nodes touched.',
      'Any "Read <n> live rows and <m> tombstone cells" line.',
      'Whether ALLOW FILTERING appears — it means a scatter-gather scan.',
    ],
    stats: ['nodetool tablestats <keyspace>.<table>', 'nodetool tablehistograms <keyspace>.<table>'],
  },
  redis: {
    plan: '-- No planner. Measure instead:',
    measure: 'redis-cli --latency-history  /  SLOWLOG GET 25',
    lookFor: [
      'Whether the command appears in SLOWLOG at all.',
      'Round trips saved by pipelining — count them, do not time one command.',
      'KEYS on a live keyspace blocks the server regardless of how fast it looks locally.',
    ],
    stats: ['INFO keyspace', 'DBSIZE', 'MEMORY USAGE <key>'],
  },
  elasticsearch: {
    plan: '-- Add "profile": true to the search body',
    measure: 'GET /<index>/_search?profile=true',
    lookFor: [
      'Time per query component in the profile tree.',
      'Whether a clause is in filter context (cacheable, unscored) or must.',
      'Whether _score ordering changed — that changes results, not just speed.',
    ],
    stats: ['GET /<index>/_stats', 'GET /<index>/_count'],
  },
  neo4j: {
    plan: 'EXPLAIN',
    measure: 'PROFILE',
    lookFor: [
      'db hits per operator — the real cost unit.',
      'Rows between operators; a variable-length path can explode here.',
      'NodeIndexSeek versus AllNodesScan at the start of the plan.',
    ],
  },
  pgvector: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN (ANALYZE, BUFFERS)',
    lookFor: [
      'RECALL FIRST: compare the returned ids against an exact scan with the index disabled (SET enable_indexscan = off). ANN results are approximate — a faster query that returns different neighbours is not an optimisation.',
      'Whether an Index Scan using an HNSW/IVFFlat index was chosen.',
      'ef_search / ivfflat.probes in effect — these trade recall for latency.',
    ],
    stats: ["SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '<table>';"],
  },
  timescaledb: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN (ANALYZE, BUFFERS)',
    lookFor: [
      'Chunks excluded — a missing time predicate reads every chunk.',
      'Whether a continuous aggregate was used, and whether its lag is acceptable.',
    ],
  },
  prometheus: {
    plan: '-- Use the query stats endpoint: /api/v1/query?stats=all',
    lookFor: ['Series touched and samples scanned.', 'Whether a recording rule matches the expression exactly.'],
  },
  duckdb: { plan: 'EXPLAIN', measure: 'EXPLAIN ANALYZE', lookFor: ['Rows scanned per operator.', 'Whether projection and filter pushdown reached the Parquet reader.'] },
}

const MORE: Record<string, Partial<ExplainRecipe>> = {
  firestore: {
    plan: '-- The console shows a query explain; the SDK exposes ExplainOptions.',
    measure: '-- Check readOps in the usage dashboard; offset pagination bills for skipped documents.',
    lookFor: ['Index used versus a composite-index error.', 'Documents read versus documents returned.'],
  },
  cosmosdb: {
    plan: '-- Inspect the query metrics header on the response.',
    measure: '-- x-ms-request-charge on the response gives RUs consumed.',
    lookFor: ['Request charge in RUs.', 'Whether the query fanned out across partitions.'],
  },
  couchdb: {
    plan: 'POST /<db>/_explain',
    lookFor: ['Which index was chosen, or whether it fell back to a full scan.'],
  },
  memcached: {
    plan: '-- No planner. Count round trips.',
    measure: 'stats  /  stats items',
    lookFor: ['get_hits versus get_misses.', 'Round trips saved by multi-get.'],
  },
  etcd: {
    plan: '-- No planner.',
    measure: 'etcdctl check perf',
    lookFor: ['Range size returned.', 'Whether a revision was pinned (a snapshot read).'],
  },
  hazelcast: { plan: 'EXPLAIN', lookFor: ['Whether an index was used or the map was scanned in full.'] },
  ignite: { plan: 'EXPLAIN', lookFor: ['Whether affinity colocation avoided a network hop.'] },
  opensearch: {
    plan: '-- Add "profile": true to the search body',
    measure: 'GET /<index>/_search?profile=true',
    lookFor: ['Time per query component.', 'filter context versus must — filter is cacheable and unscored.'],
  },
  solr: {
    plan: '&debugQuery=true',
    lookFor: ['timing section per component.', 'Whether the clause moved to fq, which removes its scoring contribution.'],
  },
  pinecone: {
    plan: '-- No planner. Compare returned ids against an exhaustive search.',
    measure: '-- Recall at fixed topK first, then latency.',
    lookFor: ['Overlap with an exact search — this is the number that regresses silently.', 'Whether metadata filtering ran before or after the search.'],
  },
  weaviate: {
    plan: '-- Compare results at different ef values against an exact search.',
    measure: '-- Recall first, then latency at that recall.',
    lookFor: ['Recall versus ef.', 'Hybrid search alpha, which changes ranking.'],
  },
  qdrant: {
    plan: '-- Set exact: true to obtain the ground truth, then compare.',
    measure: '-- Recall against exact search, then latency at fixed hnsw_ef.',
    lookFor: ['Recall versus hnsw_ef.', 'Whether a payload index made filtering cheap without changing matches.'],
  },
  milvus: {
    plan: '-- Compare against a FLAT index for ground truth.',
    measure: '-- Recall at fixed nprobe, then latency.',
    lookFor: ['Recall versus nprobe.', 'Index type — changing IVF to HNSW changes results.'],
  },
  chroma: {
    plan: '-- Compare against an exhaustive query for ground truth.',
    measure: '-- Recall first, then latency.',
    lookFor: ['Overlap with exact results.', 'Whether metadata filtering was applied pre- or post-search.'],
  },
  faiss: {
    plan: '-- Compare against IndexFlat, which is exact.',
    measure: '-- Recall at fixed nprobe/efSearch, then latency.',
    lookFor: ['Recall against IndexFlat.', 'Whether the index type itself changed.'],
  },
  scylla: { plan: 'TRACING ON;', lookFor: ['Partitions and shards touched.', 'Any ALLOW FILTERING scan.'] },
  bigtable: {
    plan: '-- No planner. Inspect the row range being read.',
    measure: '-- Rows scanned versus rows returned.',
    lookFor: ['Whether the row-key prefix bounds the scan.'],
  },
  neptune: {
    plan: '-- Gremlin: .explain()   SPARQL: use the explain endpoint',
    measure: '-- Gremlin: .profile()',
    lookFor: ['Traversers created per step.', 'Whether an index seek started the traversal.'],
  },
  arangodb: {
    plan: 'EXPLAIN',
    measure: '-- db._profileQuery(...)',
    lookFor: ['Whether an index was used.', 'Traversal depth and the number of paths enumerated.'],
  },
  influxdb: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN ANALYZE',
    lookFor: ['Series and points scanned.', 'Whether filters were pushed down before aggregation.'],
  },
  druid: {
    plan: 'EXPLAIN PLAN FOR',
    lookFor: ['Segments scanned versus pruned by the time interval.'],
  },
  questdb: { plan: 'EXPLAIN', lookFor: ['Whether the designated timestamp index was used.'] },
  realm: {
    plan: '-- No planner. Realm results are lazy.',
    measure: '-- Measure objects materialised, not the query call itself.',
    lookFor: ['Whether an index-backed property was used in the predicate.'],
  },
  rocksdb: {
    plan: '-- No planner. Inspect the iterator bounds.',
    measure: 'statistics: rocksdb.number.db.seek / rocksdb.number.db.next',
    lookFor: ['Seeks versus nexts — a prefix seek should replace a long scan.'],
  },
  tinydb: {
    plan: '-- No planner. These stores scan in full.',
    measure: '-- Count how many times the store is loaded per request.',
    lookFor: ['Repeated full loads inside a loop.'],
  },
  mariadb: {
    plan: 'EXPLAIN',
    measure: 'ANALYZE FORMAT=JSON',
    lookFor: ['r_rows versus rows — actual against estimated.', 'Whether a filesort or temporary table appeared.'],
  },
  db2: { plan: 'EXPLAIN PLAN FOR', lookFor: ['Access path: table scan versus index scan.'] },
  cockroachdb: {
    plan: 'EXPLAIN',
    measure: 'EXPLAIN ANALYZE (DISTSQL)',
    lookFor: ['Network rows and ranges touched.', 'Whether the query stayed on one node.'],
  },
  tidb: { plan: 'EXPLAIN', measure: 'EXPLAIN ANALYZE', lookFor: ['Coprocessor tasks and rows scanned.', 'Whether the predicate was pushed down to TiKV.'] },
  yugabyte: { plan: 'EXPLAIN', measure: 'EXPLAIN (ANALYZE, DIST)', lookFor: ['Storage read requests — round trips to the tablet servers.'] },
  spanner: {
    plan: '-- Use the query plan tab, or ANALYZE in the client libraries.',
    lookFor: ['Rows scanned versus returned.', 'Whether the read was strong or stale — stale reads are not equivalent.'],
  },
  vitess: { plan: 'EXPLAIN', lookFor: ['Whether the query targeted one shard or scattered to all of them.'] },
  synapse: { plan: 'EXPLAIN', lookFor: ['Data movement operations — shuffles dominate the cost.'] },
  athena: {
    plan: 'EXPLAIN',
    lookFor: ['Data scanned in the query statistics — that is the bill.', 'Whether partition projection applied.'],
  },
  redshift: {
    plan: 'EXPLAIN',
    measure: '-- Then inspect SVL_QUERY_REPORT / STL_ALERT_EVENT_LOG',
    lookFor: ['DS_BCAST_INNER or DS_DIST_BOTH — redistribution is the expensive part.', 'Rows scanned per slice.'],
  },
  databricks: { plan: 'EXPLAIN FORMATTED', lookFor: ['Files pruned by Delta file skipping.', 'Join strategy chosen.'] },
  impala: { plan: 'EXPLAIN', measure: 'PROFILE', lookFor: ['Partitions read.', 'Whether table statistics are stale.'] },
  trino: { plan: 'EXPLAIN', measure: 'EXPLAIN ANALYZE', lookFor: ['Rows and bytes per stage.', 'Whether predicate pushdown reached the connector.'] },
  hbase: {
    plan: '-- No planner. Inspect the Scan start/stop rows.',
    measure: '-- Rows scanned versus returned; use the region server metrics.',
    lookFor: ['Whether the scan is bounded by a row-key range.'],
  },
  hadoop: {
    plan: '-- Inspect the job counters.',
    measure: '-- MAP_INPUT_RECORDS / REDUCE_INPUT_RECORDS',
    lookFor: ['Whether a combiner reduced the shuffle volume.'],
  },
  objectdb: { plan: 'EXPLAIN', lookFor: ['Whether a fetch join avoided lazy-loading round trips.'] },
  sqlite: { plan: 'EXPLAIN QUERY PLAN', lookFor: ['SCAN versus SEARCH — SEARCH means an index was used.'] },
  unknown: {
    plan: 'EXPLAIN',
    lookFor: ['The engine could not be identified with confidence — confirm the dialect before running this.'],
  },
}

export function explainFor(engineId: string, family: DbFamily): ExplainRecipe {
  const base = FAMILY_DEFAULT[family]
  const over = OVERRIDES[engineId] ?? MORE[engineId]
  return over ? { ...base, ...over } : base
}

/**
 * The recipe for a *claim*, not just for an engine.
 *
 * `explainFor` answers "how do I get a plan on this store?", and for five of
 * the fifteen finding categories that is the wrong question — a plan cannot
 * settle a claim about plan reuse, connection occupancy, transaction age or
 * index usage. `overlayFor` supplies the instrument that can; this merges it
 * over the engine recipe.
 *
 * When the overlay sets `replacesPlan`, the EXPLAIN commands are dropped rather
 * than shown beside it. Offering both invites the reader to run the one that
 * cannot answer the question, get a healthy-looking plan, and conclude the
 * finding was wrong.
 */
export interface ClaimRecipe extends ExplainRecipe {
  /** The single metric under test, when the category names one. */
  measures?: string
  /**
   * The claim-specific command for the current code, and for the rewrite when
   * it differs. Carried on the recipe rather than left on the overlay so that
   * one call to `recipeFor` is the whole answer — a caller that has to consult
   * `overlayFor` separately for the commands is two sources that will drift.
   */
  claimCommandOriginal?: string
  claimCommandProposed?: string
  /** Evidence consistent with the claim. */
  confirms: string[]
  /** Evidence that kills it. Empty only when no overlay applies. */
  refutes: string[]
  /** True when the category's instrument is not a query plan at all. */
  replacesPlan: boolean
  /** Set when nothing better than the family default was available. */
  noRecipeReason?: string
}

export function recipeFor(
  engineId: string,
  family: DbFamily,
  category: FindingCategory,
): ClaimRecipe {
  const base = explainFor(engineId, family)
  const overlay = overlayFor(category, engineId, family)

  if (!overlay) {
    return {
      ...base,
      confirms: [],
      refutes: [],
      replacesPlan: false,
      // Stated rather than left to look like a considered choice. A reader who
      // knows the recipe is generic can weigh it accordingly; one who assumes
      // it was chosen for this claim cannot.
      noRecipeReason:
        `No verification recipe specific to a "${category}" claim on ${engineId}. ` +
        'The plan below is the general one for this engine, and may not test the mechanism this finding argues for.',
    }
  }

  return {
    ...base,
    // The overlay's commands win where it supplies them; `replacesPlan` blanks
    // the generic ones entirely.
    plan: overlay.replacesPlan ? '' : base.plan,
    measure: overlay.replacesPlan ? undefined : base.measure,
    // Overlay stats first: they are the ones chosen for this claim.
    stats: [...(overlay.stats ?? []), ...(base.stats ?? [])],
    // Overlay `lookFor` leads, and the engine's general advice follows only when
    // a plan is still part of the answer.
    lookFor: overlay.replacesPlan
      ? [overlay.measures, ...overlay.confirms]
      : [overlay.measures, ...overlay.confirms, ...base.lookFor],
    measures: overlay.measures,
    claimCommandOriginal: overlay.commandOriginal,
    claimCommandProposed: overlay.commandProposed,
    confirms: overlay.confirms,
    refutes: overlay.refutes,
    replacesPlan: overlay.replacesPlan === true,
  }
}
