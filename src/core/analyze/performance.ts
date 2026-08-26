import { engineSpec } from '@/config/engines'
import { explainFor } from '@/config/explain'
import { readSqlShape } from './sql-shape'
import { ormVerificationRecipe, readOrmShape, type OrmShape } from './orm-shape'
import type { EnclosingScope } from '@/core/detect/scope'

/**
 * The speed claim, held to the same standard as the equivalence claim.
 *
 * speeDB executes nothing. It has no connection, no table sizes, no column
 * selectivity and no visibility into which indexes exist in production. So a
 * rewrite that is provably output-identical can still be slower, and nothing
 * in this pipeline would catch it.
 *
 * The honest response is not to soften the language — it is to separate the
 * two things that get conflated:
 *
 *   counted     facts derivable from the two statements alone
 *   unmeasured  everything that needs a real database, named individually
 *
 * and then to hand over the exact command that settles it.
 */

export type PerformanceStatus =
  /** Nothing was measured. This is the status for essentially every finding. */
  | 'unmeasured'
  /** Nothing measured, and a specific reason to doubt the direction of the change. */
  | 'questionable'

export interface VerificationStep {
  label: string
  command: string
}

export interface PerformanceCheck {
  status: PerformanceStatus
  /** Structural facts derived from the two statements. Not timings. */
  counted: string[]
  /** What cannot be known without running it, stated individually. */
  unmeasured: string[]
  /** Copy-pasteable commands that settle the question on a real database. */
  verification: VerificationStep[]
  /** Which line of the output actually answers the question. */
  lookFor: string[]
  summary: string
}

/** Categories whose benefit depends entirely on data the tool cannot see. */
const DATA_DEPENDENT = new Set([
  'missing-index', 'full-scan', 'inefficient-join', 'implicit-cast', 'sort-in-memory',
])

