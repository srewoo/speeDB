# speeDB

A Chrome extension that scans any GitHub or GitLab repository, finds every
database query in it, and proposes rewrites — then tells you exactly how much of
each claim it was able to check, and how much it could not.

**It measures nothing, and says so.** speeDB has no database connection, no
query plan, no row counts and no timings. A rewrite that is provably
output-identical can still be slower, and no static tool would catch it. So the
speed claim is never asserted: every finding carries the EXPLAIN you can run,
the statistics queries that reveal what source code cannot, and a note on which
line of the output actually answers the question.

## What is actually verified

Two independent checks run on every finding, and they prove different things.
Conflating them would be the easiest way to mislead you, so the UI keeps them
apart and so does this README.

### 1. Citations — always machine-checked

An LLM will happily suggest "add an index on `tenant_id`" for a table it never
saw, citing a migration file that does not exist. Every cited path, line range
and quote is re-checked against the bytes actually fetched:

| Check | Failure behaviour |
| --- | --- |
| Cited file exists in the scanned tree | **Rejected** — finding is dropped |
| Evidence quote appears verbatim in that file | Citation stripped, finding downgraded |
| Cited line range is inside the file | Downgraded |
| Excerpt matches the source near that line | Downgraded (±5 lines of drift tolerated) |
| Index suggestion cites schema/migration evidence | Downgraded |

Rejected findings are counted in the report rather than hidden.

### 2. Speed — never measured, always verifiable

The word "optimiser" implies measurement. This one does not measure, and
pretending otherwise would be the biggest lie it could tell. Instead each
finding separates:

| | |
| --- | --- |
| **Counted** | Facts derivable from the two statements alone — "transfers 3 fewer columns", "caps the result at 1 row". Counted, never timed. |
| **Unmeasured** | Everything else, named individually: whether the planner picks this path, whether the index already exists in production, its write cost, and for vector search, recall. |
| **Verification** | The exact `EXPLAIN ANALYZE` for both queries, plus the `pg_stats` / `SHOW INDEX` / `.explain()` calls that expose what source cannot. |
| **What to look for** | Which line of the plan answers the question — `Seq Scan` → `Index Scan`, `Buffers: shared read`, `totalDocsExamined vs nReturned`. |

The model is also instructed never to state a speed multiple, a percentage or a
millisecond figure — only a mechanism.

Every engine in the registry has a verification recipe, and a test asserts it —
so breadth is checkable behaviour rather than prompt prose.

### 3. Schema — declared facts only, with the gaps named

Index advice built on migration files is half wrong, because migrations record
intent, not the live schema. speeDB parses the DDL it can see — `CREATE TABLE`,
`CREATE INDEX`, Prisma `@@index`, Rails `add_index`, Alembic `op.create_index` —
into a catalog, and uses it to kill the most common wrong recommendation:

- a proposed index that **duplicates** one already declared
- a proposed index whose columns are a **leading prefix** of an existing index,
  which therefore already serves those lookups
- a proposed index on a **column no declared table has**

It also states, in the report header, the four things it cannot know: row
counts, selectivity, which indexes exist in production, and index bloat.

### 4. Equivalence — checked where it is decidable, labelled where it is not

This is the harder claim, and it is only partly checkable. For SQL, speeDB
compares the two statements structurally and reports one of four verdicts:

| Verdict | Meaning |
| --- | --- |
| **Machine-verified** | Every decidable property is identical: output columns and their order, DISTINCT, GROUP BY, set operations, ORDER BY, row limits. Index-only DDL also lands here — an index cannot change a result set. |
| **Partly verified** | The decidable properties match, but something needs your judgement — an added `LIMIT`, an added `ORDER BY`, or a changed `WHERE`. Each is named. |
| **Contradicted** | A decidable property differs. The finding is **moved out of the same-output section automatically**, whatever its prose argued. |
| **Not machine-checkable** | A non-SQL engine, or syntax the checker cannot read. Said plainly, never counted as passing. |

Proving that two `WHERE` clauses match the same rows needs a solver, not a
parser. speeDB does not pretend otherwise: it verifies what it can, states what
it cannot, and shows you the model's argument in full so you can judge the rest.

There is also a completeness heuristic — does the argument even mention rows,
columns, ordering, NULLs and duplicates? It is labelled as a heuristic, because
a thorough-sounding argument is not a correct one.

Same-output optimisations and behaviour-changing fixes are kept in separate
sections. They are never mixed, and the classification is enforced by the
machine check, not taken on the model's word.

## Pipeline

```
ingest ──────► detect ──────► analyse ──────► ground
 1 archive     regex rules     LLM, only on    citations re-checked;
 request       zero cost       candidates      SQL compared structurally
```

**Ingest is one request.** The whole repository arrives as a single gzipped
tarball, gunzipped in the browser via `DecompressionStream` and parsed by a
small TAR reader. The naive one-request-per-file approach costs 2,000 of
GitHub's 5,000/hour budget on a 2,000-file repo, which makes a second scan
impossible. Per-file reads remain as a fallback when the archive endpoint
cannot serve.

**Detect is deterministic and free**, and runs in two tiers.

