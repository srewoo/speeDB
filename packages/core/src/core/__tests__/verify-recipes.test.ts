import { describe, expect, it } from 'vitest'
import { recipeFor, explainFor } from '@/config/explain'
import { CATEGORY_OVERLAYS, overlayFor } from '@/config/verify/by-category'
import { checkPerformance } from '../analyze/performance'
import { ENGINES, FAMILIES } from '@/config/engines'
import type { FindingCategory } from '../types'

/**
 * Verification recipes, asserted against the claim they are supposed to test.
 *
 * There is already a test asserting that every engine in the registry has an
 * EXPLAIN recipe, and it passed throughout — because it checks the wrong
 * dimension. A recipe is `(category, engine)`, and the engine half was the only
 * half anything checked. So a `plan-cache-miss` finding on Postgres shipped
 * with "look for Seq Scan becoming Index Scan", which is a real instruction
 * that cannot answer the question, and no test disagreed.
 *
 * The category half is asserted here. The important cases are not "does a
 * recipe exist" — the family default always exists — but "is the recipe
 * *different from* the generic one where the generic one is known to be wrong",
 * and "does it say what would prove it wrong".
 */

const ALL_CATEGORIES: FindingCategory[] = [
  'missing-index', 'redundant-index', 'full-scan', 'n-plus-one',
  'over-fetch', 'unbounded-result', 'plan-cache-miss', 'round-trip',
  'inefficient-join', 'implicit-cast', 'sort-in-memory', 'batching',
  'transaction-scope', 'connection-handling', 'other',
]

/**
 * Categories whose mechanism a query plan cannot test.
 *
 * Each was shipping the family EXPLAIN recipe. A reader following it would run
 * the command, get a plan that looked fine, and conclude the finding was wrong.
 */
const PLAN_CANNOT_ANSWER: { category: FindingCategory; engine: string; family: any }[] = [
  { category: 'plan-cache-miss', engine: 'postgres', family: 'rdbms' },
  { category: 'plan-cache-miss', engine: 'mysql', family: 'rdbms' },
  { category: 'plan-cache-miss', engine: 'mssql', family: 'rdbms' },
  { category: 'connection-handling', engine: 'postgres', family: 'rdbms' },
  { category: 'transaction-scope', engine: 'postgres', family: 'rdbms' },
  { category: 'redundant-index', engine: 'postgres', family: 'rdbms' },
  { category: 'redundant-index', engine: 'mysql', family: 'rdbms' },
  { category: 'n-plus-one', engine: 'postgres', family: 'rdbms' },
  { category: 'round-trip', engine: 'mysql', family: 'rdbms' },
  { category: 'batching', engine: 'postgres', family: 'rdbms' },
]

describe('a recipe tests the mechanism the finding claims', () => {
  it.each(PLAN_CANNOT_ANSWER)(
    'a $category claim on $engine is not handed a generic query plan',
    ({ category, engine, family }) => {
      const generic = explainFor(engine, family)
      const claim = recipeFor(engine, family, category)

      // The specific failure: `lookFor` used to be byte-identical to the
      // engine's generic advice for every one of these.
      expect(claim.lookFor).not.toEqual(generic.lookFor)
      expect(claim.replacesPlan).toBe(true)
      // And the plan commands are dropped, not shown alongside. Offering both
      // invites the reader to run the one that cannot answer.
      expect(claim.plan).toBe('')
      expect(claim.measure).toBeUndefined()
    },
  )

  it('a plan-cache claim reaches for the statement cache, not the planner', () => {
    const pg = recipeFor('postgres', 'rdbms', 'plan-cache-miss')
    expect(JSON.stringify(pg)).toMatch(/pg_stat_statements/)
    expect(JSON.stringify(pg)).toMatch(/plan_cache_mode/)

    // Same claim, unrelated instrument. This is why the map is two-dimensional:
    // a category-only recipe would send one of these to the wrong system table.
    const my = recipeFor('mysql', 'rdbms', 'plan-cache-miss')
    expect(JSON.stringify(my)).toMatch(/prepared_statements_instances|Com_stmt_/)
    expect(JSON.stringify(my)).not.toMatch(/pg_stat_statements/)

    const ms = recipeFor('mssql', 'rdbms', 'plan-cache-miss')
    expect(JSON.stringify(ms)).toMatch(/dm_exec_cached_plans/)
  })

  it('a connection claim reaches for pg_stat_activity, never a plan', () => {
    const r = recipeFor('postgres', 'rdbms', 'connection-handling')
    expect(JSON.stringify(r)).toMatch(/pg_stat_activity/)
    expect(JSON.stringify(r)).not.toMatch(/EXPLAIN/)
  })

  it('a redundant-index claim reaches for usage counters, and warns about a reset', () => {
    const r = recipeFor('postgres', 'rdbms', 'redundant-index')
    expect(JSON.stringify(r)).toMatch(/idx_scan/)
    // The trap this exists for: idx_scan = 0 after a recent stats reset means
    // "not measured", not "not used" — and dropping an index on that reading is
    // an outage waiting to happen.
    expect(r.refutes.join(' ')).toMatch(/stats_reset|reset recently/)
    // And a UNIQUE index is a constraint, not an optimisation.
    expect(r.refutes.join(' ')).toMatch(/UNIQUE/)
  })

  it('a vector claim measures recall alongside latency, never latency alone', () => {
    const r = recipeFor('pinecone', 'vector', 'full-scan')
    expect(r.measures).toMatch(/recall/i)
    // Latency falling while recall falls with it is a quality regression sold
    // as a speed-up — the sharpest failure mode in this whole registry.
    expect(r.refutes.join(' ')).toMatch(/recall/i)
  })
})

