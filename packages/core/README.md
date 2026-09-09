# @speedb/core

The analysis engine behind [speeDB](https://github.com/) — find database queries
in a repository, and check proposed rewrites against the source. No browser, no
database connection, no measurement.

```sh
npm install @speedb/core
```

Most of it is deterministic and free. You can use the checks without ever
calling a model:

```ts
import { checkEquivalence, detectInFileVerbose, explainFor, buildSchemaFacts } from '@speedb/core'

// Is this rewrite safe?
checkEquivalence('SELECT id, name FROM users', 'SELECT id FROM users').status
// -> 'contradicted'  (a column was dropped)

// What should I actually run to verify a claim?
explainFor('mongodb', 'document').plan
// -> ".explain('queryPlanner')"

// Where are the queries, and which are likely to matter?
detectInFileVerbose('app/views.py', source).candidates
// -> [{ startLine, engine, confidence, priority, scope: { loopDepth, trigger } }]

// Does this index already exist?
checkProposedIndex('CREATE INDEX ON orders (status)', buildSchemaFacts(files))
```

`runScan()` is the full pipeline — ingest, engine profile, detect, analyse,
ground, gate. It takes an injectable `LlmProvider` and `RepoClient`, so the
model and the source of files are both yours to choose.

Requires Node 20.3+ (`AbortSignal.any`). Runs in a browser too — the extension
it was built for is a Chrome side panel.

For the MCP server built on this, see
[`@speedb/mcp`](https://www.npmjs.com/package/@speedb/mcp).

MIT licensed.
