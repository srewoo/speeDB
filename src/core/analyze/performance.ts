import { engineSpec } from '@/config/engines'
import { explainFor } from '@/config/explain'
import { readSqlShape } from './sql-shape'

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
  const isSql = a?.kind === 'select' || a?.kind === 'update' || a?.kind === 'delete' || a?.kind === 'insert'

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
  } else {
    // Non-SQL engines: the recipe itself is the instruction.
    verification.push({
      label: `Measure on ${spec.label}`,
      command: [recipe.measure ?? recipe.plan, '', `-- current:  ${oneLine(input.original)}`, `-- proposed: ${oneLine(input.proposed)}`]
        .filter(Boolean).join('\n'),
    })
  }

  if (recipe.stats?.length) {
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