describe('every overlay states what would prove it wrong', () => {
  const entries = Object.entries(CATEGORY_OVERLAYS).flatMap(([category, byEngine]) =>
    Object.entries(byEngine ?? {}).map(([engine, overlay]) => ({ category, engine, overlay })),
  )

  it('has overlays to check', () => {
    expect(entries.length).toBeGreaterThan(10)
  })

  it.each(entries)('$category / $engine names its metric and its refutation', ({ overlay }) => {
    /*
     * `refutes` is the load-bearing field, and the reason this file is not just
     * a coverage check.
     *
     * A verification command with no stated failure condition can be run,
     * produce literally any output, and be read as agreement — which is how a
     * verification step degrades into a ritual. Naming the refutation up front
     * is what makes "this finding was wrong" a reachable outcome. An overlay
     * that cannot say what would disprove it is not a prediction.
     */
    expect(overlay!.refutes.length).toBeGreaterThan(0)
    expect(overlay!.confirms.length).toBeGreaterThan(0)
    expect(overlay!.measures.length).toBeGreaterThan(10)
    for (const line of [...overlay!.refutes, ...overlay!.confirms]) {
      expect(line.trim().length).toBeGreaterThan(15)
    }
  })
})

describe('a category with no specific recipe says so', () => {
  it('marks the generic fallback rather than presenting it as chosen', () => {
    // `inefficient-join` genuinely is a plan question, so the family recipe is
    // correct for it. What must not happen is that being indistinguishable from
    // a recipe someone picked for the claim.
    const r = recipeFor('postgres', 'rdbms', 'inefficient-join')
    expect(overlayFor('inefficient-join', 'postgres', 'rdbms')).toBeNull()
    expect(r.noRecipeReason).toMatch(/No verification recipe specific to/)
    expect(r.noRecipeReason).toMatch(/inefficient-join/)
    expect(r.replacesPlan).toBe(false)
  })

  it('every category resolves to something runnable on every family', () => {
    // Coverage, weaker than the assertions above but it catches a family added
    // without any recipe at all.
    for (const family of FAMILIES.map((f) => f.id)) {
      for (const category of ALL_CATEGORIES) {
        const r = recipeFor('nonexistent-engine', family, category)
        expect(r.lookFor.length).toBeGreaterThan(0)
        expect(r.plan !== '' || r.replacesPlan).toBe(true)
      }
    }
  })

  it('every engine in the registry still resolves, for every category', () => {
    for (const engine of ENGINES) {
      for (const category of ALL_CATEGORIES) {
        expect(() => recipeFor(engine.id, engine.family, category)).not.toThrow()
      }
    }
  })
})

describe('checkPerformance hands the claim recipe through', () => {
  it('a round-trip claim gets a query counter, not EXPLAIN', () => {
    const check = checkPerformance({
      engine: 'postgres',
      category: 'n-plus-one',
      original: 'for p in products:\n    Review.objects.filter(product=p).count()',
      proposed: 'Review.objects.filter(product__in=products).values("product").annotate(n=Count("id"))',
    })
    const commands = check.verification.map((v) => v.command).join('\n')
    expect(commands).not.toMatch(/EXPLAIN/)
    expect(check.refutes.length).toBeGreaterThan(0)
    expect(check.measures).toMatch(/round trip/i)
  })

  it('a plan-cache claim gets the statement cache, not the query plan', () => {
    const check = checkPerformance({
      engine: 'postgres',
      category: 'plan-cache-miss',
      original: "SELECT * FROM orders WHERE id = " + "'" + "42" + "'",
      proposed: 'SELECT * FROM orders WHERE id = $1',
    })
    const commands = check.verification.map((v) => v.command).join('\n')
    expect(commands).toMatch(/pg_stat_statements/)
    // The regression guard: this used to be `EXPLAIN (ANALYZE, BUFFERS,
    // VERBOSE) SELECT ...`, which reports how the planner handles the statement
    // when asked — while the claim is about how often it is asked at all.
    expect(commands).not.toMatch(/EXPLAIN \(ANALYZE/)
  })

  it('a missing-index claim still gets a plan, because a plan is the instrument', () => {
    const check = checkPerformance({
      engine: 'postgres',
      category: 'missing-index',
      original: 'SELECT id FROM orders WHERE tenant_id = 1',
      proposed: 'CREATE INDEX ON orders (tenant_id)',
    })
    expect(check.verification.map((v) => v.command).join('\n')).toMatch(/EXPLAIN/)
    // And it names the failure that matters most for an index: it already exists.
    expect(check.refutes.join(' ')).toMatch(/already lists an index|already exists/i)
  })

  it('flags a claim it has no specific recipe for', () => {
    const check = checkPerformance({
      engine: 'postgres',
      category: 'other',
      original: 'SELECT a FROM t',
      proposed: 'SELECT a FROM t WHERE x = 1',
    })
    expect(check.noRecipeReason).toBeDefined()
    expect(check.refutes).toEqual([])
  })
})
