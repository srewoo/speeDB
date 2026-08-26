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
ingest ──► profile ──► detect ──────► analyse ──► ground ──────► gate
1 archive  what the   rules on       LLM, only   citations      worthless
request    repo says  masked source, on ranked   re-checked;    findings held
           it uses    ranked by      candidates  queries        back with a
                      priority                   compared       stated reason
```

**Ingest is one request.** The whole repository arrives as a single gzipped
tarball, gunzipped in the browser via `DecompressionStream` and parsed by a
small TAR reader. Two hosts are needed for this on GitHub, not one: the tarball
endpoint on `api.github.com` answers with a 302 to `codeload.github.com`, and a
redirect to an ungranted host is a CORS failure. Both are in `host_permissions`.
When the archive request does fail the scan still completes via the per-file
path, and now says which and why — that fallback costs three orders of magnitude
more API calls, so a silent one is a bug rather than a graceful degradation. The naive one-request-per-file approach costs 2,000 of
GitHub's 5,000/hour budget on a 2,000-file repo, which makes a second scan
impossible. Per-file reads remain as a fallback when the archive endpoint
cannot serve.

**The engine profile is read once, before detection.** A repository states its
data stores in a handful of well-known files — `settings.py`, `database.yml`,
`application.properties`, `schema.prisma`, `package.json`, `go.mod`,
`docker-compose.yml` — and those statements are facts rather than guesses.
Without that prior, engine labelling falls back to whichever regex shouted
loudest, and a Django/MySQL project acquires MongoDB, Hive, BigQuery, Redshift
and OpenSearch findings for stores it has never connected to. A genuine dialect
marker (`ON CONFLICT`, `ROWNUM`, `PREWHERE`) is evidence about *that statement*
and still wins outright; engine *vocabulary* does not. The profile is printed in
the report header, with the file and line that declared it, so a wrong inference
is visible rather than silent.

**Analysis passes are small, on a hypothesis rather than a measurement.** The
reasoning is that a model asked to review 290 code excerpts in one response
skims where one asked to review 25 reads, so `sitesPerPass` defaults to 25. Five
runs over the same repository with the same model at temperature 0 found the two
known high-severity defects 0, 0, 2, 2 and 0 times — and the successes and
failures span both large and small pass sizes. Run-to-run variance swamped the
configuration effect, so this is a considered default and not a proven one.

**Detect is deterministic and free**, and runs in two tiers.

*Only files that can hold a query are read.* Two filters, at different stages.
At ingest: images, PDFs, video, fonts, archives, binaries, lockfiles,
`node_modules/`, `vendor/`, `dist/`, and anything over 512 KB. At detection:
prose (`md`, `rst`, `po`, `csv`), stylesheets, translation catalogues, build
wrappers, and files with no extension at all. `.yml` and `.json` are deliberately
*not* excluded — a dbt model or a Liquibase changelog is a real query — and
`Rakefile` and `Gemfile` are kept because they are Ruby. Across five real
repositories this leaves 8 candidates in irrelevant file types out of 13,762.

*Rules match masked source.* Comments are blanked for every rule — a comment is
never a query, and `# TODO: migrate to opensearch` used to set the engine for
the whole span it sat in. String bodies stay visible by default, because a SQL,
CQL or Cypher statement lives inside a string literal by definition; the rules
that match a bare engine *name* opt out of seeing them. Masking replaces
interiors with spaces of equal length, so every character offset — and therefore
every line number — is preserved exactly.

*Candidates are ranked before they are capped, and the two signals are
different.* `confidence` answers "is this a query?" and is what the floor gates
on. `priority` answers "is this likely to matter?" — a query inside a loop in a
request handler outranks everything; code in a migration, seed or test outranks
nothing. The per-file cap applies to priority. Capping by line order instead
meant that in a file whose cheap queries sit at the top and whose expensive
report view sits at the bottom — the normal shape of a large `views.py` — the
cap systematically discarded the interesting half. When the cap does bite, the
report names the file and says how many sites it kept.

*Every candidate carries its enclosing scope.* Loop nesting, the nearest
enclosing symbol, and what triggers the path — read lexically, by indentation
for Python/Ruby/Elixir and by brace balance for everything else. Without it a
query at module scope and a query inside a triple-nested loop reached the model
as the same shape of evidence, six lines of context wide, so a `for` nine lines
above was invisible and the N+1 category was unreachable except by luck. The
loop headers are prepended to the excerpt as an elided prefix rather than
widening the context window for every candidate.

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