export function checkPerformance(input: {
  engine: string
  category: string
  original: string
  proposed: string
  requiredMigration?: string
  /** Loop nesting and trigger, so a per-iteration query can be counted as one. */
  scope?: EnclosingScope | null
}): PerformanceCheck {
  const spec = engineSpec(input.engine)
  const recipe = explainFor(spec.id, spec.family)

  const counted: string[] = []
  const unmeasured: string[] = []

  /* ---- what can actually be derived from the two statements ------------- */

  const a = readSqlShape(input.original)
  const b = readSqlShape(input.proposed)

  if (a && b && a.kind === 'select' && b.kind === 'select') {
    const wasStar = a.projection[0] === '*'
    const isStar = b.projection[0] === '*'
    if (wasStar && !isStar) {
      counted.push(`Transfers ${b.projection.length} named columns instead of every column. (Counted from the statement, not measured.)`)
    } else if (!wasStar && !isStar && b.projection.length < a.projection.length) {
      counted.push(`Transfers ${a.projection.length - b.projection.length} fewer column(s). (Counted, not measured.)`)
    }
    if (!a.limit && b.limit) {
      counted.push(`Caps the result at ${b.limit} row(s), where the original was unbounded. (Counted, not measured.)`)
    }
  }

  if (a?.kind === 'ddl-index' && b?.kind === 'ddl-index') {
    counted.push('Changes an index definition. Index maintenance cost is paid on every write to the table.')
  }

  /* ---- the same facts, for code that is not SQL text --------------------- */
  //
  // Django, Rails, Hibernate, Prisma, SQLAlchemy, GORM, EF Core, Sequelize and
  // TypeORM all fail `readSqlShape`, which used to mean this block produced
  // nothing at all for the majority of real application data access. Round
  // trips and projections are countable from ORM text too, and counting them is
  // the difference between "not machine-checkable" and "401 database calls
  // become 1, counted from the code".
  const isSqlPair = isStatement(a) && isStatement(b)
  const oa = isSqlPair ? null : readOrmShape(input.original, input.scope)
  const ob = isSqlPair ? null : readOrmShape(input.proposed, input.scope)

  if (oa && ob) {
    // A proposal that counts *zero* evaluating calls has usually had its query
    // moved outside the snippet rather than eliminated — the reader can only see
    // what it was given. "Issues 0 database calls where the original issues 1"
    // reads as a fact and is really a boundary artefact, so it is stated as what
    // was actually observed.
    if (ob.queryCount === 0 && oa.queryCount > 0) {
      counted.push(
        `Issues no database call within the code shown, where the original issues ${oa.queryCount}. ` +
        'Whether the work moved or disappeared is not decidable from this excerpt. (Counted, not measured.)',
      )
    } else if (ob.queryCount < oa.queryCount) {
      counted.push(
        `Issues ${ob.queryCount} database call(s) where the original issues ${oa.queryCount}. ` +
        '(Counted from the code, not measured.)',
      )
    }
    if (oa.perIteration && !ob.perIteration) {
      counted.push(
        'Moves the query out of the loop: one call for the whole set instead of one per iteration. ' +
        '(Counted from the code, not measured.)',
      )
    }
    if (oa.perIteration && ob.batched && !oa.batched) {
      counted.push(
        'Replaces a per-row lookup with a single set-membership predicate. ' +
        '(Counted from the code, not measured.)',
      )
    }
    if (oa.projection === null && ob.projection && ob.projection.length > 0) {
      counted.push(
        `Fetches ${ob.projection.length} named column(s) instead of whole model instances. (Counted, not measured.)`,
      )
    } else if (oa.projection && ob.projection && ob.projection.length < oa.projection.length) {
      counted.push(
        `Fetches ${oa.projection.length - ob.projection.length} fewer column(s). (Counted, not measured.)`,
      )
    }
    if (!oa.limit && ob.limit) {
      counted.push(
        `Caps the result at ${ob.limit} row(s), where the original was unbounded. (Counted, not measured.)`,
      )
    }
    /*
     * Shapes the round-trip count cannot see.
     *
     * On a real scan 10 of 31 findings carried no counted fact at all, and the
     * same three rewrites accounted for most of them. Each is structural and
     * decidable from the two versions — which is the standard a counted fact has
     * to meet — and leaving them uncounted pushed genuine findings down to
     * `low`, because severity rests on having counted something.
     */
    const term = (shape: OrmShape, name: string) => shape.terminals.some((t) => t.startsWith(name))

    if (term(oa, 'count') && (term(ob, 'exists') || term(ob, 'any'))) {
      counted.push(
        'Stops at the first matching row instead of counting every one. ' +
        '(Counted from the code, not measured.)',
      )
    }
    if (oa.orderBy.length > 0 && ob.orderBy.length === 0 && ob.aggregates.length > 0) {
      counted.push(
        `Replaces an ordered scan and fetch with a single ${ob.aggregates.join('/')} aggregate, ` +
        'so the database no longer has to order the rows to return one value. (Counted, not measured.)',
      )
    }
    if (!oa.materialised && ob.materialised && ob.queryCount <= oa.queryCount) {
      counted.push(
        'Evaluates the queryset once and reuses the result, where the original re-runs it on each use. ' +
        '(Counted from the code, not measured.)',
      )
    }

    if (oa.eagerLoads.length === 0 && ob.eagerLoads.length > 0) {
      counted.push(
        `Adds eager loading (${ob.eagerLoads.join(', ')}), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)`,
      )
    }
  }

  if (oa && ob && oa.perIteration) {
    unmeasured.push(
      'How many iterations the enclosing loop actually runs. That is the multiplier on this whole finding, and source code does not contain it.',
    )
  }

  /* ---- what cannot be known from here ----------------------------------- */

  unmeasured.push(
    'Whether this is actually faster. speeDB does not execute anything — it has no connection, no timings and no query plan.',
  )

  if (DATA_DEPENDENT.has(input.category)) {
    unmeasured.push(
      'Whether the planner will choose this path at all. That depends on table size, column selectivity and current statistics, none of which are visible in source code.',
    )
  }
  if (input.category === 'missing-index' || input.requiredMigration) {
    unmeasured.push(
      'Whether an equivalent index already exists in production. Migration files record intent, not the live schema.',
    )
    unmeasured.push(
      'The write cost of the new index, which is paid on every insert and update to the table.',
    )
  }
  if (spec.family === 'vector') {
    unmeasured.push(
      'Recall. Approximate nearest-neighbour results change with search parameters — a faster query returning different neighbours is a regression, not an optimisation.',
    )
  }
  if (spec.family === 'warehouse') {
    unmeasured.push('Bytes scanned, which is the actual bill on this engine.')
  }

  /* ---- how to settle it ------------------------------------------------- */

  const verification: VerificationStep[] = []
  const isSql = isStatement(a)

  if (recipe.measure && isSql) {
    verification.push(
      { label: 'Measure the current query', command: `${recipe.measure}\n${input.original.trim()};` },
      { label: 'Measure the proposed query', command: `${recipe.measure}\n${input.proposed.trim()};` },
    )
  } else if (recipe.plan && isSql) {
    verification.push(
      { label: 'Plan for the current query', command: `${recipe.plan}\n${input.original.trim()};` },
      { label: 'Plan for the proposed query', command: `${recipe.plan}\n${input.proposed.trim()};` },
    )
  } else if (oa || ob) {
    // ORM code. `EXPLAIN ANALYZE` against a Django queryset is not a
    // verification step but a category error — the user cannot run it, and
    // offering it is how this block ended up pointing EXPLAIN ANALYZE at
    // JavaScript string concatenation. The claim is a query count, so the
    // instrument is a query counter.
    verification.push({
      label: `Count the queries this issues (${(oa ?? ob)!.dialect})`,
      command: ormVerificationRecipe((oa ?? ob)!.dialect),
    })
  } else {
    // Non-SQL engines: the recipe itself is the instruction.
    verification.push({
      label: `Measure on ${spec.label}`,
      command: [recipe.measure ?? recipe.plan, '', `-- current:  ${oneLine(input.original)}`, `-- proposed: ${oneLine(input.proposed)}`]
        .filter(Boolean).join('\n'),
    })
  }

  if (recipe.stats?.length && (isSql || !(oa || ob))) {
    verification.push({
      label: 'The data facts speeDB cannot see',
      command: recipe.stats.join('\n'),
    })
  }

  // A change whose only benefit is data-dependent, with no structural gain to
  // fall back on, deserves a stronger warning than "unmeasured".
  const status: PerformanceStatus =
    counted.length === 0 && DATA_DEPENDENT.has(input.category) ? 'questionable' : 'unmeasured'

  return {
    status,
    counted,
    unmeasured,
    verification,
    lookFor: recipe.lookFor,
    summary:
      status === 'questionable'
        ? 'Not measured, and the benefit depends entirely on data speeDB cannot see. Run the plan before trusting this.'
        : counted.length > 0
          ? `Not measured. ${counted.length} structural fact(s) counted from the statements; everything else needs a real database.`
          : 'Not measured. speeDB does not execute queries — run the plan below to confirm the direction of the change.',
  }
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** True for a statement the SQL reader actually understood. */
function isStatement(shape: { kind: string } | null): boolean {
  return (
    shape?.kind === 'select' || shape?.kind === 'update' ||
    shape?.kind === 'delete' || shape?.kind === 'insert' || shape?.kind === 'ddl-index'
  )
}

/** Re-exported so callers can name the shape they passed through. */
export type { OrmShape }
