import { readSqlShape, type SqlShape } from './sql-shape'

/**
 * Machine check for the same-output claim.
 *
 * A length threshold on the model's prose is not verification. Where the
 * statement is SQL, several parts of "same output" *are* mechanically
 * decidable, and this checks them:
 *
 *   projection   — the output column list and its order
 *   DISTINCT     — duplicate handling
 *   GROUP BY     — result cardinality
 *   set ops      — UNION/INTERSECT/EXCEPT
 *   ORDER BY     — row ordering guarantees
 *   LIMIT/OFFSET — row count
 *
 * Predicate equivalence (a changed WHERE) is *not* decidable without a solver,
 * and join-shape equivalence needs schema cardinality. Those are reported as
 * undecided rather than quietly counted as passing.
 */

export type EquivalenceStatus =
  /** Every decidable property matches, and nothing was left undecided. */
  | 'machine-verified'
  /** Decidable properties match, but something needs human judgement. */
  | 'partially-verified'
  /** A decidable property differs — the outputs are not the same. */
  | 'contradicted'
  /** Not checkable by machine (non-SQL engine, or unparseable). */
  | 'unverifiable'

export interface EquivalenceDelta {
  property: 'projection' | 'distinct' | 'group-by' | 'set-op' | 'order-by' | 'row-limit'
  /** hard: cannot be justified by caller context. soft: might be. */
  severity: 'hard' | 'soft'
  detail: string
}

export interface EquivalenceCheck {
  status: EquivalenceStatus
  /** Properties actively confirmed identical. */
  verified: string[]
  /** Decidable properties that differ. */
  deltas: EquivalenceDelta[]
  /** Properties a machine cannot decide, stated plainly. */
  undecided: string[]
  /** One-line summary for the UI and the exported report. */
  summary: string
}

