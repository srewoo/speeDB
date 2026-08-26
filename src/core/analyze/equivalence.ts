import { readSqlShape, type SqlShape } from './sql-shape'
import { readOrmShape, type OrmShape } from './orm-shape'
import type { EnclosingScope } from '@/core/detect/scope'

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

export function checkEquivalence(
  original: string,
  proposed: string,
  scope?: EnclosingScope | null,
): EquivalenceCheck {
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
    // Before giving up: most application data access is not SQL text. Several
    // properties of "same output" are still decidable on ORM code, and saying
    // "not machine-checkable" thirteen times in a row when five of six
    // properties were checkable is a failure of the checker, not an honest
    // limitation of it.
    const orm = checkOrmEquivalence(original, proposed, scope)
    if (orm) return orm
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

/* ---------------------------------------------------------------- ORM -- */

/**
 * The same check, on ORM and query-builder code.
 *
 * What is decidable here is narrower than for SQL but far from nothing:
 *
 *   projection        compare `values()`/`only()`/`select`/`pluck` field lists
 *   duplicates        `.distinct()` on both sides
 *   ordering          `.order_by()`/`.order()`/`orderBy` present and identical
 *   row limit         slice / `.limit()` / `take`
 *   cardinality       the terminal operation (`count`/`first`/`all`) unchanged
 *   predicates        NOT decidable — reported undecided, never as verified
 *
 * The one interesting partial case is the N+1 rewrite: when a per-row
 * `filter(x=v)` inside a loop becomes a single `filter(x__in=vs)`, the row
 * *set* is provably the union of the per-row results. That is a real
 * mechanical fact — but it only preserves the caller's behaviour if the caller
 * consumed the rows the same way, so it lands at `partially-verified` with the
 * guard condition named rather than at `machine-verified`.
 */
export function checkOrmEquivalence(
  original: string,
  proposed: string,
  scope?: EnclosingScope | null,
): EquivalenceCheck | null {
  const a = readOrmShape(original, scope)
  const b = readOrmShape(proposed, scope)
  if (!a || !b) return null

  const deltas: EquivalenceDelta[] = []
  const verified: string[] = []
  const undecided: string[] = []

  /* ---- projection: a named field list is comparable ---------------------- */
  if (a.projection && b.projection) {
    if (sameSet(a.projection, b.projection)) {
      verified.push(`The selected fields are identical (${a.projection.join(', ')}).`)
    } else {
      deltas.push({
        property: 'projection', severity: 'hard',
        detail: `The selected fields change from [${a.projection.join(', ')}] to [${b.projection.join(', ')}], so the caller receives different data.`,
      })
    }
  } else if (a.projection === null && b.projection) {
    // Model instances -> named columns. The rows are the same rows; what each
    // row carries is not, and whether the caller minds is not decidable here.
    undecided.push(
      `The original returns whole model instances and the proposal returns named fields [${b.projection.join(', ')}]. Whether every attribute the caller touches is in that list is not decidable from the query alone.`,
    )
  } else if (a.projection && b.projection === null) {
    deltas.push({
      property: 'projection', severity: 'soft',
      detail: 'The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.',
    })
  }

  /* ---- duplicate handling ------------------------------------------------ */
  if (a.distinct !== b.distinct) {
    deltas.push({
      property: 'distinct', severity: 'hard',
      detail: `DISTINCT is ${b.distinct ? 'added' : 'removed'}, which changes duplicate handling.`,
    })
  } else {
    verified.push(`Duplicate handling is unchanged (distinct ${a.distinct ? 'on' : 'off'}).`)
  }

  /* ---- ordering ---------------------------------------------------------- */
  if (!sameSet(a.orderBy, b.orderBy)) {
    deltas.push({
      property: 'order-by', severity: 'soft',
      detail: a.orderBy.length === 0
        ? `Ordering [${b.orderBy.join(', ')}] is added, constraining an order that was previously arbitrary.`
        : b.orderBy.length === 0
          ? `Ordering [${a.orderBy.join(', ')}] is removed. Row order is no longer guaranteed.`
          : `Ordering changes from [${a.orderBy.join(', ')}] to [${b.orderBy.join(', ')}].`,
    })
  } else if (a.orderBy.length) {
    verified.push('Row ordering is unchanged.')
  } else {
    verified.push('Neither version orders its rows, so neither guarantees an order.')
  }

  /* ---- row limit --------------------------------------------------------- */
  if (a.limit !== b.limit) {
    deltas.push({
      property: 'row-limit', severity: 'soft',
      detail: a.limit === null
        ? `A row limit (${b.limit}) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.`
        : `The row limit changes from ${a.limit} to ${b.limit ?? 'none'}.`,
    })
  }

  /* ---- the N+1 -> batch rewrite ----------------------------------------- */
  //
  // Decided before the terminal check, because it changes what a terminal
  // difference *means*. Turning a per-row `.count()` into one grouped
  // aggregate necessarily changes the call's return shape — that is inherent
  // to the fix, not evidence against it. Calling it `contradicted` would push
  // every correct N+1 rewrite out of the same-output section on a technicality,
  // so it is recorded as the guard condition instead, which is what it is.
  const isBatchWidening = a.perIteration && !b.perIteration && b.batched && b.queryCount < a.queryCount

  /* ---- result cardinality, from the terminal operation ------------------- */
  const CARDINALITY = new Set(['count', 'exists', 'exists?', 'first', 'last', 'get', 'one', 'one_or_none', 'findOne', 'findUnique', 'getOne'])
  const termA = a.terminals.filter((t) => CARDINALITY.has(t))
  const termB = b.terminals.filter((t) => CARDINALITY.has(t))
  if (sameSet(termA, termB)) {
    if (termA.length) verified.push(`The terminal operation is unchanged (${termA.join(', ')}), so the shape of the result is the same.`)
  } else if (isBatchWidening) {
    deltas.push({
      property: 'projection', severity: 'soft',
      detail: `The call returns a batched result (${termB.join(', ') || 'a grouped queryset'}) where the original returned a per-row ${termA.join(', ') || 'value'}. The row set is the same; the caller has to read it differently.`,
    })
  } else {
    deltas.push({
      property: 'projection', severity: 'hard',
      detail: `The terminal operation changes from [${termA.join(', ') || 'none'}] to [${termB.join(', ') || 'none'}], which changes what the call returns.`,
    })
  }

  if (isBatchWidening) {
    verified.push(
      'The per-row predicate is widened to a single set-membership predicate over the same values, so the row set the database returns is provably the union of the per-row results.',
    )
    undecided.push(
      'Whether the caller consumes that union the same way it consumed the per-row results — the row set is the same, the number of Python/Ruby/JS objects handed back is not. That is the guard condition on this rewrite.',
    )
  } else if (!sameSet(a.predicates, b.predicates)) {
    undecided.push(
      'Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.',
    )
  } else if (a.predicates.length) {
    verified.push('The filter expressions are textually unchanged.')
  }

  if (a.writes !== b.writes) {
    deltas.push({
      property: 'projection', severity: 'hard',
      detail: `One version writes and the other does not (${a.writes ? 'original writes' : 'proposal writes'}), which is not an output-preserving change.`,
    })
  }

  const hard = deltas.filter((d) => d.severity === 'hard')
  const soft = deltas.filter((d) => d.severity === 'soft')
  const dialect = a.dialect === b.dialect ? a.dialect : `${a.dialect}/${b.dialect}`

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
        ? `Partly verified (${dialect}): ${soft[0]!.detail}`
        : `Partly verified (${dialect}): ${undecided[0]!}`,
    }
  }
  return {
    status: 'machine-verified', verified, deltas, undecided,
    summary: `Verified (${dialect}): every mechanically decidable property of the result is identical.`,
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].map(norm).sort()
  const sb = [...b].map(norm).sort()
  return sa.every((v, i) => v === sb[i])
}

function norm(s: string): string {
  return s.replace(/\s+/g, '').replace(/['"`]/g, '').toLowerCase()
}

/** Re-exported so callers can name the shape the ORM branch read. */
export type { OrmShape }
