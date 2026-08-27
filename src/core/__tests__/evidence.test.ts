import { describe, expect, it } from 'vitest'
import { parsePgExplain, totalsFor } from '../evidence/parse-pg-explain'
import { parseCatalog, mergeCatalogs } from '../evidence/parse-catalog'
import { parseQueryLog, normaliseShape } from '../evidence/parse-query-log'
import { comparePerformance } from '../evidence/compare'
import { checkStaleness } from '../evidence/types'
import { groundSchemaFacts, checkAgainstObserved } from '../evidence/merge'
import { buildSchemaFacts } from '../analyze/schema-facts'
import { isFixtureWorthy, toFixture } from '../evidence/to-fixture'
import type { Finding } from '../types'
import type { PerformanceVerdict } from '../evidence/types'

const NOW = Date.parse('2026-08-27T12:00:00Z')
const SHA = 'abc123def456'
const fresh = { capturedAt: '2026-08-27T11:00:00Z', environment: 'production' }

/* ------------------------------------------------------------- staleness -- */

describe('provenance decides whether evidence describes this code', () => {
  it('accepts a recent capture', () => {
    expect(checkStaleness(fresh, SHA, NOW).stale).toBe(false)
  })

  it('rejects a capture from a different commit, however recent', () => {
    /*
     * The dangerous case, and the reason a timestamp alone is not enough. A
     * plan captured ten minutes ago against a build that predates the rewrite
     * is fresh by the clock and describes different code. Rendering it as
     * "measured" is exactly the confident-wrong-number failure that
     * PRICES_VERIFIED_ON exists to prevent, with production data behind it.
     */
    const check = checkStaleness({ ...fresh, commitSha: 'zzz999' }, SHA, NOW)
    expect(check.stale).toBe(true)
    expect(check.reason).toMatch(/different code/)
  })

  it('rejects a capture dated in the future rather than treating it as current', () => {
    // A wrong date would otherwise be permanently fresh.
    const check = checkStaleness({ capturedAt: '2027-01-01T00:00:00Z' }, SHA, NOW)
    expect(check.stale).toBe(true)
    expect(check.reason).toMatch(/future/)
  })

  it('rejects an unreadable date instead of assuming it is fine', () => {
    expect(checkStaleness({ capturedAt: 'last tuesday' }, SHA, NOW).stale).toBe(true)
  })

  it('ages out an old capture and says how old', () => {
    const check = checkStaleness({ capturedAt: '2026-07-01T00:00:00Z' }, SHA, NOW)
    expect(check.stale).toBe(true)
    expect(check.reason).toMatch(/57 day/)
  })
})

/* ------------------------------------------------------------ plan parse -- */

const JSON_PLAN = JSON.stringify([{
  Plan: {
    'Node Type': 'Seq Scan',
    'Relation Name': 'orders',
    'Plan Rows': 1000,
    'Actual Rows': 40,
    'Actual Loops': 10,
    'Actual Total Time': 2.5,
    'Shared Read Blocks': 820,
    'Shared Hit Blocks': 12,
    'Rows Removed by Filter': 9600,
    Filter: '(tenant_id = 1)',
  },
  'Planning Time': 0.4,
  'Execution Time': 31.2,
}])

const TEXT_PLAN = `
 Sort  (cost=100.0..102.0 rows=800 width=32) (actual time=20.100..21.500 rows=800 loops=1)
   Sort Key: created_at
   Sort Method: external merge  Disk: 4096kB
   ->  Seq Scan on orders  (cost=0.00..80.0 rows=800 width=32) (actual time=0.100..18.200 rows=800 loops=1)
         Filter: (tenant_id = 1)
         Rows Removed by Filter: 9200
         Buffers: shared hit=12 read=820
 Planning Time: 0.400 ms
 Execution Time: 31.200 ms
`

