import { describe, expect, it } from 'vitest'
import { readQueryDsl } from '../analyze/query-dsl'

/**
 * The recogniser behind the value gate's `not-data-access` rule, for the
 * access styles that are neither SQL nor an ORM call.
 *
 * The snippets marked "from a real scan" are the exact text that was
 * suppressed as "not database code" when the MCP server was run against five
 * repositories, so they are the regression cases.
 *
 * The negative half of this file matters more than the positive half. This
 * module can only ever *unsuppress* a finding, so a false positive here
 * republishes the padding the gate exists to remove.
 */
describe('readQueryDsl — MongoDB pipelines', () => {
  it('recognises a Python $match/$group pipeline (from a real scan)', () => {
    const dsl = readQueryDsl(
      'pipeline = [\n' +
      '    {"$match": {"user_id": user_id}},\n' +
      '    {"$group": {"_id": None, "total": {"$sum": 1}}}\n' +
      ']',
    )
    expect(dsl?.style).toBe('aggregation-pipeline')
  })

  it('recognises the unquoted JavaScript form', () => {
    expect(readQueryDsl('const p = [{ $match: { userId } }, { $sort: { createdAt: -1 } }]')?.style)
      .toBe('aggregation-pipeline')
  })

  it('recognises an update operator', () => {
    expect(readQueryDsl('{"$set": {"status": "done"}}')?.style).toBe('aggregation-pipeline')
    expect(readQueryDsl('{ $inc: { views: 1 } }')).toBeNull() // $inc is not a stage
  })

  it('reports a $vectorSearch stage as the pipeline it is', () => {
    expect(readQueryDsl('[{ "$vectorSearch": { "queryVector": v, "limit": 10 } }]')?.style)
      .toBe('aggregation-pipeline')
  })
})

describe('readQueryDsl — vector stores', () => {
  it('recognises a Chroma search (from a real scan)', () => {
    const dsl = readQueryDsl(
      'results = self.collection.query(\n' +
      '    query_embeddings=query_embedding,\n' +
      '    n_results=min(n_results, self.collection.count()),\n' +
      ')',
    )
    expect(dsl?.style).toBe('vector-search')
    expect(dsl?.hint).toMatch(/Chroma/)
  })

  it('recognises a Pinecone query', () => {
    expect(readQueryDsl('await index.query({ vector: embedding, topK: 5 })')?.style)
      .toBe('vector-search')
  })

  it('recognises Qdrant and Weaviate', () => {
    expect(readQueryDsl('client.search(collection_name="docs", query_vector=vec, limit=8)')?.style)
      .toBe('vector-search')
    expect(readQueryDsl('q.with_near_vector({"vector": vec})')?.style).toBe('vector-search')
  })

  it('recognises a LangChain retriever', () => {
    expect(readQueryDsl('docs = store.similarity_search_with_score(q, k=4)')?.style)
      .toBe('vector-search')
  })

  it('does not fire on a bare .query( or .search(', () => {
    expect(readQueryDsl('const rows = await conn.query(sqlText)')).toBeNull()
    expect(readQueryDsl('const hit = list.search(term)')).toBeNull()
  })
})

describe('readQueryDsl — search, graph, kv and object stores', () => {
  it('recognises an Elasticsearch bool query', () => {
    expect(readQueryDsl('{ "query": { "bool": { "must_not": [{ "term": { "deleted": true } }] } } }')?.style)
      .toBe('search-dsl')
  })

  it('recognises a Cypher pattern and a Gremlin traversal', () => {
    expect(readQueryDsl('MATCH (u:User)-[:OWNS]->(a:Account) RETURN a')?.style)
      .toBe('graph-traversal')
    expect(readQueryDsl('g.V().hasLabel("user").out("owns").toList()')?.style)
      .toBe('graph-traversal')
  })

  it('does not read SQL MERGE ... WHEN MATCHED as Cypher', () => {
    const dsl = readQueryDsl('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1')
    expect(dsl?.style).not.toBe('graph-traversal')
  })

  it('recognises a Redis command only with a Redis marker present', () => {
    expect(readQueryDsl('const all = await redis.keys("session:*")')?.style).toBe('kv-command')
    // The deliberate false negative: no marker, so no claim. Documented in the module.
    expect(readQueryDsl('const all = await client.keys("session:*")')).toBeNull()
  })

  it('does not fire on Object.keys or dict.keys()', () => {
    expect(readQueryDsl('const names = Object.keys(config)')).toBeNull()
    expect(readQueryDsl('for k in payload.keys():\n    total += 1')).toBeNull()
  })

  it('recognises DynamoDB and Firestore', () => {
    expect(readQueryDsl('await docClient.send(new ScanCommand({ TableName: "users" }))')?.style)
      .toBe('object-query')
    expect(readQueryDsl('db.collection("users").where("age", ">", 21).limit(10).get()')?.style)
      .toBe('object-query')
  })
})

describe('readQueryDsl — the negative cases that matter', () => {
  it('returns null for the in-memory object building the detector misfires on', () => {
    // From a real scan: three of four sites in this repository were detected
    // as raw-sql and are pure in-memory work.
    expect(readQueryDsl(
      'specs.push({\n' +
      '  title: `${flowName} — "${label}" select first valid option`,\n' +
      '  type: "positive",\n' +
      '  expectError: false,\n' +
      '})',
    )).toBeNull()
  })

  it('returns null for string and URL building', () => {
    expect(readQueryDsl("if (sectionId) { url += sep + 'section=' + sectionId; sep = '&'; }")).toBeNull()
  })

  it('returns null for empty and whitespace input', () => {
    expect(readQueryDsl('')).toBeNull()
    expect(readQueryDsl('   \n  ')).toBeNull()
  })

  it('returns null for prose that merely mentions an operator', () => {
    expect(readQueryDsl('// TODO: we should probably use $lookup here instead')).toBeNull()
  })
})
