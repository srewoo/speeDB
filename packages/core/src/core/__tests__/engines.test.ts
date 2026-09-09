import { describe, expect, it } from 'vitest'
import { detectInFile } from '../detect/scan'
import { ENGINES, engineSpec, equivalenceNotesFor } from '@/config/engines'

/** Every engine the detector can emit must resolve in the registry. */
describe('engine registry', () => {
  it('has unique ids', () => {
    const ids = ENGINES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('falls back to unknown rather than throwing', () => {
    expect(engineSpec('not-a-real-engine').id).toBe('unknown')
  })

  it('gives every engine equivalence notes', () => {
    for (const e of ENGINES) expect(e.equivalenceNotes.length).toBeGreaterThan(30)
  })

  it('warns that vector search is approximate', () => {
    for (const id of ['pgvector', 'pinecone', 'qdrant', 'milvus', 'faiss']) {
      expect(engineSpec(id).equivalenceNotes.toLowerCase()).toMatch(/approximate|recall/)
    }
  })

  it('deduplicates notes for repeated engines', () => {
    const notes = equivalenceNotesFor(['postgres', 'postgres', 'mongodb'])
    expect(notes.split('\n')).toHaveLength(2)
  })
})

/** One representative snippet per family, in a realistic host language. */
const CASES: [string, string, string][] = [
  ['snowflake', 'q.sql', 'SELECT id FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY x ORDER BY y) = 1'],
  ['bigquery', 'etl.py', 'client = bigquery.Client()\nq = "SELECT * FROM `proj.ds.events` WHERE _PARTITIONTIME > x"'],
  ['clickhouse', 'q.sql', 'SELECT a FROM events PREWHERE ts > now() - 3600'],
  ['hive', 'load.hql', 'INSERT OVERWRITE TABLE sink SELECT * FROM src'],
  ['spark', 'job.py', 'df = spark.sql("SELECT * FROM events").repartition(200)'],
  ['hbase', 'Scan.java', 'Scan scan = new Scan();\nscan.setStartRow(Bytes.toBytes("a"));'],
  ['mongodb', 'repo.ts', 'await col.aggregate([{ $lookup: { from: "u" } }, { $match: { a: 1 } }])'],
  ['dynamodb', 'handler.js', 'await documentClient.scan({ TableName: "orders", FilterExpression: "#s = :s" })'],
  ['firestore', 'app.ts', 'db.collection("users").where("age", ">", 21).onSnapshot(cb)'],
  ['cassandra', 'dao.py', 'session.execute("SELECT * FROM events WHERE x = 1 ALLOW FILTERING")'],
  ['redis', 'cache.js', 'const all = await redis.keys("session:*")'],
  ['neo4j', 'graph.js', 'session.run("MATCH (u:User)-[:FOLLOWS*..]->(v:User) RETURN DISTINCT v")'],
  ['elasticsearch', 'search.ts', 'await es.search({ body: { "query": { "bool": { "must": [] } } } })'],
  ['pgvector', 'search.sql', 'SELECT id FROM docs ORDER BY embedding <-> $1 LIMIT 10'],
  ['qdrant', 'vec.py', 'client.search(collection_name="d", search_params={"hnsw_ef": 128})'],
  ['milvus', 'vec.py', 'from pymilvus import Collection\ncollection.search(param={"nprobe": 16})'],
  ['influxdb', 'q.flux', 'from(bucket: "metrics") |> range(start: -1h)'],
  ['timescaledb', 'q.sql', 'SELECT time_bucket(\'5m\', ts), avg(v) FROM readings GROUP BY 1'],
  // `rules.yml`, not `rules.txt`: Prometheus rule files are YAML, and `.txt` is
  // now treated as prose (a changelog produced 40 phantom query sites).
  ['prometheus', 'rules.yml', 'histogram_quantile(0.99, rate(http_duration_bucket{job="api"}[5m]))'],
  ['duckdb', 'load.py', 'duckdb.sql("SELECT * FROM read_parquet(\'s3://b/*.parquet\')")'],
  ['rocksdb', 'store.go', 'it := db.NewIterator(ro)\ndefer it.Close()'],
]

describe('cross-engine detection', () => {
  it.each(CASES)('identifies %s', (engine, file, src) => {
    const hits = detectInFile(file, src)
    expect(hits.length).toBeGreaterThan(0)
    // The span may merge several rules; the engine must be among them.
    expect(hits.some((h) => h.engine === engine)).toBe(true)
  })
})

describe('cross-language detection', () => {
  const LANGS: [string, string][] = [
    ['Repo.java', 'PreparedStatement ps = conn.prepareStatement("SELECT * FROM t WHERE id = ?");'],
    ['repo.go', 'rows, err := db.QueryContext(ctx, "SELECT id FROM users WHERE tenant = $1")'],
    ['Repo.cs', 'var r = await conn.QueryAsync<User>("SELECT * FROM Users WHERE Id = @id");'],
    ['repo.rs', 'let r = sqlx::query!("SELECT id FROM users WHERE id = $1", id);'],
    ['repo.php', '$stmt = $pdo->prepare("SELECT * FROM users WHERE id = :id");'],
    ['repo.rb', 'User.where(tenant_id: 1).includes(:posts).pluck(:id)'],
    ['repo.ex', 'Repo.all(from u in User, where: u.tenant_id == ^id)'],
    ['repo.kt', '@Query("SELECT u FROM User u WHERE u.tenantId = :id")'],
  ]

  it.each(LANGS)('finds a query site in %s', (file, src) => {
    expect(detectInFile(file, src).length).toBeGreaterThan(0)
  })
})
