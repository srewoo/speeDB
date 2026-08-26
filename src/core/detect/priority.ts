/**
 * Priority scoring — the ranking signal, deliberately distinct from detector
 * confidence.
 *
 * `confidence` answers "is this a query?" — a precision signal, and the right
 * thing to gate on. It says nothing about whether the query *matters*. The
 * per-file cap used to keep the first N spans by line number, so in a file
 * whose cheap queries sit at the top and whose expensive report view sits at
 * the bottom — the normal shape of a Django `views.py` — the cap discarded the
 * interesting half. Ranking has to happen before capping, on a score that
 * means "how likely is this to matter", not "how sure am I this is SQL".
 */

import type { AccessStyle } from '@/core/types'
import type { EnclosingScope } from './scope'

export interface PriorityScore {
  score: number
  reasons: string[]
}

const MIGRATION_PATH = /(^|\/)migrations?\/|(^|\/)seeds?\/|(^|\/)fixtures?\/|(^|\/)factories\/|(^|\/)db\/migrate\//i
const TEST_PATH = /(^|\/)tests?\/|(^|\/)spec\/|[._-]test\.|[._-]spec\.|_tests?\.py$|Tests?\.(?:java|kt|cs|scala)$/i

/** Cheap per-row work — the queries whose cost is paid once per iteration. */
const PER_ROW_TERMINAL = /\.\s*(?:count|exists)\s*\(|\.\s*aggregate\s*\(|\bCOUNT\s*\(|\.\s*Count\s*\(|\.\s*first\s*\(|\.\s*get\s*\(/
/** An unbounded fetch: everything, with nothing capping it. */
const UNBOUNDED = /\.\s*all\s*\(\s*\)|\bSELECT\s+\*|\.\s*findAll\s*\(|\.\s*ToList\s*\(\s*\)|\.\s*fetchall\s*\(/i
const HAS_LIMIT = /\bLIMIT\b|\.\s*limit\s*\(|\[\s*:\s*\d+\s*\]|\.\s*take\s*\(|\bTOP\s+\d+|\.\s*first\s*\(/i
/** The author already considered the N+1. Do not re-report it at them. */
const ALREADY_BATCHED = /select_related|prefetch_related|\.\s*Include\s*\(|\bPreload\s*\(|joinedload|selectinload|\.\s*includes\s*\(|\.\s*populate\s*\(|\bwith\s*:\s*\[|\bin_bulk\s*\(|__in\b/

const HANDLER_TRIGGERS = new Set(['request-handler'])

/**
 * Additive scoring from a neutral 0.4, clamped to [0, 1].
 *
 * The weights are not tuned constants — they encode an ordering that is not in
 * dispute: a query in a loop in a request handler outranks everything, and code
 * that runs once at install time outranks nothing.
 */
export function scorePriority(input: {
  path: string
  excerpt: string
  enclosing: EnclosingScope | null
  accessStyle: AccessStyle
}): PriorityScore {
  let score = 0.4
  const reasons: string[] = []

  const add = (delta: number, reason: string): void => {
    score += delta
    reasons.push(`${delta > 0 ? '+' : ''}${delta.toFixed(2)} ${reason}`)
  }

  const scope = input.enclosing

  if (scope && scope.loopDepth > 0) {
    add(0.35, `inside ${scope.loopDepth} loop${scope.loopDepth > 1 ? 's' : ''} — one query per iteration is the N+1 signal`)
  }
  if (scope && HANDLER_TRIGGERS.has(scope.trigger)) {
    add(0.15, 'reached by a request handler, so it runs per request')
  }

  if (MIGRATION_PATH.test(input.path)) {
    add(-0.4, 'runs once, at install time (migration/seed/fixture)')
  }
  if (TEST_PATH.test(input.path)) {
    add(-0.45, 'test code, not production')
  }
  if (scope?.trigger === 'migration' && !MIGRATION_PATH.test(input.path)) {
    add(-0.4, 'reached only by a migration')
  }
  if (scope?.trigger === 'test' && !TEST_PATH.test(input.path)) {
    add(-0.45, 'reached only by a test')
  }

  if (PER_ROW_TERMINAL.test(input.excerpt)) {
    add(0.1, 'a count/exists/aggregate terminal — cheap to batch, expensive per row')
  }
  if (UNBOUNDED.test(input.excerpt) && !HAS_LIMIT.test(input.excerpt)) {
    add(0.1, 'fetches an unbounded result set')
  }
  if (ALREADY_BATCHED.test(input.excerpt)) {
    add(-0.15, 'already uses eager loading or a batched predicate')
  }

  if (input.accessStyle === 'ddl-migration') {
    add(-0.3, 'schema definition, not a hot query')
  }

  return { score: clamp(score), reasons }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(4))))
}