## Most data access is not SQL text

`readSqlShape()` reads statements. Django, Rails, Hibernate, Prisma, SQLAlchemy,
GORM, EF Core, Sequelize and TypeORM are not statements, and for a long time
every one of them fell into a dead branch: *"Not machine-checkable — non-SQL
engine or unsupported syntax."* The two best checks in the product were switched
off exactly where most users need them, and the performance block degraded to
offering `EXPLAIN ANALYZE` against JavaScript string concatenation.

`readOrmShape()` is the same idea one level up. It does not try to understand the
query; it counts round trips and compares projections, and both are decidable
from text:

| Property | Decidable on ORM code? | How |
| --- | --- | --- |
| projection | yes | compare `values()` / `only()` / `select` / `pluck` field lists |
| duplicate handling | yes | `.distinct()` on both sides |
| row ordering | yes | `.order_by()` / `.order()` / `orderBy` present and identical |
| row limit | yes | slice, `.limit()`, `take` |
| result cardinality | yes | the terminal op (`count` / `first` / `all`) unchanged |
| predicate equivalence | **no** | undecidable — reported as undecided, never as verified |
| N+1 → batch rewrite | partly | the row set is provably the union; the caller's read of it is the named guard |

So a report that used to say "not measured, not machine-checkable" thirteen times
now says *"issues 1 database call where the original issues 2, counted from the
code, not measured"*. The honesty framing is untouched: still a count, never a
timing, and still labelled as one.

And the verification step is the instrument that fits the stack —
`CaptureQueriesContext` for Django, `assert_queries` for ActiveRecord,
`log: ['query']` for Prisma, `Statistics.getQueryExecutionCount()` for
Hibernate. `EXPLAIN` is never offered for something you cannot run it against.

## Analysis is two stages, and the first one has to account for everything

A single request that both decides what is a problem and writes it up produced
about three and a half findings per pass regardless of how many sites the pass
contained, and missed defects sitting at the top of its own input. Nothing in
the contract required it to say anything about a given site, so skipping one was
free and invisible.

**Triage** returns one verdict per site — `problem`, `clean` or `unsure` — at
roughly thirty tokens each, and the parser reconciles the response against the
ids that were sent. A site nobody answered for is escalated, never assumed
clean; an invented id is reported rather than trusted. Accounting for a hundred
sites costs less than writing three findings did.

**Authoring** runs only on flagged sites, a few at a time, with the triage
reason already stated and the full schema for grounding. It is explicitly
allowed to disagree — an accounting contract that turns into a quota is how a
report fills up with findings nobody needed.

Triage can also be **sampled**: run it three times and take the union of what is
flagged. Run-to-run variance was the largest single term in the measurements —
the same configuration found 0 and 2 of the same two defects on different runs —
and triage output is small enough that three samples cost less than one
authoring request. Default is one; nobody pays for it unasked.

## The value gate

Grounding proves the citations are real. It says nothing about whether a finding
is worth reading, and five kinds of worthless survived it untouched:

| Reason | What it catches |
| --- | --- |
| `no-op` | `proposed` is identical to `original` once whitespace is collapsed |
| `wrong-direction` | a round-trip claim whose rewrite issues no fewer queries |
| `not-data-access` | neither side parses as a statement or as ORM data access |
| `cold-path` | a pure performance claim in a migration, seed or test |
| `unsupported-assumption` | a stated assumption the file itself contradicts, cited by line |
| `immaterial` | a column narrowing on a query that runs once, with nothing else behind it |
| `invented-symbol` | the proposal accesses a name that appears nowhere in the repository, so it would fail at runtime |

Severity is then **derived from evidence, in both directions** — not clamped.
A ceiling was not enough: across 27 findings from three real runs, not one came
out above `low`, because the model rated almost everything `low` and a ceiling
can only agree. The inputs are all things the tool computed and can defend — the
trigger and loop depth read from the fetched file, the structural facts counted
from the two versions. A query that runs once per iteration on a request path is
`high`; anything in a migration or a test is `info`. The model's own rating is
kept as `modelSeverity`, beside the answer rather than in it.

