import type { AccessStyle, DbEngine } from '@/core/types'

export interface DetectRule {
  name: string
  pattern: RegExp
  engine: DbEngine
  accessStyle: AccessStyle
  confidence: number
  /** Restrict to these file extensions when the signal is language-specific. */
  extensions?: string[]
  /**
   * Where this rule is allowed to match. Default `'code-and-strings'`.
   *
   * Detection used to run on raw bytes, so `# TODO: migrate to opensearch` in a
   * comment set the engine label for the whole span it sat in, and commented-out
   * code produced candidates for code that no longer runs. *Comments are now
   * masked for every rule* — that is not optional and there is no opt-out,
   * because a comment is never a query.
   *
   * String bodies are a different question. A SQL, CQL or Cypher statement
   * lives inside a string literal by definition, so masking strings would
   * blind almost every dialect rule — hence the default. `'code'` is the
   * opt-in for rules that match a bare engine *name*, where a string body is
   * never the signal and prose like "we should move this to Athena" is a false
   * positive waiting to happen.
   */
  scope?: 'code' | 'code-and-strings'
}

const SQL_VERBS = String.raw`SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH\s+[\w"]+\s+AS|MERGE\s+INTO|UPSERT\s+INTO`
const SQL_VERBS_SRC = SQL_VERBS