export function checkEquivalence(original: string, proposed: string): EquivalenceCheck {
  const a = readSqlShape(original)
  const b = readSqlShape(proposed)

  if (!a || !b) return unverifiable('One side of the change is empty.')

  // Index DDL cannot change a result set — that is a real, sound machine check,
  // and it is the one case where "add/drop an index" is provably output-safe.
  if (a.kind === 'ddl-index' && b.kind === 'ddl-index') {
    return {
      status: 'machine-verified',
      verified: ['Index definitions only — indexes cannot change which rows a query returns.'],
      deltas: [],
      undecided: [],
      summary: 'Verified: an index change cannot alter any result set.',
    }
  }

  if (a.kind === 'other' || b.kind === 'other') {
    return unverifiable('Not a statement this checker can read (non-SQL engine or unsupported syntax).')
  }
  if (a.kind !== b.kind) {
    return {
      status: 'contradicted',
      verified: [],
      deltas: [{
        property: 'projection', severity: 'hard',
        detail: `Statement type changes from ${a.kind.toUpperCase()} to ${b.kind.toUpperCase()}.`,
      }],
      undecided: [],
      summary: `Contradicted: the statement type changes from ${a.kind} to ${b.kind}.`,
    }
  }

  if (a.kind !== 'select') {
    // For DML the interesting property is the affected-row set, which reduces
    // to predicate equivalence — undecidable here.
    return {
      status: a.where === b.where ? 'partially-verified' : 'unverifiable',
      verified: a.where === b.where ? ['The WHERE clause is unchanged.'] : [],
      deltas: [],
      undecided: a.where === b.where
        ? ['Whether the rewritten statement writes the same values.']
        : ['Whether the changed WHERE clause matches the same rows.'],
      summary: a.where === b.where
        ? 'Predicate unchanged; the written values still need review.'
        : 'The predicate changed — equivalence cannot be decided mechanically.',
    }
  }

  const deltas: EquivalenceDelta[] = []
  const verified: string[] = []
  const undecided: string[] = []

  /* ---- hard properties: a difference here is an output difference ------- */

  if (!sameList(a.projection, b.projection)) {
    deltas.push({
      property: 'projection', severity: 'hard',
      detail: describeProjection(a, b),
    })
  } else {
    verified.push(`Output columns are identical (${a.projection.join(', ') || 'none'}).`)
  }

  if (a.distinct !== b.distinct) {
    deltas.push({
      property: 'distinct', severity: 'hard',
      detail: `DISTINCT is ${b.distinct ? 'added' : 'removed'}, which changes duplicate handling.`,
    })
  } else {
    verified.push(`Duplicate handling is unchanged (DISTINCT ${a.distinct ? 'on' : 'off'}).`)
  }

  if (!sameList(a.groupBy, b.groupBy)) {
    deltas.push({
      property: 'group-by', severity: 'hard',
      detail: `GROUP BY changes from [${a.groupBy.join(', ') || 'none'}] to [${b.groupBy.join(', ') || 'none'}], changing result cardinality.`,
    })
  } else if (a.groupBy.length) {
    verified.push('Grouping is unchanged.')
  }

  if (!sameList(a.setOps, b.setOps)) {
    deltas.push({
      property: 'set-op', severity: 'hard',
      detail: `Set operations change from [${a.setOps.join(', ') || 'none'}] to [${b.setOps.join(', ') || 'none'}].`,
    })
  }

  /* ---- soft properties: caller context can legitimately justify these --- */

  if (!sameList(a.orderBy, b.orderBy)) {
    deltas.push({
      property: 'order-by', severity: 'soft',
      detail: a.orderBy.length === 0
        ? `ORDER BY [${b.orderBy.join(', ')}] is added. The original had no ordering guarantee, so this constrains an order that was previously arbitrary.`
        : b.orderBy.length === 0
          ? `ORDER BY [${a.orderBy.join(', ')}] is removed. Row order is no longer guaranteed.`
          : `ORDER BY changes from [${a.orderBy.join(', ')}] to [${b.orderBy.join(', ')}].`,
    })
  } else if (a.orderBy.length) {
    verified.push('Row ordering is unchanged.')
  } else {
    verified.push('Neither version has an ORDER BY, so neither guarantees an order.')
  }

  if (a.limit !== b.limit || a.offset !== b.offset) {
    deltas.push({
      property: 'row-limit', severity: 'soft',
      detail: !a.limit && b.limit
        ? `A row limit (${b.limit}) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.`
        : `Row limiting changes from [${a.limit || 'none'}${a.offset ? ` offset ${a.offset}` : ''}] to [${b.limit || 'none'}${b.offset ? ` offset ${b.offset}` : ''}].`,
    })
  }

  /* ---- undecidable ------------------------------------------------------ */

  if (a.where !== b.where) {
    undecided.push('Whether the changed WHERE clause matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.')
  }
  if (a.from !== b.from) {
    undecided.push('Whether the changed FROM/JOIN shape yields the same rows — this depends on schema cardinality and key constraints.')
  }
  if (a.having !== b.having) {
    undecided.push('Whether the changed HAVING clause keeps the same groups.')
  }

  const hard = deltas.filter((d) => d.severity === 'hard')
  const soft = deltas.filter((d) => d.severity === 'soft')

  if (hard.length > 0) {
    return {
      status: 'contradicted', verified, deltas, undecided,
      summary: `Contradicted: ${hard[0]!.detail}`,
    }
  }
  if (soft.length > 0 || undecided.length > 0) {
    return {
      status: 'partially-verified', verified, deltas, undecided,
      summary: soft.length
        ? `Partly verified: ${soft[0]!.detail}`
        : `Partly verified: ${undecided[0]!}`,
    }
  }
  return {
    status: 'machine-verified', verified, deltas, undecided,
    summary: 'Verified: every mechanically decidable property of the result is identical.',
  }
}

function unverifiable(reason: string): EquivalenceCheck {
  return {
    status: 'unverifiable', verified: [], deltas: [], undecided: [reason],
    summary: `Not machine-checkable: ${reason}`,
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function describeProjection(a: SqlShape, b: SqlShape): string {
  if (a.projection[0] === '*' && b.projection[0] !== '*') {
    return `SELECT * is replaced by an explicit column list [${b.projection.join(', ')}]. That changes the output columns unless the table has exactly those columns in that order.`
  }
  if (b.projection[0] === '*' && a.projection[0] !== '*') {
    return `An explicit column list is replaced by SELECT *, which changes the output columns.`
  }
  const added = b.projection.filter((c) => !a.projection.includes(c))
  const removed = a.projection.filter((c) => !b.projection.includes(c))
  if (added.length || removed.length) {
    return `Output columns differ — ${removed.length ? `removed [${removed.join(', ')}]` : ''}${removed.length && added.length ? ', ' : ''}${added.length ? `added [${added.join(', ')}]` : ''}.`
  }
  return `Output columns are the same but in a different order: [${a.projection.join(', ')}] vs [${b.projection.join(', ')}].`
}