*Tier one* matches query text. Rules are precision-first: a bare `.find(` would
match every `Array.prototype.find` in a TypeScript repo, so the MongoDB rule
also requires a collection-shaped receiver and a filter-document argument.
Candidates below a confidence floor are dropped, not merely ranked lower.
`precision.test.ts` holds ordinary application code that must produce zero
candidates.

*Tier two exists because tier one structurally cannot win.* In a mature Java or
Rails repository most queries are never lexically visible — Hibernate criteria
assembled from method calls, Django managers composed across functions,
ActiveRecord scopes chained at the call site, Prisma `where` fragments passed
between modules, SQL concatenated from pieces where no single literal is a
statement. Tightening regexes only trades one error for the other. So tier two
identifies *files* that are unambiguously data access — by imports,
annotations, base classes and path — and submits a bounded, query-bearing
sample of each. It turns a recall problem into a capped token cost.

## Coverage

Not a SQL-only tool. `src/config/engines.ts` is the registry — 60+ engines
across 12 families, each carrying its own **equivalence semantics** that get
injected into the analysis prompt:

| Family | Engines |
| --- | --- |
| Relational | PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, SQLite, Db2 |
| Distributed SQL | CockroachDB, TiDB, YugabyteDB, Spanner, Vitess |
| Cloud warehouse | Snowflake, BigQuery, Redshift, Synapse, Databricks, Athena, ClickHouse |
| Big data / Hadoop | Hive, Spark SQL, Trino/Presto, Impala, HBase, MapReduce |
| Document | MongoDB, CouchDB, DynamoDB, Firestore, Cosmos DB |
| Wide column | Cassandra, ScyllaDB, Bigtable |
| Key-value / in-memory | Redis, Memcached, etcd, Hazelcast, Ignite |
| Graph | Neo4j, Neptune, ArangoDB |
| Search | Elasticsearch, OpenSearch, Solr |
| Vector | pgvector, Pinecone, Weaviate, Qdrant, Milvus, Chroma, FAISS |
| Time series | InfluxDB, TimescaleDB, Prometheus, Druid, QuestDB |
| Object / embedded | ObjectDB, Realm, DuckDB, RocksDB, TinyDB, shelve |

Those notes are what stop relational intuitions being applied to stores that do
not share them. The sharpest case is vector search: changing `ef_search`,
`nprobe` or `topK` changes *recall*, so every recall-affecting change is
classified behaviour-changing, never same-output.

Query sites are detected across JS/TS, Python, Java, Kotlin, Scala, Groovy,
Clojure, Go, Rust, C/C++, C#, F#, Ruby, PHP, Perl, Swift, Objective-C, Elixir,
Erlang, Dart, Lua, R and Julia, plus `.sql`, `.hql`, `.cql`, `.cypher`,
`.flux` and `.prisma` files.

## AI backends

| Provider | Code leaves device | Needs a key |
| --- | --- | --- |
| Chrome built-in AI | **No** | No |
| Anthropic | Yes | Yes |
| OpenAI | Yes | Yes |
| Google Gemini | Yes | Yes |

**The model list is live.** Settings asks the provider what your key can
actually use, so new models appear without an extension update and models your
tier cannot reach never show up. `src/config/models.ts` is the offline fallback,
not the source of truth.

**Temperature is provider-aware.** OpenAI's o-series and GPT-5 family are
reasoning models that reject a custom temperature with a 400, so speeDB omits
the parameter for them and disables the slider. The check is scoped per
provider — Gemini's `-thinking` variants accept temperature, and a shared
name-based heuristic would wrongly disable it there. The adapter also recovers
from an unexpected rejection at request time, so a model released after this
build costs one wasted round trip rather than a failed scan.

## Review a pull request, not just a repository

A repo-wide scan is a one-time ritual whose value decays the day after. The
moment a finding can still change something is the PR. Open the panel on a
GitHub PR or GitLab MR and speeDB offers **Scan just this PR** — candidates are
narrowed to the changed files, while the whole tree is still ingested so schema
evidence elsewhere can be cited. If the change list cannot be read, it falls
back to a full scan and says so rather than silently scanning everything.

## From report to change

Export includes a **`.patch`** — a unified diff anchored at the scanned commit,
checkable with `git apply --check`. Individual findings have **Copy diff**.

Behaviour-changing findings are deliberately excluded from the bulk patch and
the file says how many were withheld. Bundling them into something a person
might apply in one go would undo the point of separating them.

## Cost, before you spend it

A token budget is not informed consent — a token count means nothing at the
moment someone pastes an API key. Between detection and the first paid request,
speeDB shows the estimated tokens and dollars and waits for a decision. Input
tokens are known exactly (the prompts are already built); output is projected,
and labelled as a projection. A model with no published price shows a token
estimate and no dollar figure — a confident wrong number is worse than none.

The gate does not appear for on-device runs or for scans that are entirely
cache hits.

## Tab autodetect

Open the panel while you're on a GitHub or GitLab page and the repository is
filled in for you, branch included. A deep file link is normalised back to the
repository root — opening one file should scan the repo, not "a file". The
panel keeps following you as you browse.

