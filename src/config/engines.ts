/**
 * The database engine registry.
 *
 * speeDB is not a SQL tool — "query" here means any request sent to a data
 * store, and the equivalence promise has to survive engines whose semantics are
 * nothing like a relational SELECT. That is why each entry carries an
 * `equivalenceNotes` string: it is injected into the analysis prompt so the
 * model argues equivalence in the terms that engine actually guarantees.
 *
 * A vector search is the sharpest example. Changing `ef_search` or `nprobe`
 * changes *recall*, so two ANN queries that "look equivalent" routinely return
 * different neighbours. Any such change must be classified behaviour-changing.
 */

export type DbFamily =
  | 'rdbms'
  | 'warehouse'
  | 'bigdata'
  | 'document'
  | 'wide-column'
  | 'key-value'
  | 'graph'
  | 'search'
  | 'vector'
  | 'timeseries'
  | 'object-embedded'
  | 'distributed-sql'

export interface FamilySpec {
  id: DbFamily
  label: string
  /** Shown in the report's group headers and the engine filter. */
  blurb: string
}

export const FAMILIES: FamilySpec[] = [
  { id: 'rdbms', label: 'Relational', blurb: 'Classic RDBMS — rows, joins, planners, indexes.' },
  { id: 'distributed-sql', label: 'Distributed SQL', blurb: 'NewSQL: SQL surface, sharded storage, cross-region latency.' },
  { id: 'warehouse', label: 'Cloud warehouse', blurb: 'Columnar analytics billed by bytes scanned or compute seconds.' },
  { id: 'bigdata', label: 'Big data / Hadoop', blurb: 'Query engines over distributed file systems.' },
  { id: 'document', label: 'Document', blurb: 'JSON/BSON documents, aggregation pipelines.' },
  { id: 'wide-column', label: 'Wide column', blurb: 'Partition key first — the access pattern is the schema.' },
  { id: 'key-value', label: 'Key-value / In-memory', blurb: 'Single-digit-ms lookups; the risk is round trips and full keyspace scans.' },
  { id: 'graph', label: 'Graph', blurb: 'Traversals where the cost is in path expansion.' },
  { id: 'search', label: 'Search', blurb: 'Inverted indexes, relevance scoring, aggregations.' },
  { id: 'vector', label: 'Vector', blurb: 'Approximate nearest neighbour — accuracy is a tunable, not a given.' },
  { id: 'timeseries', label: 'Time series', blurb: 'Append-heavy, time-partitioned, downsampled.' },
  { id: 'object-embedded', label: 'Object / embedded', blurb: 'In-process stores; the query is a method call.' },
]

export interface EngineSpec {
  id: string
  label: string
  family: DbFamily
  /** The query language the model should write its rewrite in. */
  language: string
  /** Engine-specific equivalence semantics, injected into the prompt. */
  equivalenceNotes: string
}

/**
 * `equivalenceNotes` is the part that earns its keep. It is what stops the
 * model applying relational intuitions to a store that does not share them.
 */