Recomputed over those 27 findings, the distribution went from `info 5, low 22` to
`high 7, medium 9, low 8, info 3`, and all five findings touching a
human-verified defect moved out of `low`. Reading only the `high` band gives 3 of
7 real, against 4 of 23 reading everything.

Suppressed findings are **kept, with their reason**, and rendered in a collapsed
section of the report. A gate that silently eats a true positive is worse than
the padding it removes, and the only way to know which it did is to be able to
read what it held back.

An empty report is stated as the good outcome it usually is, rather than as an
absence.

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
and labelled as a projection. A model with no listed price shows a token
estimate and no dollar figure — a confident wrong number is worse than none.

No provider exposes prices in an API, so `src/config/pricing.ts` is a table, and
a table goes stale. Two consequences are handled explicitly. It carries
`PRICES_VERIFIED_ON`, shown next to every figure, and that date means *last
checked against the provider's pricing page* — not last edited. And the lookup
refuses a prefix match whose remainder is anything other than a date or a
channel, because the cheap variants extend their parent's id: `gpt-4o-mini`
matching `gpt-4o` quoted $2.50/$10 for a model that costs $0.15/$0.60, sixteen
times over, presented as a fact. `mini`, `nano` and `lite` can no longer be
absorbed into a prefix; an unlisted model falls back to "no price", which is the
designed outcome rather than a failure.

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
npm test               # 559 tests, including end-to-end runScan and the provider adapters
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

## The benchmark

A fix is only real if it moves a number, so `bench/` defines the numbers: five
repositories spanning the access styles that break detection in different ways,
plus a negative control with no data layer that must report zero findings in
words.

```sh
npm run bench:pin                                    # pin every repo to a SHA
npm run bench:detect -- --repo mt-test-studio --path ~/src/mt-test-studio
npm run bench -- --repo mt-test-studio --no-llm       # free: detection metrics only
npm run bench                                        # full, needs a scan + an audit
```

Ground truth is a Claude audit of the same commit, blind to speeDB's output
(`bench/AUDIT_PROMPT.md`), human-adjudicated where the two disagree. Every metric
carries a gate, and `npm run bench` exits non-zero when one fails.

`--no-llm` scores **candidate coverage**, **engine accuracy** and **cold-path
share** without spending a token, because all three are decided before the model
runs. Candidate coverage is the one to watch first: it isolates detection from
the model entirely, and if a real N+1 never becomes a candidate then no prompt
change can recover it and every other metric is downstream of it.

Two things cannot be synthesised — a pinned commit and a human-adjudicated audit
of it — so `bench/score.mjs` refuses to report a green run without both, and says
which is missing. An unscored benchmark is not a passing one.

All six repositories are pinned and run; two are scored against a truth file. Over 953 real files, candidate coverage
went from **0/3 to 3/3** and engine accuracy from ~60% to **100%**; 195
candidates in changelogs and translation catalogues went to zero, and so did the
16 candidates labelled with a store the repository has never connected to. The
run also found three precision defects no fixture would have — prose files
consuming a fifth of the analysis budget, docstrings feeding English to the
dialect rules, and case-insensitive SQL keywords matching ordinary sentences.
`real-repo-precision.test.ts` holds the regressions, using the verbatim strings
that caused them.

## Docs

| File | Contents |
| --- | --- |
| `docs/PRD.md` | Problem, personas, 80+ numbered functional requirements, roadmap |
| `docs/TRD.md` | Architecture, ingestion, provider adapters, schemas, validator |
| `docs/UI-SPEC.md` | Design tokens, all 7 screens at both densities, a11y |
| `fix.md` | The reproduced failure that motivated the ranking, scope, engine-profile, ORM-shape and gate work, and the benchmark that measures it |
| `bench/README.md` | How to pin, audit, run and score the benchmark |

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
    detect/mask.ts          comment/string masking, offset-preserving
    detect/scope.ts         loop depth, enclosing symbol, what triggers it
    detect/priority.ts      the ranking signal, distinct from confidence
    detect/engine-profile.ts what the repository declares it connects to
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
    analyze/orm-shape.ts    round trips and projections, for non-SQL data access
    analyze/gate.ts         the value gate: what does not get published, and why
  components/            screens and primitives
  store/app-store.ts     zustand state
  pages/                 help.html, privacy.html
  background/            MV3 service worker
scripts/package.mjs      Web Store zip
bench/                   the five-repo benchmark, its gates and its baseline
```