/** Every mainstream language we can attribute a query site to. */
export const JS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'svelte', 'vue']
export const PY = ['py', 'pyi', 'pyx', 'ipynb']
export const JVM = ['java', 'kt', 'kts', 'scala', 'groovy', 'clj', 'cljs']
export const DOTNET = ['cs', 'fs', 'vb']
export const NATIVE = ['go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'm', 'mm', 'zig']
export const DYNAMIC = ['rb', 'php', 'pl', 'lua', 'ex', 'exs', 'erl', 'dart', 'r', 'jl']
export const ALL_CODE = [...JS, ...PY, ...JVM, ...DOTNET, ...NATIVE, ...DYNAMIC]

/**
 * Detection rules.
 *
 * Precision beats recall here: a false positive spends tokens on the analysis
 * stage, while a near-miss is usually recovered by the context lines around a
 * neighbouring hit. Rules that name an engine outrank generic ones when spans
 * merge, which is how a `$vector`-flavoured hit wins over plain `raw-sql`.
 */
export const RULES: DetectRule[] = [
  /* =============================================================== SQL == */
  {
    name: 'sql-in-string-literal',
    // A SQL verb inside any quote style, including template literals and
    // Python triple-quotes. The trailing clause lookahead is what keeps this
    // from firing on prose like "select a plan".
    pattern: new RegExp(
      String.raw`(?:"""|'''|\x60|"|')\s*(?:${SQL_VERBS})\b[\s\S]{0,1500}?(?:FROM|INTO|SET|VALUES|WHERE)\b`,
      'gi',
    ),
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.75,
  },
  {
    name: 'sql-file',
    pattern: new RegExp(
      String.raw`(?:${SQL_VERBS}|CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|MATERIALIZED\s+VIEW)|ALTER\s+TABLE)\b`, 'gi'),
    engine: 'unknown', accessStyle: 'ddl-migration', confidence: 0.95,
    extensions: ['sql', 'ddl', 'psql'],
  },
  { name: 'postgres-placeholder', pattern: /(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,600}?\$\d+/gi,
    engine: 'postgres', accessStyle: 'raw-sql', confidence: 0.85 },
  {
    name: 'postgres-dialect',
    // Case-sensitive on the keyword half, and deliberately so. `RETURNING`,
    // `ON CONFLICT`, `ILIKE` and `LATERAL JOIN` are all ordinary English in
    // lower case — "a returning browser", "probes connect by IP" — and matching
    // them case-insensitively labelled prose in docstrings and changelogs as
    // Postgres. SQL keywords are conventionally upper case; a lower-case query
    // is still detected by the rules that find the statement, it just takes its
    // engine from the repository profile instead, which is the better evidence
    // anyway. The punctuation and identifier forms stay case-insensitive
    // because no English sentence contains them.
    pattern: new RegExp(
      // `::int[]` has no letters to case, and `jsonb_` functions are lower
      // case by Postgres convention, so both are safe without a flag. V8 has no
      // inline `(?i:…)` group, which is why this is split by hand.
      String.raw`\bON\s+CONFLICT\b|\bRETURNING\s+[\w"*]+|\bILIKE\b|\bLATERAL\s+JOIN\b` +
      String.raw`|::\w+\[\]|\bjsonb_\w+`,
      'g',
    ),
    engine: 'postgres', accessStyle: 'raw-sql', confidence: 0.8,
  },
  { name: 'mysql-dialect', pattern: /\b(?:ON\s+DUPLICATE\s+KEY\s+UPDATE|STRAIGHT_JOIN|SQL_CALC_FOUND_ROWS|GROUP_CONCAT)\b/g,
    engine: 'mysql', accessStyle: 'raw-sql', confidence: 0.85 },
  { name: 'mssql-dialect', pattern: /\bSELECT\s+TOP\s+\d+|WITH\s*\(\s*NOLOCK\s*\)|OPTION\s*\(\s*RECOMPILE|\bOUTPUT\s+INSERTED\b/gi,
    engine: 'mssql', accessStyle: 'raw-sql', confidence: 0.85 },
  // Case-sensitive: "connect by", "dual" and "merge into" are all English.
  { name: 'oracle-dialect', pattern: /\bROWNUM\b|\bCONNECT\s+BY\b|\bDUAL\b|\bNVL\s*\(|\bMERGE\s+INTO\s+\w+\s+USING\b/g,
    engine: 'oracle', accessStyle: 'raw-sql', confidence: 0.8 },
  { name: 'sqlite-dialect', pattern: /\bsqlite3?\s*\.\s*(?:connect|Database)\s*\(|\bPRAGMA\s+\w+/gi,
    engine: 'sqlite', accessStyle: 'raw-sql', confidence: 0.85 },

  /* ======================================================= warehouse == */
  { name: 'snowflake', pattern: /\bQUALIFY\b|\bLATERAL\s+FLATTEN\b|\bSNOWFLAKE\.ACCOUNT_USAGE\b|\bWAREHOUSE\s*=|\bCOPY\s+INTO\s+@|\bsnowflake\.connector\b/g,
    engine: 'snowflake', accessStyle: 'raw-sql', confidence: 0.9 },
  { name: 'bigquery', pattern: /\bbigquery\b|\bBigQueryClient\b|`[\w-]+\.[\w-]+\.[\w-]+`|_PARTITIONTIME|_TABLE_SUFFIX|\bTABLESAMPLE\s+SYSTEM\b/gi,
    engine: 'bigquery', accessStyle: 'raw-sql', confidence: 0.85 },
  { name: 'redshift', pattern: /\bDISTKEY\b|\bSORTKEY\b|\bDISTSTYLE\b|\bUNLOAD\s+\(|\bredshift\b/gi,
    engine: 'redshift', accessStyle: 'raw-sql', confidence: 0.85 },
  { name: 'synapse',
    scope: 'code', pattern: /\b(?:CREATE\s+TABLE\s+.*WITH\s*\(\s*DISTRIBUTION|synapse)\b/gi,
    engine: 'synapse', accessStyle: 'raw-sql', confidence: 0.8 },
  { name: 'databricks-delta', pattern: /\bOPTIMIZE\s+\w+\s+ZORDER\b|\bdelta\.`|\bDeltaTable\b|\bspark\.read\.format\(["']delta/gi,
    engine: 'databricks', accessStyle: 'raw-sql', confidence: 0.85 },
  { name: 'athena',
    scope: 'code', pattern: /\b(?:athena|start_query_execution|AwsDataCatalog)\b/gi,
    engine: 'athena', accessStyle: 'raw-sql', confidence: 0.8 },
  { name: 'clickhouse', pattern: /\bPREWHERE\b|\bMergeTree\b|\bSETTINGS\s+max_threads\b|\bclickhouse\b/g,
    engine: 'clickhouse', accessStyle: 'raw-sql', confidence: 0.9 },

  /* ================================================ big data / hadoop == */
  // Case-sensitive: "sort by" and "distribute by" are English phrases.
  { name: 'hive', pattern: /\bHiveContext\b|\bCREATE\s+EXTERNAL\s+TABLE\b|\bSTORED\s+AS\s+(?:PARQUET|ORC|TEXTFILE)\b|\bSORT\s+BY\b|\bDISTRIBUTE\s+BY\b|\bMSCK\s+REPAIR\b/g,
    engine: 'hive', accessStyle: 'raw-sql', confidence: 0.9 },
  { name: 'hive-file', pattern: /\b(?:SELECT|INSERT\s+OVERWRITE|CREATE\s+TABLE)\b/gi,
    engine: 'hive', accessStyle: 'raw-sql', confidence: 0.95, extensions: ['hql', 'q'] },
  { name: 'spark-sql', pattern: /\bspark\s*\.\s*sql\s*\(|\bsparkSession\s*\.\s*sql\s*\(|\.\s*(?:repartition|coalesce|broadcast|persist|cache)\s*\(|\bSparkSession\b/g,
    engine: 'spark', accessStyle: 'raw-sql', confidence: 0.85 },
  { name: 'spark-dataframe', pattern: /\bdf\s*\.\s*(?:select|filter|where|groupBy|join|withColumn|agg)\s*\(/g,
    engine: 'spark', accessStyle: 'query-builder', confidence: 0.75, extensions: [...PY, 'scala', 'java'] },
  { name: 'trino-presto',
    scope: 'code', pattern: /\b(?:trino|presto|prestodb)\b|\bcatalog\.schema\.table\b/gi,
    engine: 'trino', accessStyle: 'raw-sql', confidence: 0.8 },
  { name: 'impala',
    scope: 'code', pattern: /\b(?:impala|impyla)\b|\bCOMPUTE\s+STATS\b/gi,
    engine: 'impala', accessStyle: 'raw-sql', confidence: 0.8 },
  { name: 'hbase', pattern: /\bnew\s+Scan\s*\(|\bHTable\b|\bsetStartRow\b|\bsetStopRow\b|\bhappybase\b|\bGet\s*\(\s*Bytes\.toBytes/g,
    engine: 'hbase', accessStyle: 'kv-command', confidence: 0.85 },
  { name: 'mapreduce', pattern: /\bextends\s+(?:Mapper|Reducer)\s*<|\bsetCombinerClass\b|\bJobConf\b/g,
    engine: 'hadoop', accessStyle: 'map-reduce', confidence: 0.85, extensions: JVM },

  /* ====================================================== document == */
  {
    name: 'mongodb-pipeline',
    // A bare `.aggregate(` is not a Mongo signal: Django, SQLAlchemy and
    // ActiveRecord all define it, and because this rule outranked `django-orm`
    // on confidence, `Product.objects.aggregate(...)` in a Django project was
    // classified as a MongoDB aggregation pipeline. A pipeline is identified by
    // its stage operators, or by an aggregate call taking an array literal.
    pattern: /\$(?:lookup|unwind|match|group|facet|graphLookup|bucket|addFields|project|sortByCount|replaceRoot)\b|\.\s*aggregate\s*\(\s*\[/g,
    engine: 'mongodb', accessStyle: 'aggregation-pipeline', confidence: 0.8,
  },
  {
    name: 'mongodb-crud',
    // A bare `.find(` matches every Array.prototype.find in a TypeScript repo,
    // which was the largest single source of wasted tokens. Two constraints fix
    // it: the first argument must be a filter *document* (`{`) or a name that
    // reads like one, which excludes `arr.find(x => ...)`; and `find`/`findOne`
    // additionally need a collection-shaped receiver.
    pattern: new RegExp(
      String.raw`\b(?:db|database|mongo|mongoose|collection|coll|col|[A-Z]\w+)` +
      String.raw`(?:\s*\.\s*\w+)?\s*\.\s*` +
      String.raw`(?:find|findOne|findOneAndUpdate|findOneAndDelete|findOneAndReplace|` +
      String.raw`updateMany|updateOne|replaceOne|insertMany|insertOne|deleteMany|deleteOne|` +
      String.raw`countDocuments|estimatedDocumentCount|distinct|createIndex|bulkWrite)` +
      String.raw`\s*\(\s*(?:\{|filter\b|query\b|criteria\b|where\b|\))`,
      'g',
    ),
    engine: 'mongodb', accessStyle: 'orm', confidence: 0.8,
  },
  { name: 'mongoose', pattern: /\b(?:mongoose\s*\.\s*model|Schema\s*\(\s*\{|\.\s*populate\s*\(|\.\s*lean\s*\(\s*\))/g,
    engine: 'mongodb', accessStyle: 'orm', confidence: 0.85, extensions: JS },
  {
    name: 'dynamodb',
    // `TableName:` on its own matches any configuration object, so detection
    // hangs off the SDK's own vocabulary instead: command classes, client
    // names, and the expression keys that only DynamoDB uses.
    pattern: new RegExp(
      String.raw`\bnew\s+(?:Scan|Query|GetItem|PutItem|UpdateItem|DeleteItem|BatchGetItem|BatchWriteItem|TransactWriteItems|ExecuteStatement)Command\b` +
      String.raw`|\b(?:DynamoDBClient|DynamoDBDocumentClient|documentClient|docClient|dynamoDb|dynamodb)\b` +
      String.raw`|\b(?:KeyConditionExpression|FilterExpression|ProjectionExpression|ExpressionAttributeValues|ExpressionAttributeNames|ConsistentRead)\b`,
      'g',
    ),
    engine: 'dynamodb', accessStyle: 'rest-data-api', confidence: 0.9,
  },
  { name: 'firestore', pattern: /\b(?:firestore\s*\(\s*\)|collection\s*\(\s*["'][\w-]+["']\s*\)\s*\.\s*where|onSnapshot|FieldPath)\b/g,
    engine: 'firestore', accessStyle: 'rest-data-api', confidence: 0.85 },
  { name: 'cosmosdb', pattern: /\b(?:CosmosClient|RequestCharge|PartitionKey|EnableCrossPartitionQuery)\b/g,
    engine: 'cosmosdb', accessStyle: 'rest-data-api', confidence: 0.85 },
  { name: 'couchdb',
    scope: 'code', pattern: /\b(?:couchdb|Mango)\b|_design\/|\bselector\s*:\s*\{/gi,
    engine: 'couchdb', accessStyle: 'rest-data-api', confidence: 0.75 },

  /* =================================================== wide column == */
  {
    name: 'cassandra-cql',
    // "Allow filtering by TestRun ID" is a changelog entry, not CQL.
    pattern: new RegExp(
      String.raw`\bALLOW\s+FILTERING\b|\bUSING\s+TTL\b|\bSimpleStatement\b` +
      String.raw`|\b[Cc]assandra\b|\bexecute_concurrent\b`,
      'g',
    ),
    engine: 'cassandra', accessStyle: 'raw-sql', confidence: 0.9,
  },
  { name: 'cql-file', pattern: /\b(?:SELECT|INSERT\s+INTO|CREATE\s+(?:TABLE|KEYSPACE))\b/gi,
    engine: 'cassandra', accessStyle: 'ddl-migration', confidence: 0.95, extensions: ['cql'] },
  { name: 'scylla',
    scope: 'code', pattern: /\b(?:scylla|shard_aware)\b/gi, engine: 'scylla', accessStyle: 'raw-sql', confidence: 0.8 },
  { name: 'bigtable', pattern: /\b(?:bigtable|read_rows|RowSet|row_key_prefix)\b/g,
    engine: 'bigtable', accessStyle: 'kv-command', confidence: 0.85 },

  /* ================================================ key-value / memory == */
  { name: 'redis-scan-risk',
    // KEYS and FLUSHALL are the two commands that take a production Redis down.
    // The receiver constraint is not optional: a bare `.keys(` matched every
    // `Object.keys(` in the repository, which is how a Django project acquired
    // Redis findings. The sibling `redis` rule already anchors this way.
    pattern: new RegExp(
      String.raw`\b(?:redis|jedis|ioredis|redisClient|redis_client|cache|rdb|conn)\s*\.\s*(?:keys|flushall|flushdb)\s*\(` +
      String.raw`|["'\x60]\s*(?:KEYS\s+\*|FLUSHALL|FLUSHDB)`,
      'gi',
    ),
    engine: 'redis', accessStyle: 'kv-command', confidence: 0.9 },
  {
    name: 'redis',
    // Commands that are unambiguously Redis. `.get(`/`.set(` are omitted on
    // purpose — they match Map, caches and lodash, and add nothing that the
    // distinctive commands below do not already flag in the same file.
    pattern: new RegExp(
      String.raw`\b(?:redis|jedis|ioredis|redisClient|cache)\s*\.\s*` +
      String.raw`(?:scan|hgetall|hmget|mget|mset|pipeline|multi|smembers|sinter|zrange|zadd|zrangebyscore|setex|expire|ttl|lrange|rpush|lpop|incrby)\s*\(` +
      String.raw`|\bStackExchange\.Redis\b|\bIDatabase\s+\w*[Rr]edis`,
      'gi',
    ),
    engine: 'redis', accessStyle: 'kv-command', confidence: 0.85,
  },
  { name: 'memcached',
    scope: 'code', pattern: /\b(?:memcache|pylibmc|get_multi|Memcached)\b/gi,
    engine: 'memcached', accessStyle: 'kv-command', confidence: 0.8 },
  { name: 'etcd',
    scope: 'code', pattern: /\b(?:etcd|clientv3)\b|\bWithPrefix\(\)/g, engine: 'etcd', accessStyle: 'kv-command', confidence: 0.8 },
  { name: 'hazelcast-ignite', pattern: /\b(?:Hazelcast|IgniteCache|SqlFieldsQuery)\b|\bIMap</g,
    engine: 'hazelcast', accessStyle: 'query-builder', confidence: 0.8, extensions: JVM },

  /* ========================================================== graph == */
  { name: 'cypher', pattern: /\bMATCH\s*\(\s*\w*\s*:\s*\w+|\bMERGE\s*\(\s*\w*\s*:|\[\s*:\s*\w+\s*\*\s*\.\.|\bRETURN\s+DISTINCT\b/g,
    engine: 'neo4j', accessStyle: 'graph-traversal', confidence: 0.9 },
  { name: 'cypher-file', pattern: /\b(?:MATCH|MERGE|CREATE)\s*\(/g,
    engine: 'neo4j', accessStyle: 'graph-traversal', confidence: 0.95, extensions: ['cypher', 'cyp'] },
  {
    name: 'gremlin',
    // `until` and `repeat` are generic words, and as bare method names they
    // matched SCSS module calls — `breakpoint.until(...)`, `list.repeat(...)` —
    // making stylesheets the single largest false-positive category in the
    // corpus. A Gremlin step only counts alongside a traversal source.
    pattern: new RegExp(
      String.raw`\bg\s*\.\s*V\s*\(|\btraversal\s*\(\s*\)|\bGraphTraversalSource\b` +
      String.raw`|\.\s*(?:outE|inE|outV|inV|bothE|bothV|hasLabel|valueMap)\s*\(`,
      'g',
    ),
    engine: 'neptune', accessStyle: 'graph-traversal', confidence: 0.85,
  },
  { name: 'aql-sparql', pattern: /\bFOR\s+\w+\s+IN\s+\w+[\s\S]{0,200}?RETURN\b|\bPREFIX\s+\w+:\s*</g,
    engine: 'arangodb', accessStyle: 'graph-traversal', confidence: 0.8 },

  /* ========================================================= search == */
  {
    name: 'elasticsearch',
    // A lone `"query":` key appears in GraphQL configs, analytics payloads and
    // half the JSON in a web repo. Require a DSL-specific pairing instead.
    pattern: new RegExp(
      String.raw`"query"\s*:\s*\{\s*"(?:bool|match|match_all|match_phrase|term|terms|range|nested|multi_match|query_string|function_score|dis_max)"` +
      String.raw`|"(?:must_not|should|minimum_should_match|search_after|track_total_hits|aggregations)"\s*:` +
      String.raw`|"aggs"\s*:\s*\{` +
      String.raw`|\b(?:es|esClient|elastic|elasticClient|opensearch|osClient)\s*\.\s*(?:search|msearch|count|scroll)\s*\(`,
      'g',
    ),
    engine: 'elasticsearch', accessStyle: 'search-dsl', confidence: 0.82,
  },
  {
    name: 'opensearch',
    scope: 'code',
    // The bare word matched prose. `# TODO: migrate to opensearch` in a comment
    // set the engine for the whole span it sat in. Masking handles the comment;
    // this requires an actual import or client construction on top of it.
    pattern: new RegExp(
      String.raw`\bfrom\s+opensearchpy\s+import\b|\bimport\s+opensearchpy\b` +
      String.raw`|\brequire\s*\(\s*['"\x60]@opensearch-project\/` +
      String.raw`|\bfrom\s+['"\x60]@opensearch-project\/` +
      String.raw`|\bnew\s+OpenSearchClient\s*\(|\bOpenSearch\s*\(\s*\{` +
      String.raw`|\borg\.opensearch\.client\b`,
      'g',
    ),
    engine: 'opensearch', accessStyle: 'search-dsl', confidence: 0.85,
  },
  { name: 'solr',
    scope: 'code', pattern: /\b(?:solr|SolrQuery|[?&]fq=|[?&]defType=)\b/gi, engine: 'solr', accessStyle: 'search-dsl', confidence: 0.8 },

  /* ========================================================= vector == */
  {
    name: 'pgvector',
    // <-> <=> <#> are the pgvector distance operators.
    // `Bug<->Tag` in a docstring is an ASCII arrow, not a distance operator.
    // In real pgvector SQL the operator is spaced: `embedding <-> $1`.
    pattern: /(?:\s(?:<->|<=>|<#>)\s)|\bvector\s*\(\s*\d+\s*\)|\bivfflat\b|\bhnsw\b|ef_search|SET\s+ivfflat\.probes/gi,
    engine: 'pgvector', accessStyle: 'vector-search', confidence: 0.92,
  },
  { name: 'pinecone', pattern: /\b(?:pinecone|topK|top_k)\b|\.\s*upsert\s*\(\s*vectors/gi,
    engine: 'pinecone', accessStyle: 'vector-search', confidence: 0.85 },
  { name: 'weaviate', pattern: /\b(?:weaviate|nearVector|nearText|withHybrid)\b|\balpha\s*:/gi,
    engine: 'weaviate', accessStyle: 'vector-search', confidence: 0.88 },
  { name: 'qdrant', pattern: /\b(?:qdrant|hnsw_ef|search_params|with_payload)\b/gi,
    engine: 'qdrant', accessStyle: 'vector-search', confidence: 0.88 },
  { name: 'milvus', pattern: /\b(?:milvus|pymilvus|nprobe)\b|\bcollection\.search\s*\(/gi,
    engine: 'milvus', accessStyle: 'vector-search', confidence: 0.88 },
  { name: 'chroma', pattern: /\b(?:chromadb|chroma_client)\b|\.\s*query\s*\(\s*query_embeddings/gi,
    engine: 'chroma', accessStyle: 'vector-search', confidence: 0.85 },
  { name: 'faiss', pattern: /\b(?:faiss|IndexFlatL2|IndexIVFFlat|IndexHNSW)\b/g,
    engine: 'faiss', accessStyle: 'vector-search', confidence: 0.9 },

  /* ===================================================== time series == */
  { name: 'influxdb', pattern: /\binflux|\bfrom\s*\(\s*bucket\s*:|\|>\s*range\s*\(|\bInfluxQL\b/gi,
    engine: 'influxdb', accessStyle: 'timeseries-query', confidence: 0.88 },
  { name: 'timescaledb', pattern: /\bcreate_hypertable\b|\btime_bucket\s*\(|\bcontinuous\s+aggregate\b|\btimescaledb\b/gi,
    engine: 'timescaledb', accessStyle: 'timeseries-query', confidence: 0.9 },
  { name: 'promql', pattern: /\b(?:rate|irate|histogram_quantile|increase)\s*\(\s*\w+\{|prometheus_client|PromQL/g,
    engine: 'prometheus', accessStyle: 'timeseries-query', confidence: 0.85 },
  { name: 'druid',
    scope: 'code', pattern: /\bdruid\b|__time\b|\bgranularity\s*:\s*["']/gi,
    engine: 'druid', accessStyle: 'timeseries-query', confidence: 0.8 },
  { name: 'questdb',
    scope: 'code', pattern: /\bquestdb\b|\bSAMPLE\s+BY\b|\bLATEST\s+ON\b/gi,
    engine: 'questdb', accessStyle: 'timeseries-query', confidence: 0.85 },

  /* ================================================ object / embedded == */
  { name: 'objectdb-jpql', pattern: /\b(?:objectdb|JDOQL)\b|\bcreateQuery\s*\(\s*["']SELECT\s+\w+\s+FROM\b/gi,
    engine: 'objectdb', accessStyle: 'object-query', confidence: 0.85 },
  { name: 'realm', pattern: /\b(?:realm\s*\.\s*objects|RealmResults|\.\s*filter\s*\(\s*["'][\w\s=]+["']\s*\))/g,
    engine: 'realm', accessStyle: 'object-query', confidence: 0.8 },
  { name: 'duckdb', pattern: /\bduckdb\b|\bread_parquet\s*\(|\bread_csv_auto\s*\(/gi,
    engine: 'duckdb', accessStyle: 'raw-sql', confidence: 0.88 },
  { name: 'rocksdb', pattern: /\b(?:rocksdb|leveldb|NewIterator|SeekToFirst|WriteBatch)\b/gi,
    engine: 'rocksdb', accessStyle: 'kv-command', confidence: 0.85 },
  { name: 'pydb-embedded', pattern: /\b(?:tinydb|TinyDB|shelve\.open|dbm\.open|pickledb)\b/g,
    engine: 'tinydb', accessStyle: 'object-query', confidence: 0.85, extensions: PY },

  /* ============================================ drivers, per language == */
  {
    name: 'node-pg-mysql',
    // `client.query(` is also Apollo Client and react-query. Requiring a SQL
    // verb inside the first argument keeps this to actual database calls; a
    // query held in a variable is still caught by sql-in-string-literal.
    pattern: new RegExp(
      String.raw`\b(?:pool|client|db|conn|connection|sql)\s*\.\s*(?:query|execute)\s*\(\s*` +
      String.raw`[\x60'"][\s\S]{0,60}?(?:${SQL_VERBS_SRC})\b`,
      'gi',
    ),
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.82, extensions: JS,
  },
  { name: 'python-dbapi', pattern: /\bcursor\s*\.\s*execute(?:many)?\s*\(|\bconn(?:ection)?\s*\.\s*(?:fetch|fetchrow|fetchval|execute)\s*\(|\bpd\s*\.\s*read_sql\w*\s*\(/g,
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.72, extensions: PY },
  { name: 'jdbc', pattern: /\b(?:prepareStatement|createStatement|executeQuery|executeUpdate|NamedParameterJdbcTemplate|jdbcTemplate)\b/g,
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.8, extensions: JVM },
  { name: 'go-database-sql', pattern: /\b(?:db|tx)\s*\.\s*(?:Query|QueryRow|Exec|QueryContext|ExecContext|NamedExec|Select|Get)\s*\(/g,
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.8, extensions: ['go'] },
  { name: 'dotnet-ado-dapper', pattern: /\b(?:SqlCommand|ExecuteReader|ExecuteScalar|\.\s*Query(?:Async)?<|\.\s*QueryFirstOrDefault)\b/g,
    engine: 'mssql', accessStyle: 'raw-sql', confidence: 0.78, extensions: DOTNET },
  { name: 'rust-sqlx-diesel', pattern: /\b(?:sqlx::query|query_as!|diesel::|\.\s*load::<)/g,
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.82, extensions: ['rs'] },
  { name: 'php-pdo', pattern: /\$(?:pdo|db|conn)\s*->\s*(?:prepare|query|exec)\s*\(|\bDB::(?:table|select|raw)\s*\(/g,
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.8, extensions: ['php'] },
  { name: 'elixir-ecto', pattern: /\bRepo\s*\.\s*(?:all|one|get|preload|aggregate)\s*\(|\bfrom\s+\w+\s+in\s+\w+/g,
    engine: 'postgres', accessStyle: 'orm', confidence: 0.8, extensions: ['ex', 'exs'] },

  /* ================================================ ORMs / builders == */
  { name: 'prisma', pattern: /\bprisma\s*\.\s*\w+\s*\.\s*(?:findMany|findFirst|findUnique|count|aggregate|groupBy|update|create|delete|upsert)\s*\(|\$queryRaw|\$executeRaw/g,
    engine: 'unknown', accessStyle: 'orm', confidence: 0.9, extensions: JS },
  { name: 'typeorm-sequelize', pattern: /\.\s*(?:findAll|findOne|findAndCountAll|createQueryBuilder|getRepository|leftJoinAndSelect)\s*\(/g,
    engine: 'unknown', accessStyle: 'orm', confidence: 0.78, extensions: JS },
  {
    name: 'knex-drizzle',
    pattern: new RegExp(
      String.raw`\bknex\s*\(|\bknex\s*\.\s*\w+|\bdrizzle\s*\(` +
      String.raw`|\b(?:db|tx|trx)\s*\.\s*(?:select|insert|update|delete)\s*\(` +
      String.raw`|\.\s*(?:leftJoin|innerJoin|rightJoin|whereIn|whereNotIn|havingRaw|onConflict)\s*\(`,
      'g',
    ),
    engine: 'unknown', accessStyle: 'query-builder', confidence: 0.78, extensions: JS,
  },
  { name: 'sqlalchemy', pattern: /\bsession\s*\.\s*(?:query|execute|scalars)\s*\(|\bselect\s*\(\s*\w+\s*\)\s*\.\s*where\s*\(|\bjoinedload\s*\(|\bselectinload\s*\(/g,
    engine: 'unknown', accessStyle: 'orm', confidence: 0.82, extensions: PY },
  { name: 'django-orm', pattern: /\.\s*objects\s*\.\s*(?:filter|exclude|get|all|annotate|aggregate|values|values_list|select_related|prefetch_related|bulk_create)\s*\(/g,
    engine: 'unknown', accessStyle: 'orm', confidence: 0.85, extensions: PY },
  {
    name: 'activerecord',
    // Anchored to a model-shaped constant receiver, or to methods that only
    // ActiveRecord defines. A bare `.where(` matches too many Ruby DSLs.
    pattern: new RegExp(
      String.raw`\b[A-Z]\w*\s*\.\s*(?:where|joins|includes|find_by|pluck|group|find_each|all|order|limit)\s*[\(.]` +
      String.raw`|\.\s*(?:find_each|find_in_batches|includes|joins|left_outer_joins|pluck)\s*\(`,
      'g',
    ),
    engine: 'unknown', accessStyle: 'orm', confidence: 0.75, extensions: ['rb'],
  },
  { name: 'gorm', pattern: /\b(?:db|tx)\s*\.\s*(?:Where|Preload|Joins|Find|First|Model|Scan)\s*\(/g,
    engine: 'unknown', accessStyle: 'orm', confidence: 0.75, extensions: ['go'] },
  /*
   * XORM, which is not GORM and was not matched by anything.
   *
   * Found by auditing gitea and scoring the result: candidate coverage was 0%.
   * Three of the four audited defects produced **zero** candidates and the
   * fourth produced three, none at the defect line. The rule above is the only
   * Go data-access rule and it requires the receiver to be literally `db` or
   * `tx` and the method to be one of seven GORM names. XORM's idioms share
   * neither:
   *
   *   db.Insert(ctx, row)                                  helper verb
   *   db.GetEngine(ctx).ID(o.ID).Cols(...).Update(o)       engine accessor
   *   sess.ID(s.ID).Cols(...).Update(s)                    session chain
   *   x.Where("repo_id=?", id).Find(&rows)                 engine chain
   *
   * `bench/repos.json` describes gitea as "Go · XORM + raw SQL" and calls it
   * the hardest engine-inference case in the corpus, so this was a documented
   * target with no rule behind it — the raw-SQL rule carried the whole
   * repository.
   *
   * Precision-first, in the same way the MongoDB rule is. A bare `.Find(` would
   * match goquery's `doc.Find(".selector")`, which gitea's own tests are full
   * of, so no alternative here matches a verb alone:
   *
   *   1. `db.GetEngine(` is unambiguous — it exists to return an ORM session.
   *   2. A helper verb must take `ctx` as its first argument, which is the
   *      shape of a data-access helper and not of a string utility.
   *   3. A builder chain must start from a session/engine receiver AND end in a
   *      terminal, so `.Cols(...)` or `.ID(...)` alone is not enough.
   */
  { name: 'xorm',
    pattern: new RegExp(
      String.raw`\bdb\s*\.\s*GetEngine\s*\(` +
      String.raw`|\bdb\s*\.\s*(?:Insert|Find|Get|Count|Exist|Update|Delete|Iterate|WithTx)\s*\(\s*ctx\b` +
      String.raw`|\b(?:sess|session|x|e|engine)\s*\.\s*(?:ID|Where|Table|Cols|In|Limit|Join|SQL|Asc|Desc)\s*\([^)]*\)\s*(?:\.\s*\w+\s*\([^)]*\)\s*)*\.\s*(?:Find|Get|Count|Exist|Update|Insert|Delete|Iterate|Rows)\s*\(` +
      // A bare verb, but only on a receiver that is unambiguously an XORM
      // session. `sess.Delete(collaboration)` is data access with no builder
      // chain in front of it, so the alternative above cannot see it. `x` and
      // `e` are deliberately NOT allowed here: `x.Find(` is goquery in gitea's
      // own test helpers, and `e.Get(` is an element accessor in half the Go
      // ecosystem. `sess`/`session` carry no such collision.
      String.raw`|\b(?:sess|session)\s*\.\s*(?:Insert|Update|Delete|Get|Find|Count|Exist|Iterate)\s*\(`,
      'g',
    ),
    engine: 'unknown', accessStyle: 'orm', confidence: 0.78, extensions: ['go'] },
  { name: 'hibernate-jpa', pattern: /@(?:Query|NamedQuery|EntityGraph)\s*\(|\bcreateQuery\s*\(|\bEntityManager\b|\bCriteriaBuilder\b|FetchType\.(?:LAZY|EAGER)/g,
    engine: 'unknown', accessStyle: 'orm', confidence: 0.8, extensions: JVM },
  { name: 'ef-core', pattern: /\b(?:DbSet<|\.\s*Include\s*\(|\.\s*ThenInclude\s*\(|AsNoTracking\s*\(\s*\)|FromSqlRaw)\b/g,
    engine: 'mssql', accessStyle: 'orm', confidence: 0.82, extensions: DOTNET },

  /* ================================================== SQL fragments == */
  {
    name: 'sql-fragment-concat',
    // SQL assembled from pieces, where no single literal is a whole statement:
    //   sql += " WHERE tenant_id = %s"
    //   query = ("SELECT a " "FROM t " "WHERE b = 1")
    //   `${base} ORDER BY ${col}`
    // The span merger in scan.ts then joins neighbouring fragments into one
    // candidate, which is what makes these analysable at all.
    pattern: new RegExp(
      String.raw`(?:\+=|\+\s*)?["'\x60]\s*(?:AND|OR)?\s*` +
      String.raw`(?:FROM|WHERE|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|JOIN|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|VALUES|SET)\s`,
      'gi',
    ),
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.7,
  },
  {
    name: 'sql-string-building',
    // The variable itself announces the intent.
    // `\b` on both sides is load-bearing: without the leading one, any
    // identifier ending in `q` — `seq`, `faq`, `uniq` — matched.
    pattern: /\b(?:sql|query|stmt|statement|q)\b\s*(?:\+=|\.=|<<=|=\s*\w+\s*\+)/gi,
    engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.72,
  },

  /* ========================================================= schema == */
  { name: 'prisma-schema', pattern: /\bmodel\s+\w+\s*\{|@@index\s*\(|@@unique\s*\(/g,
    engine: 'unknown', accessStyle: 'ddl-migration', confidence: 0.95, extensions: ['prisma'] },
  { name: 'migration-dsl', pattern: /\b(?:add_index|create_table|addColumn|createIndex|op\.create_index|op\.add_column|schema\.create)\b/g,
    engine: 'unknown', accessStyle: 'ddl-migration', confidence: 0.85 },
]

/** Paths that are schema evidence rather than query sites. Fetched first. */
export const SCHEMA_PATH_HINTS = [
  /schema\.prisma$/i,
  /(^|\/)migrations?\//i,
  /(^|\/)db\//i,
  /(^|\/)models?\//i,
  /(^|\/)entities\//i,
  /\.(?:sql|ddl|hql|cql|psql)$/i,
  /(^|\/)(schema|structure)\.(sql|rb|py|ts|js|json|graphql)$/i,
  /alembic|flyway|liquibase|goose|knexfile|sequelize|typeorm/i,
  /(^|\/)dbt_project\.ya?ml$/i,
  /(^|\/)models?\/.*\.ya?ml$/i,
  /index(?:es)?\.(?:sql|json|ya?ml)$/i,
]

export function isSchemaFile(path: string): boolean {
  return SCHEMA_PATH_HINTS.some((r) => r.test(path))
}
