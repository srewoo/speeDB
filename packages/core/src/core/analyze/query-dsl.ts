/**
 * Recognises data access that is neither SQL text nor an ORM call.
 *
 * The value gate decides "is this database code at all?" by re-parsing the
 * snippet, and it had exactly two recognisers: `readSqlShape` for SQL and
 * `readOrmShape` for the ten ORM dialects. That covers five of the fourteen
 * `AccessStyle` values the detector can emit. The other nine had nothing, so
 * `not-data-access` fired on them — and it fired on the detector's own output,
 * which is the contradiction that makes it a bug rather than a gap. A
 * `$match`/`$group` pipeline was called "not database code"; so was a Chroma
 * search; so was a Pinecone query. Detection flagged the site, triage
 * confirmed it, authoring wrote it up, and the gate threw it away.
 *
 * The rule this module answers is a yes/no about recognition, not a shape:
 * unlike `SqlShape` or `OrmShape` there is no round-trip count here, because
 * the gate's counting rules already refuse to fire when there is nothing to
 * compare. Adding a fabricated count would be worse than having none.
 *
 * Precision over recall, deliberately. Every pattern below requires a marker
 * that only appears in the DSL it names — a `$`-prefixed stage key, a named
 * embedding argument, a Cypher node pattern. The rule these guard is a
 * *suppression*: a false positive here republishes the padding the gate was
 * written to remove, which is worse than a false negative that leaves one
 * stack unrecognised. Two consequences of that choice are called out inline:
 * `keys()` needs a Redis marker in the snippet, and `map-reduce`,
 * `rest-data-api`, `timeseries-query` and `object-query` outside DynamoDB and
 * Firestore are not recognised at all, because no pattern for them was
 * checked against real code.
 */

import type { AccessStyle } from '@/core/types'

export interface QueryDsl {
  style: AccessStyle
  /** The library or store the marker points at, for the suppression detail. */
  hint: string
}

/*
 * MQL stage and update operators, as they appear as object keys.
 *
 * Quoted (`"$match":`, Python and JSON) or bare (`$match:`, JavaScript). The
 * trailing colon is what makes this a pipeline rather than prose mentioning
 * an operator, and the leading `$` is what stops it matching an ordinary
 * object literal — which is the negative case that matters, because the
 * detector's raw-sql rule fires on plenty of `specs.push({ title, type })`.
 */
const MQL_OPERATORS = [
  'match', 'group', 'lookup', 'unwind', 'project', 'sort', 'limit', 'skip',
  'facet', 'addFields', 'set', 'unset', 'bucket', 'bucketAuto', 'graphLookup',
  'sample', 'count', 'merge', 'out', 'replaceRoot', 'replaceWith',
  'sortByCount', 'densify', 'fill', 'setWindowFields', 'search', 'searchMeta',
  'vectorSearch', 'geoNear', 'indexStats', 'unionWith',
].join('|')

const MQL_STAGE = new RegExp(
  String.raw`(?:^|[\{\[,\s])["']?\$(?:${MQL_OPERATORS})["']?\s*:`,
)

/*
 * Vector stores.
 *
 * Each clause names an argument or key that is specific to a vector search:
 * `query_embeddings`/`n_results` are Chroma, `topK`/`top_k` and a `vector`
 * key are Pinecone, `query_vector` is Elasticsearch kNN and Qdrant,
 * `near_vector` is Weaviate. A bare `.query(` or `.search(` is deliberately
 * not enough — those names are far too common to suppress or unsuppress on.
 */