It is deliberately conservative: forge pages that aren't repositories
(dashboards, settings, marketplace, owner and group pages) are ignored, and it
never overwrites a URL you typed — only an empty field, or one it filled itself.

## Resilience

Every forge request carries a **30-second timeout** (90s for a tree listing)
and the scan's `AbortSignal`, combined via `AbortSignal.any`. Both matter:
without the timeout, one stalled connection hangs the whole batch — and with
the signal unplumbed, Stop scan cannot interrupt an in-flight request either,
so the UI freezes with no way out.

A file that times out, is an LFS pointer, or exceeds 512KB costs that file, not
the scan. Skipped files are counted and shown in the progress view and the
report header — a silent skip would read as full coverage. If *nothing* could
be read, that is raised as an error rather than reported as a confident
"no findings" over an empty tree.

## Caching

A finished scan is cached for **60 minutes** in `chrome.storage.session` —
memory-backed, never written to disk, gone when Chrome closes. The key is
`commitSha:provider:model`, so a new commit never reuses old results and
switching model always re-analyses. The check runs immediately after resolving
the ref, before any file fetching, so a hit skips several hundred API calls and
every LLM pass.

Three ways to bypass it: **Scan fresh** on the start screen, **Rescan without
cache** on a cached report, and **Clear cached scans** in Settings.

Cookies were the wrong tool here — 4KB cap, sent to servers on every matching
request, readable by the page. Session storage gives the lifetime guarantee
that actually matters, with room for real reports.

Cloud hosts are **optional** permissions requested only when you pick that
provider; the on-device path never triggers a permission prompt.

## Credentials

API keys and forge tokens default to `chrome.storage.session` — memory-backed,
never written to disk, cleared when Chrome closes. An extension cannot
meaningfully encrypt secrets at rest, so the honest default is not to persist
them. Opting into disk storage is a single explicit toggle that says so.

## Develop

```bash
npm install
npm run dev            # then load dist/ as an unpacked extension
npm run build
npm test               # 292 tests, including end-to-end runScan and the provider adapters
npm run check:cycles   # circular value imports become runtime TDZ errors

npm run package        # build + release/speedb-<version>.zip for the Web Store
npm run package:debug  # same, keeping source maps
npm run release        # test + package
```

`npm run package` validates the manifest version, refuses to ship a `key` or
`update_url`, and strips source maps from the upload.

### Debugging the bundle, not the source

Two runtime failures got through unit tests because the tests injected fakes at
the boundaries, so the real clients and adapters — and the module-init order of
everything only they pull in — were never loaded. `real-path.test.ts` now
exercises `runScan` with no injection at all, including the cost-estimate path
that only the store supplies.

Some failures are still bundle-only: minification reorders and renames, so a
use-before-declaration inside a closure can pass in Node and throw in the
extension. The preview build keeps a sourcemap and exposes the store as
`window.__speedb`, so a scan can be driven against the shipped bundle:

```js
window.__speedb.setState({ repoUrl: '…', secrets: { openaiKey: '…' } })
await window.__speedb.getState().startScan()
window.__speedb.getState().error   // null if it completed
```

To review the UI without loading the extension:

```bash
npx vite build --config vite.preview.config.ts
npx http-server dist-preview      # preview.html?screen=report|detail|settings|connect
                                  # &surface=panel  &theme=dark
```

## Docs

| File | Contents |
| --- | --- |
| `docs/PRD.md` | Problem, personas, 80+ numbered functional requirements, roadmap |
| `docs/TRD.md` | Architecture, ingestion, provider adapters, schemas, validator |
| `docs/UI-SPEC.md` | Design tokens, all 7 screens at both densities, a11y |

Help and the privacy policy ship inside the extension (`src/pages/`), reachable
from the footer on every screen. They are extension pages, not web-accessible
resources, so no website can read them.

## Layout

```
src/
  config/models.ts       fallback model list
  config/pricing.ts      per-model prices for the cost estimate
  config/explain.ts      per-engine EXPLAIN recipes and what to look for
  config/engines.ts      60+ engines, families, equivalence semantics
  core/
    types.ts             the Finding contract
    pipeline.ts          ingest → detect → analyse → ground
    repo/                GitHub + GitLab clients, URL parsing
    detect/              deterministic candidate extraction
    analyze/             prompt, response parsing, grounding validator
    providers/           one adapter per AI backend
    report/export.ts     Markdown / HTML / JSON / patch
    report/patch.ts      unified diffs
    report/cache.ts      scan cache + content-keyed chunk cache
    repo/tar.ts          in-browser tar.gz reader for archive ingest
    analyze/equivalence.ts  the same-output machine check
    analyze/performance.ts  the speed claim, and how to verify it
    analyze/schema-facts.ts declared tables/indexes + index checks
    analyze/sql-shape.ts    structural SQL reader
    detect/relevance.ts     tier two: data-access files with no visible query
  components/            screens and primitives
  store/app-store.ts     zustand state
  pages/                 help.html, privacy.html
  background/            MV3 service worker
scripts/package.mjs      Web Store zip
```