describe('Postgres plan parsing', () => {
  it('reads the JSON form', () => {
    const { plan } = parsePgExplain(JSON_PLAN)
    expect(plan!.timed).toBe(true)
    expect(plan!.root.nodeType).toBe('Seq Scan')
    expect(plan!.root.relation).toBe('orders')
    expect(plan!.planningMs).toBe(0.4)
  })

  it('multiplies per-loop rows and time by the loop count', () => {
    /*
     * Postgres reports Actual Rows and Actual Total Time *per loop*. A query
     * inside a loop that ran 10 times reports 40 rows, not 400 — so comparing
     * it raw against a batched rewrite's 400 rows would read as a tenfold
     * regression, and the N+1 case (the highest-value finding this tool
     * produces) would invert.
     */
    const { plan } = parsePgExplain(JSON_PLAN)
    expect(plan!.root.loops).toBe(10)
    expect(plan!.root.actualRows).toBe(400)      // 40 per loop x 10
    expect(plan!.root.actualTotalMs).toBe(25)    // 2.5 per loop x 10
  })

  it('reads the text form people actually paste, tree and all', () => {
    // Refusing psql output would mean the feature only works for people who
    // read the instructions before running the command.
    const { plan } = parsePgExplain(TEXT_PLAN)
    expect(plan!.root.nodeType).toBe('Sort')
    expect(plan!.root.children[0]!.nodeType).toBe('Seq Scan')
    expect(plan!.root.children[0]!.relation).toBe('orders')
    expect(plan!.root.children[0]!.blocksRead).toBe(820)
    expect(plan!.root.children[0]!.rowsRemovedByFilter).toBe(9200)
    expect(plan!.root.sortMethod).toMatch(/external merge/)
    expect(plan!.totalMs).toBe(31.2)
  })

  it('marks an untimed plan as untimed rather than inventing measurements', () => {
    const { plan, notes } = parsePgExplain(
      ' Seq Scan on orders  (cost=0.00..80.0 rows=800 width=32)\n',
    )
    expect(plan!.timed).toBe(false)
    expect(plan!.root.actualRows).toBeUndefined()
    // Estimates are not measurements, and filling the gap from them would
    // produce a comparison that looks measured and is not.
    expect(plan!.root.estimatedRows).toBe(800)
    expect(notes.join(' ')).toMatch(/not what happened/)
  })

  it('rejects text that is not a plan, with a usable instruction', () => {
    const { plan, error } = parsePgExplain('the query is slow, please help')
    expect(plan).toBeNull()
    expect(error).toMatch(/FORMAT JSON/)
  })

  it('totals blocks and finds disk sorts across the whole tree', () => {
    const { plan } = parsePgExplain(TEXT_PLAN)
    const t = totalsFor(plan!)
    expect(t.blocksRead).toBe(820)
    expect(t.scanNodes).toEqual(['orders'])
    // `external merge` means it spilled. A quicksort in memory was never the
    // cost, whatever the finding argued.
    expect(t.diskSorts).toHaveLength(1)
    expect(t.hasBuffers).toBe(true)
  })

  it('knows when buffers were never captured', () => {
    const { plan } = parsePgExplain(JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan' } }]))
    expect(totalsFor(plan!).hasBuffers).toBe(false)
  })
})

/* -------------------------------------------------------------- compare -- */

function plan(json: object) {
  return parsePgExplain(JSON.stringify([json])).plan!
}

const base = { scannedCommitSha: SHA, now: NOW }

describe('the four verdicts', () => {
  it('confirms a scan that became an index scan with fewer blocks read', () => {
    const v = comparePerformance({
      ...base,
      original: { plan: plan({ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Shared Read Blocks': 8400, 'Actual Total Time': 120, 'Actual Loops': 1 }, 'Execution Time': 120 }), provenance: fresh },
      proposed: { plan: plan({ Plan: { 'Node Type': 'Index Scan', 'Relation Name': 'orders', 'Shared Read Blocks': 12, 'Actual Total Time': 3, 'Actual Loops': 1 }, 'Execution Time': 3 }), provenance: fresh },
    })
    expect(v.kind).toBe('confirmed')
    expect(v.because.join(' ')).toMatch(/8400 -> 12/)
    // Every reason cites the metric and both numbers, so the reader can
    // disagree with the arithmetic rather than with an adjective.
    expect(v.because.join(' ')).toMatch(/120.0ms -> 3.0ms/)
  })

  it('reports a regression when the rewrite reads more', () => {
    const v = comparePerformance({
      ...base,
      original: { plan: plan({ Plan: { 'Node Type': 'Index Scan', 'Shared Read Blocks': 100, 'Actual Total Time': 5, 'Actual Loops': 1 }, 'Execution Time': 5 }), provenance: fresh },
      proposed: { plan: plan({ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Shared Read Blocks': 9000, 'Actual Total Time': 90, 'Actual Loops': 1 }, 'Execution Time': 90 }), provenance: fresh },
    })
    expect(v.kind).toBe('regression')
    expect(v.because.join(' ')).toMatch(/introduces a sequential scan/)
  })

  it('calls a mixed result a regression rather than an improvement', () => {
    /*
     * Better on one metric, worse on another. Reporting that as "confirmed"
     * because something improved is the exact overstatement this product
     * exists to avoid — the reader has to make the trade-off, and they cannot
     * if the verdict already made it for them.
     */
    const v = comparePerformance({
      ...base,
      original: { plan: plan({ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'o', 'Shared Read Blocks': 5000, 'Actual Total Time': 10, 'Actual Loops': 1 }, 'Execution Time': 10 }), provenance: fresh },
      proposed: { plan: plan({ Plan: { 'Node Type': 'Index Scan', 'Shared Read Blocks': 100, 'Actual Total Time': 400, 'Actual Loops': 1 }, 'Execution Time': 400 }), provenance: fresh },
    })
    expect(v.kind).toBe('regression')
    expect(v.because.join(' ')).toMatch(/helps on one metric and hurts on another/)
  })

  it('separates "nothing moved" from "nothing was measured"', () => {
    // These are different answers and collapsing them would hide the most
    // common honest outcome. One is a finished measurement that refutes a
    // speed claim; the other is an absence of one.
    const same = comparePerformance({
      ...base,
      original: { plan: plan({ Plan: { 'Node Type': 'Index Scan', 'Shared Read Blocks': 500, 'Actual Total Time': 10, 'Actual Loops': 1 }, 'Execution Time': 10 }), provenance: fresh },
      proposed: { plan: plan({ Plan: { 'Node Type': 'Index Scan', 'Shared Read Blocks': 505, 'Actual Total Time': 10.2, 'Actual Loops': 1 }, 'Execution Time': 10.2 }), provenance: fresh },
    })
    expect(same.kind).toBe('no-difference')

    const none = comparePerformance({
      ...base,
      original: { plan: plan({ Plan: { 'Node Type': 'Seq Scan' } }), provenance: fresh },
    })
    expect(none.kind).toBe('insufficient-evidence')
    expect(none.missing).toContain('A capture for the proposed version.')
  })

  it('treats a small percentage change as noise, not a result', () => {
    // A 4% change between two single samples is run-to-run variance — the same
    // variance that dominated every measurement in the benchmark.
    const v = comparePerformance({
      ...base,
      original: { plan: plan({ Plan: { 'Node Type': 'Index Scan', 'Shared Read Blocks': 1000, 'Actual Total Time': 10, 'Actual Loops': 1 }, 'Execution Time': 10 }), provenance: fresh },
      proposed: { plan: plan({ Plan: { 'Node Type': 'Index Scan', 'Shared Read Blocks': 1040, 'Actual Total Time': 10.3, 'Actual Loops': 1 }, 'Execution Time': 10.3 }), provenance: fresh },
    })
    expect(v.kind).toBe('no-difference')
    expect(v.because.join(' ')).toMatch(/within noise/)
  })

  it('refuses to answer a round-trip claim with a query plan', () => {
    // A plan describes one statement; the claim is about how many statements
    // run. Answering it with a plan is how a verification step becomes a ritual.
    const v = comparePerformance({
      ...base,
      category: 'n-plus-one',
      original: { plan: plan({ Plan: { 'Node Type': 'Index Scan' } }), provenance: fresh },
      proposed: { plan: plan({ Plan: { 'Node Type': 'Index Scan' } }), provenance: fresh },
    })
    expect(v.kind).toBe('insufficient-evidence')
    expect(v.because.join(' ')).toMatch(/cannot answer that/)
    expect(v.missing!.join(' ')).toMatch(/CaptureQueriesContext/)
  })

  it('confirms a round-trip claim from query counts', () => {
    const v = comparePerformance({
      ...base,
      category: 'n-plus-one',
      original: { log: { count: 401, shapes: [], totalMs: 900 }, provenance: fresh },
      proposed: { log: { count: 1, shapes: [], totalMs: 40 }, provenance: fresh },
    })
    expect(v.kind).toBe('confirmed')
    expect(v.because.join(' ')).toMatch(/400 fewer round trip/)
    expect(v.because.join(' ')).toMatch(/measured rather than counted from source/)
  })

  it('refutes a round-trip claim whose rewrite issues more', () => {
    const v = comparePerformance({
      ...base,
      original: { log: { count: 2, shapes: [] }, provenance: fresh },
      proposed: { log: { count: 5, shapes: [] }, provenance: fresh },
    })
    expect(v.kind).toBe('regression')
  })

  it('reports a verdict built on stale evidence, but marks it', () => {
    // Reported rather than withheld — the measurement happened. Marked, so it
    // is never read as current.
    const v = comparePerformance({
      ...base,
      original: { log: { count: 400, shapes: [] }, provenance: { ...fresh, commitSha: 'other999' } },
      proposed: { log: { count: 1, shapes: [] }, provenance: fresh },
    })
    expect(v.kind).toBe('confirmed')
    expect(v.stale).toBe(true)
    expect(v.because.join(' ')).toMatch(/not current/)
  })

  it('says so when neither plan carries buffers', () => {
    const v = comparePerformance({
      ...base,
      original: { plan: plan({ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'o' } }), provenance: fresh },
      proposed: { plan: plan({ Plan: { 'Node Type': 'Index Scan' } }), provenance: fresh },
    })
    expect(v.because.join(' ')).toMatch(/Neither plan reports buffers/)
    // The access-path change is still real and still reported — it just is not
    // a measured speed-up.
    expect(v.kind).toBe('confirmed')
    expect(v.because.join(' ')).toMatch(/not what happened/)
  })
})

/* --------------------------------------------------------------- catalog -- */

describe('the live catalog, versus what migrations declare', () => {
  const PG_INDEXES = `
 indexname          | indexdef
--------------------+-------------------------------------------------------------------
 orders_pkey        | CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)
 orders_tenant_idx  | CREATE INDEX orders_tenant_idx ON public.orders USING btree (tenant_id, created_at)
 orders_lower_email | CREATE INDEX orders_lower_email ON public.orders USING btree (lower(email))
(3 rows)
`

  it('reads pg_indexes, including composite column order', () => {
    const { catalog } = parseCatalog(PG_INDEXES)
    const composite = catalog.indexes.find((i) => i.name === 'orders_tenant_idx')!
    // Order is what makes a prefix redundant, so it has to survive parsing.
    expect(composite.columns).toEqual(['tenant_id', 'created_at'])
    expect(catalog.indexes.find((i) => i.name === 'orders_pkey')!.unique).toBe(true)
  })

  it('does not treat an expression index as covering its bare column', () => {
    // `lower(email)` does not serve a lookup on `email`. Silently treating it
    // as covering would suppress a real finding.
    const { catalog, notes } = parseCatalog(PG_INDEXES)
    const expr = catalog.indexes.find((i) => i.name === 'orders_lower_email')!
    expect(expr.columns).toEqual(['lower(email)'])
    expect(notes.join(' ')).toMatch(/does not serve a lookup/)
  })

  it('reads SHOW INDEX, collapsing one row per column into one index', () => {
    const { catalog } = parseCatalog(`
Table,Non_unique,Key_name,Seq_in_index,Column_name
orders,0,PRIMARY,1,id
orders,1,idx_tenant,1,tenant_id
orders,1,idx_tenant,2,created_at
`)
    const idx = catalog.indexes.find((i) => i.name === 'idx_tenant')!
    expect(idx.columns).toEqual(['tenant_id', 'created_at'])
    expect(catalog.indexes.find((i) => i.name === 'PRIMARY')!.unique).toBe(true)
  })

  it('warns that a zero scan count may mean "not measured"', () => {
    const { catalog, notes } = parseCatalog(`
relname,indexrelname,idx_scan
orders,orders_unused_idx,0
`)
    expect(catalog.indexes[0]!.scans).toBe(0)
    // Dropping an index on a zero count taken shortly after a stats reset is
    // an outage rather than a saving.
    expect(notes.join(' ')).toMatch(/not measured.*not.*not used|stats_reset/i)
  })

  it('merges a definition capture with a usage capture', () => {
    // One names the columns, the other names the usage. Neither should
    // overwrite the other's half.
    const defs = parseCatalog(PG_INDEXES).catalog
    const usage = parseCatalog('relname,indexrelname,idx_scan\norders,orders_tenant_idx,91234\n').catalog
    const merged = mergeCatalogs([defs, usage])
    const idx = merged.indexes.find((i) => i.name === 'orders_tenant_idx')!
    expect(idx.columns).toEqual(['tenant_id', 'created_at'])
    expect(idx.scans).toBe(91234)
  })

  it('rejects unrecognised input with the commands that would work', () => {
    const { error } = parseCatalog('here are my indexes I think')
    expect(error).toMatch(/pg_indexes/)
    expect(error).toMatch(/SHOW INDEX/)
  })
})

/* ----------------------------------------------------------------- merge -- */

describe('grounding index advice in the live catalog', () => {
  const migration = {
    path: 'migrations/0001_init.sql',
    content: 'CREATE TABLE orders (id int, tenant_id int, created_at timestamp);\nCREATE INDEX orders_tenant_idx ON orders (tenant_id);',
  }

  it('marks an index that both declares and observes as the strongest fact', () => {
    const facts = buildSchemaFacts([migration])
    const observed = parseCatalog('relname,indexrelname,idx_scan\norders,orders_tenant_idx,5\n').catalog
    // The usage capture has no columns; matching falls back to the name.
    const grounded = groundSchemaFacts(facts, observed)
    expect(grounded.indexes.find((i) => i.name === 'orders_tenant_idx')!.origin).toBe('both')
  })

  it('surfaces an index no migration declares — the case migrations cannot show', () => {
    /*
     * A hand-added index from an incident, one created concurrently outside the
     * migration tool, or one whose migration lives in another repository. Every
     * one of them is a reason an index suggestion would have been wrong, and
     * source code cannot contain any of them.
     */
    const facts = buildSchemaFacts([migration])
    const observed = parseCatalog(`
 indexname | indexdef
-----------+-----------------------------------------------------------
 hotfix_ix | CREATE INDEX hotfix_ix ON public.orders USING btree (email)
`).catalog
    const grounded = groundSchemaFacts(facts, observed)
    const found = grounded.indexes.find((i) => i.name === 'hotfix_ix')!
    expect(found.origin).toBe('observed')
    expect(found.source.file).toBe('(live database)')
  })

  it('kills a proposal for an index that already exists in production', () => {
    const facts = buildSchemaFacts([migration])
    const observed = parseCatalog(`
 indexname | indexdef
-----------+--------------------------------------------------------------
 live_ix   | CREATE INDEX live_ix ON public.orders USING btree (email, id)
`).catalog
    const grounded = groundSchemaFacts(facts, observed)

    expect(checkAgainstObserved('orders', ['email', 'id'], grounded).alreadyExists).toBe(true)
    // Leading-prefix containment holds against the live catalog too.
    const prefix = checkAgainstObserved('orders', ['email'], grounded)
    expect(prefix.alreadyExists).toBe(true)
    expect(prefix.notes.join(' ')).toMatch(/already leads with these columns/)
  })

  it('refuses to conclude absence for a table the capture never looked at', () => {
    /*
     * The asymmetry that matters most. A paste of `pg_indexes WHERE tablename =
     * 'orders'` says nothing about `users`. Treating a partial capture as a
     * complete catalog would invent a missing index — a false positive created
     * by the very feature meant to remove them.
     */
    const grounded = groundSchemaFacts(buildSchemaFacts([migration]), parseCatalog(`
 indexname | indexdef
-----------+-------------------------------------------------------
 o_ix      | CREATE INDEX o_ix ON public.orders USING btree (email)
`).catalog)

    const verdict = checkAgainstObserved('users', ['email'], grounded)
    expect(verdict.tableWasObserved).toBe(false)
    expect(verdict.alreadyExists).toBe(false)
    expect(verdict.notes.join(' ')).toMatch(/not an index that is absent/)
  })

  it('warns when the leading column is not selective enough to be used', () => {
    const grounded = groundSchemaFacts(buildSchemaFacts([migration]), parseCatalog(`
tablename,attname,n_distinct,null_frac,avg_width
orders,is_active,2,0,1
`).catalog)
    const verdict = checkAgainstObserved('orders', ['is_active'], grounded)
    expect(verdict.notes.join(' ')).toMatch(/2 distinct value/)
    expect(verdict.notes.join(' ')).toMatch(/planner may ignore this index/)
  })

  it('warns when the table is too small for an index to pay', () => {
    const grounded = groundSchemaFacts(buildSchemaFacts([migration]), parseCatalog(`
relname,seq_scan,idx_scan,n_live_tup
orders,900,4,120
`).catalog)
    const verdict = checkAgainstObserved('orders', ['email'], grounded)
    expect(verdict.notes.join(' ')).toMatch(/120 live row/)
    expect(verdict.notes.join(' ')).toMatch(/sequential scan is usually the correct plan/)
  })

  it('shrinks the unknowable list by exactly what was supplied', () => {
    const facts = buildSchemaFacts([migration])
    const before = groundSchemaFacts(facts, null)
    expect(before.unknowable.some((u) => u.startsWith('Row counts'))).toBe(true)

    const after = groundSchemaFacts(facts, parseCatalog(
      'relname,seq_scan,idx_scan,n_live_tup\norders,900,4,4000000\n',
    ).catalog)
    expect(after.unknowable.some((u) => u.startsWith('Row counts'))).toBe(false)
    // And no further. Removing a line the capture did not answer would be the
    // same overstatement the list exists to prevent.
    expect(after.unknowable.some((u) => u.startsWith('Column selectivity'))).toBe(true)
  })
})

/* ------------------------------------------------------------- query log -- */

describe('query logs', () => {
  it('counts Django captured queries and their total time', () => {
    const { log } = parseQueryLog(JSON.stringify([
      { sql: "SELECT * FROM review WHERE product_id = 1", time: '0.001' },
      { sql: "SELECT * FROM review WHERE product_id = 2", time: '0.001' },
    ]))
    expect(log!.count).toBe(2)
    expect(log!.totalMs).toBe(2)
  })

  it('collapses a repeated shape, which is what makes an N+1 visible', () => {
    // 400 lines become "one shape ran 400 times" — the round-trip count stated
    // as a measurement rather than inferred from a `for` nine lines above.
    const lines = Array.from({ length: 400 }, (_, i) => `SELECT * FROM review WHERE product_id = ${i}`)
    const { log, notes } = parseQueryLog(lines.join('\n'))
    expect(log!.count).toBe(400)
    expect(log!.shapes[0]!.count).toBe(400)
    expect(notes.join(' ')).toMatch(/ran 400 times/)
  })

  it('normalises literals out of the shape, which also removes the data', () => {
    /*
     * A log paste is the most sensitive thing this product handles: bound
     * parameters are production row values. The comparison only needs the
     * shape, so only the shape is what gets stored or shown.
     */
    const shape = normaliseShape("SELECT * FROM users WHERE email = 'someone@real.com' AND id IN (1, 2, 3)")
    expect(shape).not.toMatch(/someone@real.com/)
    expect(shape).toBe('SELECT * FROM users WHERE email = ? AND id IN (?)')
  })

  it('treats IN-lists of different lengths as one shape', () => {
    expect(normaliseShape('SELECT a FROM t WHERE id IN (1,2)'))
      .toBe(normaliseShape('SELECT a FROM t WHERE id IN (7,8,9,10,11)'))
  })

  it('reads Prisma and Rails log lines', () => {
    expect(parseQueryLog('prisma:query SELECT "public"."User"."id" FROM "public"."User"').log!.count).toBe(1)
    expect(parseQueryLog('  Product Load (0.4ms)  SELECT "products".* FROM "products"').log!.count).toBe(1)
  })

  it('rejects text with no statements, naming what it accepts', () => {
    const { error } = parseQueryLog('it ran a lot of queries')
    expect(error).toMatch(/CaptureQueriesContext|captured_queries/)
  })
})

/* --------------------------------------------------------------- fixture -- */

describe('a refuted finding becomes a benchmark fixture', () => {
  const finding = {
    id: 'f1',
    category: 'missing-index',
    engine: 'postgres',
    severity: 'high',
    modelSeverity: 'low',
    title: 'Add an index on orders(tenant_id)',
    original: 'SELECT * FROM orders WHERE tenant_id = $1',
    primaryOccurrence: { file: 'app/views.py', startLine: 42, endLine: 42, excerpt: '' },
    suggestion: { proposed: 'CREATE INDEX ON orders (tenant_id)' },
    triageSupport: { flagged: 3, samples: 3 },
    performance: { counted: ['Transfers 3 fewer columns.'], status: 'questionable', refutes: ['The planner ignores it.'] },
    grounding: 'verified',
  } as unknown as Finding

  const verdict = (kind: PerformanceVerdict['kind']): PerformanceVerdict => ({
    kind, because: ['Blocks read: 8400 -> 8390, within noise.'], basedOn: [], stale: false,
  })

  it('exports a regression and a no-difference', () => {
    expect(isFixtureWorthy(verdict('regression'))).toBe(true)
    expect(isFixtureWorthy(verdict('no-difference'))).toBe(true)
  })

  it('does not export a confirmation or a missing capture', () => {
    /*
     * `confirmed` is the expected outcome and adds nothing to a corpus of
     * things that went wrong. `insufficient-evidence` is a statement about the
     * capture, not the finding — exporting it as a negative would teach the
     * gate to suppress findings whose evidence merely was not gathered.
     */
    expect(isFixtureWorthy(verdict('confirmed'))).toBe(false)
    expect(isFixtureWorthy(verdict('insufficient-evidence'))).toBe(false)
    expect(toFixture({ finding, verdict: verdict('confirmed'), repo: 'r', commitSha: SHA, at: '2026-08-27' })).toBeNull()
  })

  it('records what the tool believed at the time, not just that it was wrong', () => {
    const out = toFixture({ finding, verdict: verdict('no-difference'), repo: 'acme/api', commitSha: SHA, at: '2026-08-27' })!
    const body = JSON.parse(out.content)

    // A false positive the gate rated `high`, with counted facts and 3-of-3
    // triage support, is a far more interesting fixture than one it already
    // half-doubted — and nothing later can tell them apart unless this is kept.
    expect(body.finding.severity).toBe('high')
    expect(body.finding.triageSupport).toEqual({ flagged: 3, samples: 3 })
    expect(body.finding.countedFacts).toHaveLength(1)
    // And whether the recipe predicted this failure mode. If it did not, that
    // is a second defect worth its own fix.
    expect(body.predictedRefutations).toEqual(['The planner ignores it.'])
  })

  it('does not put the raw capture in a file destined for a git repository', () => {
    const out = toFixture({ finding, verdict: verdict('regression'), repo: 'acme/api', commitSha: SHA, at: '2026-08-27' })!
    // Plan output carries production row values in its filter conditions.
    expect(out.content).not.toMatch(/EXPLAIN|Filter:|Index Cond/)
    expect(JSON.parse(out.content).evidence).toEqual(['Blocks read: 8400 -> 8390, within noise.'])
  })
})