const VECTOR_MARKERS: [RegExp, string][] = [
  [/\bquery_embeddings\s*=/, 'Chroma'],
  [/\bn_results\s*=/, 'Chroma'],
  [/\binclude_metadatas?\s*=/, 'Chroma'],
  [/\btopK\s*[:=]/, 'Pinecone'],
  [/\btop_k\s*[:=]/, 'Pinecone or Qdrant'],
  [/\bquery_vector\s*[:=]/, 'Qdrant or Elasticsearch kNN'],
  [/["']?vectors?["']?\s*:\s*(?:\[|embedding|vec)/, 'a vector store'],
  [/\bwith_near_vector\s*\(|\bnear_vector\s*[:=]/, 'Weaviate'],
  [/\bcollection_name\s*=\s*[^,)]+,\s*query_/, 'Qdrant'],
  [/\bupsert\s*\(\s*(?:vectors\s*=|\[\s*\{[^}]*\bvalues\b)/, 'Pinecone'],
  [/\bsimilarity_search(?:_with_score|_by_vector)?\s*\(/, 'LangChain vector store'],
  [/\bas_retriever\s*\(/, 'LangChain retriever'],
]

/*
 * Elasticsearch / OpenSearch query DSL.
 *
 * `bool`, `must_not`, `match_phrase`, `terms` and `aggs` have no meaning
 * outside this DSL. `filter` and `must` alone are not enough — `filter` in
 * particular is an ordinary word in ordinary code — so they only count next
 * to a sibling that is unambiguous.
 */
const SEARCH_DSL_MARKERS: [RegExp, string][] = [
  [/\b_(?:m?search|count)\b/, 'an Elasticsearch endpoint'],
  [/["']?(?:must_not|match_phrase|match_all|multi_match|span_near|dis_max)["']?\s*:/, 'the Elasticsearch query DSL'],
  [/["']?aggs?regations?["']?\s*:|["']aggs["']\s*:/, 'an Elasticsearch aggregation'],
  [/["']?bool["']?\s*:\s*\{/, 'an Elasticsearch bool query'],
  [/["']?terms["']?\s*:\s*\{/, 'an Elasticsearch terms query'],
]

/*
 * Redis and other key-value stores.
 *
 * `keys()` and `scan()` are the commands worth finding — `KEYS *` against a
 * production instance is a genuine, common defect — but `keys(` is also
 * `Object.keys(` and `dict.keys()`, and `.scan(` belongs to half the AWS
 * SDK. So a Redis marker has to appear in the snippet as well. This is the
 * clearest place where the module takes a false negative on purpose: a Redis
 * call with no `redis` in the excerpt stays unrecognised.
 */
const KV_STORE = /\bredis\b|\bioredis\b|\bStrictRedis\b|\bRedisClient\b|\bvalkey\b|\bmemcach/i
const KV_COMMAND =
  /\.\s*(?:keys|scan|hgetall|hmget|hset|hget|mget|mset|setex|getset|zrange|zrangebyscore|zadd|lrange|lpush|rpush|sadd|smembers|sinter|expire|ttl|pipeline|multi|flushall|flushdb)\s*\(/i

/*
 * Graph stores.
 *
 * A Cypher node pattern (`MATCH (n:Label)`) and a Gremlin traversal
 * (`g.V(`) are both unmistakable. Plain `MATCH` without a node pattern is
 * not: it is a SQL keyword in `MERGE ... WHEN MATCHED`.
 */
const GRAPH_MARKERS: [RegExp, string][] = [
  [/\b(?:OPTIONAL\s+)?MATCH\s*\(\s*\w*\s*:\s*\w+/i, 'a Cypher pattern'],
  [/\bMERGE\s*\(\s*\w*\s*:\s*\w+/i, 'a Cypher MERGE'],
  [/\bg\s*\.\s*V\s*\(|\bg\s*\.\s*E\s*\(/, 'a Gremlin traversal'],
  [/\.\s*(?:out|in|both)(?:E|V)?\s*\(\s*['"]/, 'a Gremlin step'],
  [/\bCREATE\s*\(\s*\w*\s*:\s*\w+\s*\{/i, 'a Cypher CREATE'],
]

/*
 * Document and object stores addressed by key rather than by query.
 *
 * DynamoDB and Firestore only, and both by a marker that is theirs alone:
 * `TableName` is DynamoDB's required parameter, the `*Command` classes are
 * the v3 SDK, and a Firestore chain reaches `.doc(` or `.where(` through
 * `.collection(`. Other object stores are not recognised — see the module
 * comment.
 */
const OBJECT_QUERY_MARKERS: [RegExp, string][] = [
  [/\b(?:Scan|Query|GetItem|PutItem|UpdateItem|DeleteItem|BatchGetItem|BatchWriteItem|TransactGetItems|TransactWriteItems)Command\b/, 'the DynamoDB SDK'],
  [/["']?TableName["']?\s*[:=]/, 'a DynamoDB request'],
  [/\bKeyConditionExpression\s*[:=]|\bFilterExpression\s*[:=]|\bProjectionExpression\s*[:=]/, 'a DynamoDB expression'],
  [/\.\s*collection\s*\(\s*['"][^'"]+['"]\s*\)\s*\.\s*(?:doc|where|orderBy|limit|get|add|set)\s*\(/, 'a Firestore query'],
  [/\bfirestore\b|\bFieldValue\s*\.\s*serverTimestamp\b/, 'Firestore'],
]

/**
 * The DSL this snippet is written in, or null when it is not data access.
 *
 * Order is by specificity, not by popularity: an aggregation pipeline that
 * also mentions `$search` is a pipeline, and a vector search expressed as a
 * `$vectorSearch` stage is reported as the pipeline it is, because that is
 * what a reader has to change.
 */
export function readQueryDsl(code: string): QueryDsl | null {
  if (!code || !code.trim()) return null

  if (MQL_STAGE.test(code)) {
    return { style: 'aggregation-pipeline', hint: 'a MongoDB aggregation or update operator' }
  }

  for (const [re, hint] of VECTOR_MARKERS) {
    if (re.test(code)) return { style: 'vector-search', hint }
  }
  for (const [re, hint] of SEARCH_DSL_MARKERS) {
    if (re.test(code)) return { style: 'search-dsl', hint }
  }
  for (const [re, hint] of GRAPH_MARKERS) {
    if (re.test(code)) return { style: 'graph-traversal', hint }
  }
  for (const [re, hint] of OBJECT_QUERY_MARKERS) {
    if (re.test(code)) return { style: 'object-query', hint }
  }
  if (KV_STORE.test(code) && KV_COMMAND.test(code)) {
    return { style: 'kv-command', hint: 'a Redis-compatible command' }
  }

  return null
}
