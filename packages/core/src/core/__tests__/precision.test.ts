import { describe, expect, it } from 'vitest'
import { detectInFile } from '../detect/scan'

/**
 * Adversarial precision suite.
 *
 * Every sample here is ordinary application code that contains no database
 * query. A hit costs real tokens on every scan, so these must all be silent.
 */
const FALSE_POSITIVES: [string, string][] = [
  ['array-find', `
    const user = users.find(u => u.id === id)
    const idx = rows.find(function (r) { return r.active })
    const first = list.find(isEnabled)
  `],
  ['array-find-destructured', `
    const match = items.find(({ id }) => id === target)
  `],
  ['lodash-and-collections', `
    const seen = new Map()
    seen.set('a', 1)
    const v = seen.get('a')
    const grouped = groupBy(items, 'kind')
    const found = _.find(items, { id: 3 })
  `],
  ['react-query-apollo', `
    const client = useApolloClient()
    const { data } = await client.query({ query: GET_USERS, variables: { id } })
    const qc = useQueryClient()
    qc.setQueryData(['users'], next)
  `],
  ['graphql-document', `
    const GET_USERS = gql\`
      query GetUsers($id: ID!) { user(id: $id) { name email } }
    \`
  `],
  ['json-config-with-query-key', `
    export const config = {
      "query": { "timeout": 30, "retries": 3 },
      "aggs": "disabled"
    }
  `],
  ['analytics-payload', `
    track('search', { query: term, filters: { kind: 'doc' }, TableName: 'events' })
  `],
  ['express-route', `
    app.get('/users/:id', async (req, res) => {
      const id = req.params.id
      res.json(await service.load(id))
    })
  `],
  ['prose-with-sql-words', `
    // The user can select from a list, update their profile, and delete
    // an account. Insert into the form whatever values you like.
  `],
  ['css-in-js', `
    const Button = styled.button\`
      display: flex;
      order: 2;
      background: \${p => p.theme.accent};
    \`
  `],
  ['test-assertions', `
    expect(rows.find(r => r.id === 1)).toBeDefined()
    expect(cache.get('k')).toEqual({ a: 1 })
  `],
  ['ruby-non-ar-dsl', `
    routes.draw do
      resources :users
    end
    config.where(env: 'test')
  `],
]

describe('detector precision — these must produce no candidates', () => {
  it.each(FALSE_POSITIVES)('%s', (_name, src) => {
    const ts = detectInFile('src/app.ts', src)
    const rb = detectInFile('app/models/thing.rb', src)
    const found = [...ts, ...rb]
    expect(
      found,
      found.map((f) => `${f.detector}: ${f.excerpt.trim().slice(0, 60)}`).join('\n'),
    ).toHaveLength(0)
  })
})

/** Recall must survive the tightening — the real calls still have to land. */
const TRUE_POSITIVES: [string, string, string][] = [
  ['mongo-find-filter', 'src/repo.ts', `const docs = await db.users.find({ tenantId, active: true })`],
  ['mongo-collection', 'src/repo.ts', `await collection.updateOne({ _id }, { $set: { name } })`],
  ['mongo-model', 'src/repo.ts', `const one = await User.findOne({ email })`],
  ['mongo-aggregate', 'src/repo.ts', `await col.aggregate([{ $match: { a: 1 } }, { $lookup: { from: 'u' } }])`],
  ['pg-query', 'src/db.ts', `const r = await pool.query('SELECT id FROM users WHERE tenant = $1', [t])`],
  ['dynamo-command', 'src/h.ts', `await client.send(new ScanCommand({ TableName: 'orders' }))`],
  ['dynamo-expression', 'src/h.ts', `const p = { KeyConditionExpression: '#pk = :pk', TableName: 'o' }`],
  ['es-search', 'src/s.ts', `await esClient.search({ index: 'm', body })`],
  ['es-dsl', 'src/s.ts', `const body = { "query": { "bool": { "must": [] } } }`],
  ['redis-scan', 'src/c.ts', `const keys = await redis.scan(cursor, 'MATCH', 'session:*')`],
  ['activerecord', 'app/models/u.rb', `Meeting.where(tenant_id: 1).includes(:owner).pluck(:id)`],
  ['knex', 'src/q.ts', `const rows = await db.select('id').from('users').whereIn('id', ids)`],
]

describe('detector recall — the real calls still land', () => {
  it.each(TRUE_POSITIVES)('%s', (_name, file, src) => {
    expect(detectInFile(file, src).length).toBeGreaterThan(0)
  })
})