export const ENGINES: EngineSpec[] = [
  /* -------------------------------------------------------------- rdbms -- */
  { id: 'postgres', label: 'PostgreSQL', family: 'rdbms', language: 'SQL',
    equivalenceNotes: 'Without ORDER BY there is no row order guarantee, so never add or remove one and call it equivalent. NULL comparisons yield NULL, not false. DISTINCT and GROUP BY treat NULLs as equal; = does not.' },
  { id: 'mysql', label: 'MySQL', family: 'rdbms', language: 'SQL',
    equivalenceNotes: 'Watch implicit type coercion in comparisons — it silently defeats indexes and can change matching. ONLY_FULL_GROUP_BY may be off, so a non-aggregated column in GROUP BY returns an arbitrary row.' },
  { id: 'mariadb', label: 'MariaDB', family: 'rdbms', language: 'SQL',
    equivalenceNotes: 'As MySQL. Optimiser hints and index usage differ from MySQL in places; do not assume a MySQL plan.' },
  { id: 'mssql', label: 'SQL Server', family: 'rdbms', language: 'T-SQL',
    equivalenceNotes: 'TOP without ORDER BY is non-deterministic. NOLOCK changes isolation and can read uncommitted rows — never introduce or remove it as an "optimisation".' },
  { id: 'oracle', label: 'Oracle', family: 'rdbms', language: 'PL/SQL',
    equivalenceNotes: 'Oracle treats the empty string as NULL. ROWNUM is applied before ORDER BY unless wrapped in a subquery.' },
  { id: 'sqlite', label: 'SQLite', family: 'rdbms', language: 'SQL',
    equivalenceNotes: 'Dynamic typing means comparisons depend on storage class. Without ORDER BY, order follows the chosen index and is not stable.' },
  { id: 'db2', label: 'Db2', family: 'rdbms', language: 'SQL', equivalenceNotes: 'Standard SQL semantics; FETCH FIRST without ORDER BY is non-deterministic.' },

  /* ----------------------------------------------------- distributed sql -- */
  { id: 'cockroachdb', label: 'CockroachDB', family: 'distributed-sql', language: 'SQL',
    equivalenceNotes: 'Postgres wire-compatible, but a query touching many ranges costs network hops. AS OF SYSTEM TIME changes which snapshot is read — never equivalent.' },
  { id: 'tidb', label: 'TiDB', family: 'distributed-sql', language: 'SQL', equivalenceNotes: 'MySQL-compatible surface over distributed storage; coprocessor pushdown determines whether a predicate is cheap.' },
  { id: 'yugabyte', label: 'YugabyteDB', family: 'distributed-sql', language: 'SQL', equivalenceNotes: 'Postgres-compatible; the primary key determines tablet distribution, so key order affects scan cost, not results.' },
  { id: 'spanner', label: 'Cloud Spanner', family: 'distributed-sql', language: 'GoogleSQL',
    equivalenceNotes: 'Interleaved tables and split points drive cost. Stale reads return older data and are never output-equivalent to strong reads.' },
  { id: 'vitess', label: 'Vitess', family: 'distributed-sql', language: 'SQL', equivalenceNotes: 'A query without the sharding key scatters to every shard; adding the key changes cost, and only preserves output if it is genuinely implied by the existing predicates.' },

  /* ---------------------------------------------------------- warehouse -- */
  { id: 'snowflake', label: 'Snowflake', family: 'warehouse', language: 'Snowflake SQL',
    equivalenceNotes: 'Cost is credits, driven by partitions scanned. Pruning via clustering keys does not change results. QUALIFY is applied after window functions. Beware SAMPLE — it changes output.' },
  { id: 'bigquery', label: 'BigQuery', family: 'warehouse', language: 'GoogleSQL',
    equivalenceNotes: 'Billing is bytes scanned, so SELECT * over a wide table is the dominant cost. Partition and cluster pruning is output-neutral; TABLESAMPLE is not.' },
  { id: 'redshift', label: 'Redshift', family: 'warehouse', language: 'SQL',
    equivalenceNotes: 'DISTKEY/SORTKEY choice governs redistribution cost. A DIST-style change is output-neutral; changing a join type is not.' },
  { id: 'synapse', label: 'Azure Synapse', family: 'warehouse', language: 'T-SQL', equivalenceNotes: 'Distribution strategy drives shuffle cost; results are unaffected by distribution alone.' },
  { id: 'databricks', label: 'Databricks SQL', family: 'warehouse', language: 'Spark SQL',
    equivalenceNotes: 'Delta file skipping and Z-ORDER are output-neutral. Changing the number of shuffle partitions is too. Broadcast hints are output-neutral.' },
  { id: 'athena', label: 'Athena', family: 'warehouse', language: 'Trino SQL', equivalenceNotes: 'Billed by bytes scanned from S3; partition projection and columnar formats reduce cost without changing rows.' },
  { id: 'clickhouse', label: 'ClickHouse', family: 'warehouse', language: 'ClickHouse SQL',
    equivalenceNotes: 'PREWHERE is output-neutral versus WHERE. FINAL changes which rows are returned for ReplacingMergeTree — never treat adding or removing it as equivalent.' },

  /* ------------------------------------------------------------ bigdata -- */
  { id: 'hive', label: 'Hive', family: 'bigdata', language: 'HiveQL',
    equivalenceNotes: 'Partition pruning is output-neutral. A missing partition predicate causes a full-table scan. ORDER BY is global and single-reducer; SORT BY is per-reducer and NOT equivalent to it.' },
  { id: 'spark', label: 'Spark SQL', family: 'bigdata', language: 'Spark SQL',
    equivalenceNotes: 'repartition/coalesce and broadcast hints are output-neutral. Caching is output-neutral. Changing a join to a broadcast join preserves results; changing join type does not.' },
  { id: 'trino', label: 'Trino / Presto', family: 'bigdata', language: 'Trino SQL', equivalenceNotes: 'Predicate and projection pushdown into the connector are output-neutral; dynamic filtering is too.' },
  { id: 'impala', label: 'Impala', family: 'bigdata', language: 'SQL', equivalenceNotes: 'Stale table statistics change plans, not results. Partition pruning is output-neutral.' },
  { id: 'hbase', label: 'HBase', family: 'bigdata', language: 'HBase API',
    equivalenceNotes: 'A Scan without a start/stop row is a full-table scan. Narrowing to a row-key range only preserves output if the range provably covers every matching row.' },
  { id: 'hadoop', label: 'Hadoop / MapReduce', family: 'bigdata', language: 'MapReduce', equivalenceNotes: 'Combiners are output-neutral only when the reduce function is commutative and associative.' },

  /* ----------------------------------------------------------- document -- */
  { id: 'mongodb', label: 'MongoDB', family: 'document', language: 'MQL / aggregation pipeline',
    equivalenceNotes: 'Without an explicit $sort, document order is not guaranteed. Moving $match before $lookup or $project is output-neutral and usually a large win. $limit before $sort changes results; after $sort it does not. Missing fields and null are distinct in MQL.' },
  { id: 'couchdb', label: 'CouchDB', family: 'document', language: 'Mango / MapReduce views',
    equivalenceNotes: 'View results are ordered by key. A Mango query without a matching index falls back to a full scan.' },
  { id: 'dynamodb', label: 'DynamoDB', family: 'document', language: 'DynamoDB API / PartiQL',
    equivalenceNotes: 'Scan reads the whole table; Query needs a partition key. Converting Scan to Query is only equivalent if the filter provably implies the partition key. ConsistentRead changes which data is visible.' },
  { id: 'firestore', label: 'Firestore', family: 'document', language: 'Firestore API',
    equivalenceNotes: 'Every compound query needs a composite index. Cursor pagination and offset pagination return the same documents but offset is billed for skipped reads.' },
  { id: 'cosmosdb', label: 'Cosmos DB', family: 'document', language: 'Cosmos SQL',
    equivalenceNotes: 'Cost is RU/s and driven by cross-partition fan-out. Adding the partition key to a filter is only equivalent if already implied.' },

  /* -------------------------------------------------------- wide column -- */
  { id: 'cassandra', label: 'Cassandra', family: 'wide-column', language: 'CQL',
    equivalenceNotes: 'ALLOW FILTERING signals a scatter-gather scan. Clustering column order defines result order — do not assume it. Queries must be driven by the partition key; secondary indexes are usually a trap.' },
  { id: 'scylla', label: 'ScyllaDB', family: 'wide-column', language: 'CQL', equivalenceNotes: 'As Cassandra: partition key drives access, ALLOW FILTERING means a scan, and shard-aware routing changes latency but never the rows returned.' },
  { id: 'bigtable', label: 'Bigtable', family: 'wide-column', language: 'Bigtable API', equivalenceNotes: 'Row-key prefix design governs everything. Narrowing a row range preserves output only if it provably covers all matches.' },

  /* --------------------------------------------------------- key-value -- */
  { id: 'redis', label: 'Redis', family: 'key-value', language: 'Redis commands',
    equivalenceNotes: 'KEYS blocks the server and must become SCAN — but SCAN gives no snapshot guarantee, so that swap is behaviour-changing under concurrent writes. Pipelining and MGET are output-neutral. SCAN may return duplicates.' },
  { id: 'memcached', label: 'Memcached', family: 'key-value', language: 'Memcached commands', equivalenceNotes: 'Multi-get is output-neutral versus sequential gets, absent concurrent invalidation.' },
  { id: 'etcd', label: 'etcd', family: 'key-value', language: 'etcd API', equivalenceNotes: 'Range reads with a revision are snapshot reads; dropping the revision is not equivalent.' },
  { id: 'hazelcast', label: 'Hazelcast', family: 'key-value', language: 'Predicate API / SQL', equivalenceNotes: 'Indexed predicates avoid a full map scan without changing the entry set.' },
  { id: 'ignite', label: 'Apache Ignite', family: 'key-value', language: 'SQL', equivalenceNotes: 'Affinity colocation removes network hops in joins without changing results.' },

  /* -------------------------------------------------------------- graph -- */
  { id: 'neo4j', label: 'Neo4j', family: 'graph', language: 'Cypher',
    equivalenceNotes: 'An unbounded variable-length path can explode combinatorially. Bounding it changes results unless the bound provably exceeds the longest matching path. Cypher returns paths, so duplicate rows depend on the traversal.' },
  { id: 'neptune', label: 'Neptune', family: 'graph', language: 'Gremlin / SPARQL', equivalenceNotes: 'Step order in Gremlin governs how early the traversal is filtered; filtering earlier is output-neutral.' },
  { id: 'arangodb', label: 'ArangoDB', family: 'graph', language: 'AQL', equivalenceNotes: 'Traversal depth bounds change the result set. Index hints do not.' },

  /* ------------------------------------------------------------- search -- */
  { id: 'elasticsearch', label: 'Elasticsearch', family: 'search', language: 'Query DSL',
    equivalenceNotes: 'A filter context clause is cacheable and does not score; moving a clause from must to filter changes _score and therefore result ORDER unless an explicit sort is set. Deep from/size pagination and search_after return the same hits in the same order.' },
  { id: 'opensearch', label: 'OpenSearch', family: 'search', language: 'Query DSL', equivalenceNotes: 'As Elasticsearch: filter context does not score, so moving a clause out of must changes _score and therefore result order unless an explicit sort is set.' },
  { id: 'solr', label: 'Solr', family: 'search', language: 'Solr query', equivalenceNotes: 'fq clauses are filter-only and cached; moving a clause from q to fq removes its scoring contribution and can reorder results.' },

  /* ------------------------------------------------------------- vector -- */
  { id: 'pgvector', label: 'pgvector', family: 'vector', language: 'SQL',
    equivalenceNotes: 'CRITICAL: with an HNSW or IVFFlat index the search is APPROXIMATE. Changing ef_search, probes, or adding/removing the index changes which neighbours are returned. Only exact (sequential-scan) searches are output-deterministic. Treat any recall-affecting change as behaviour-changing.' },
  { id: 'pinecone', label: 'Pinecone', family: 'vector', language: 'Pinecone API',
    equivalenceNotes: 'ANN results are approximate. Changing topK, filters, or namespace changes the returned set. Metadata filtering applied pre- vs post-search yields different results.' },
  { id: 'weaviate', label: 'Weaviate', family: 'vector', language: 'GraphQL / GraphQL-like',
    equivalenceNotes: 'ANN parameters (ef) trade recall for latency — never output-equivalent. Hybrid search alpha changes ranking.' },
  { id: 'qdrant', label: 'Qdrant', family: 'vector', language: 'Qdrant API',
    equivalenceNotes: 'hnsw_ef and exact=true/false directly control recall. Payload index changes filter speed without changing matches, and that IS output-neutral.' },
  { id: 'milvus', label: 'Milvus', family: 'vector', language: 'Milvus API', equivalenceNotes: 'nprobe/ef govern recall. Index type changes (IVF vs HNSW) change results.' },
  { id: 'chroma', label: 'Chroma', family: 'vector', language: 'Chroma API', equivalenceNotes: 'ANN results are approximate; metadata pre-filtering is output-neutral relative to equivalent post-filtering only when the filter is exact.' },
  { id: 'faiss', label: 'FAISS', family: 'vector', language: 'FAISS API', equivalenceNotes: 'IndexFlat is exact; every IVF/HNSW variant is approximate and its parameters change results.' },

  /* --------------------------------------------------------- timeseries -- */
  { id: 'influxdb', label: 'InfluxDB', family: 'timeseries', language: 'Flux / InfluxQL',
    equivalenceNotes: 'A missing time range scans all retention. Narrowing the range changes results unless the range provably covers all matching points. Pushdown of filter() before aggregation is output-neutral.' },
  { id: 'timescaledb', label: 'TimescaleDB', family: 'timeseries', language: 'SQL',
    equivalenceNotes: 'Chunk exclusion needs a time predicate on the partitioning column. Continuous aggregates may lag real-time data, so reading one instead of the hypertable is NOT output-equivalent.' },
  { id: 'prometheus', label: 'Prometheus', family: 'timeseries', language: 'PromQL',
    equivalenceNotes: 'Range selectors and rate() windows change values. Recording rules pre-compute the same expression and are output-equivalent only if the rule matches the query exactly.' },
  { id: 'druid', label: 'Apache Druid', family: 'timeseries', language: 'Druid SQL', equivalenceNotes: 'Time-interval filters drive segment pruning and are output-neutral when the interval covers all matches.' },
  { id: 'questdb', label: 'QuestDB', family: 'timeseries', language: 'SQL', equivalenceNotes: 'Designated timestamp ordering makes some queries cheap; SAMPLE BY changes aggregation granularity and results.' },

  /* --------------------------------------------------- object / embedded -- */
  { id: 'objectdb', label: 'ObjectDB', family: 'object-embedded', language: 'JPQL / JDOQL',
    equivalenceNotes: 'JPQL semantics: fetch joins avoid lazy-loading round trips without changing the entity graph returned.' },
  { id: 'realm', label: 'Realm', family: 'object-embedded', language: 'Realm query', equivalenceNotes: 'Results are live and lazily evaluated; adding a limit changes what is materialised, not what matches.' },
  { id: 'duckdb', label: 'DuckDB', family: 'object-embedded', language: 'SQL', equivalenceNotes: 'Columnar and vectorised; projection pushdown is output-neutral. Reading Parquet directly avoids a copy without changing rows.' },
  { id: 'rocksdb', label: 'RocksDB / LevelDB', family: 'object-embedded', language: 'KV API', equivalenceNotes: 'Iterator bounds change the scanned range; prefix seeks preserve output when the prefix covers all matches.' },
  { id: 'tinydb', label: 'TinyDB / shelve', family: 'object-embedded', language: 'Python API', equivalenceNotes: 'Whole-store scans in Python; caching the loaded table is output-neutral within a single read.' },

  /* ------------------------------------------------------------ unknown -- */
  { id: 'unknown', label: 'Unidentified', family: 'rdbms', language: 'SQL',
    equivalenceNotes: 'Engine could not be identified with confidence. State the dialect assumption explicitly in the assumptions list.' },
]

const BY_ID = new Map(ENGINES.map((e) => [e.id, e]))

export function engineSpec(id: string): EngineSpec {
  return BY_ID.get(id) ?? BY_ID.get('unknown')!
}

export function engineLabel(id: string): string {
  return engineSpec(id).label
}

export function familyLabel(id: DbFamily): string {
  return FAMILIES.find((f) => f.id === id)?.label ?? id
}

/** Engines actually present in a report, used to build the prompt's notes block. */
export function equivalenceNotesFor(engineIds: string[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const id of engineIds) {
    const spec = engineSpec(id)
    if (seen.has(spec.id)) continue
    seen.add(spec.id)
    lines.push(`- **${spec.label}** (${spec.language}): ${spec.equivalenceNotes}`)
  }
  return lines.join('\n')
}
