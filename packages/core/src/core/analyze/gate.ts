/**
 * The value gate — the last deterministic pass before publication.
 *
 * Nothing between `parseFindings()` and the report rejected a worthless
 * finding. On the run this gate was written for, thirteen findings shipped: 3
 * were byte-identical no-ops, 1 proposed *more* queries than the original, 2
 * were on code that touches no data store, 5 were in install-time migrations,
 * and 1 rested on a stated assumption the file itself contradicts. Two were
 * worth acting on.
 *
 * Every rule here is deterministic and cites its own reason. Suppressed
 * findings are kept, not dropped: a gate that silently eats a true positive is
 * worse than the padding it was written to remove, and the only way to know
 * which it did is to be able to read what it held back.
 */

import type { Finding, Severity } from '@/core/types'
import type { EnclosingScope } from '@/core/detect/scope'
import { readSqlShape } from './sql-shape'
import { readOrmShape } from './orm-shape'

export type SuppressionReason =
  /** `proposed` is identical to `original` after collapsing whitespace. */
  | 'no-op'
  /** The proposal issues at least as many queries as the original. */
  | 'wrong-direction'
  /** Neither side parses as SQL or as ORM data access. */
  | 'not-data-access'
  /** Migration/seed/test code, and the claim is purely about speed. */
  | 'cold-path'
  /** A stated assumption is contradicted by the file it was made about. */
  | 'unsupported-assumption'
  /** Real, but too small to be worth a reader's attention as a finding. */
  | 'immaterial'
  /** The proposal names something that exists nowhere in the repository. */
  | 'invented-symbol'
  /**
   * Nothing supports this but the model's opinion: one triage sample in three
   * or more flagged the site, no structural fact could be counted from the two
   * versions, and the benefit depends on data speeDB cannot see.
   */
  | 'unsupported-speculation'

export interface Suppression {
  reason: SuppressionReason
  /** One sentence, specific enough to argue with. */
  detail: string
}

export interface GateInput {
  /** Every file fetched, by path. Rule 6 needs whole files, not excerpts. */
  files: Map<string, string>
}

export interface GateResult {
  published: Finding[]
  suppressed: Finding[]
  /** Counts by reason, for the report headline. */
  counts: Record<SuppressionReason, number>
}

/** Categories whose entire claim is "this issues fewer queries". */
const ROUND_TRIP_CATEGORIES = new Set(['round-trip', 'n-plus-one', 'batching'])

/**
 * Categories about a durable schema object rather than an execution.
 *
 * Cold-path suppression asks "does this code run in production?", and for a
 * query in a migration the answer is no. For an *index* it is the wrong
 * question: the `CREATE INDEX` statement runs once, but the index it leaves
 * behind is paid for on every write, forever. A redundant index declared in
 * `db/schema.sql` is exactly as real as one declared anywhere else, so these
 * are exempt from the cold-path rule.
 *
 * The category alone is not enough to earn the exemption, because the category
 * is the model's word. The 2026-08-26 report contains a finding titled "Add an
 * index for the migration's scan", filed as `missing-index`, whose proposal
 * creates no index — it rewrites the query. Taking the label at face value
 * would have published it. So the finding must also *show* an index: DDL in the
 * proposal, or a `requiredMigration`.
 */
const SCHEMA_OBJECT_CATEGORIES = new Set(['missing-index', 'redundant-index'])

const INDEX_DDL = /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|ADD\s+INDEX|add_index|createIndex|@@index)\b/i

function concernsASchemaObject(finding: Finding): boolean {
  if (!SCHEMA_OBJECT_CATEGORIES.has(finding.category)) return false
  // The migration must *look like* index DDL, not merely be a non-empty string.
  // 18 of 27 findings on a real scan carried `requiredMigration: "omit"` — the
  // prompt's own placeholder echoed back — and a truthiness check let every one
  // of them claim to concern an index.
  const migration = finding.suggestion.requiredMigration ?? ''
  return INDEX_DDL.test(`${finding.original} ${finding.suggestion.proposed} ${migration}`)
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
}

export function applyValueGate(findings: Finding[], input: GateInput): GateResult {
  const published: Finding[] = []
  const suppressed: Finding[] = []
  const counts: Record<SuppressionReason, number> = {
    'no-op': 0, 'wrong-direction': 0, 'not-data-access': 0,
    'cold-path': 0, 'unsupported-assumption': 0, 'immaterial': 0, 'invented-symbol': 0,
    'unsupported-speculation': 0,
  }

  for (const finding of findings) {
    const scope = finding.scope ?? null
    const suppression = judge(finding, scope, input)

    if (suppression) {
      counts[suppression.reason]++
      suppressed.push({
        ...finding,
        suppression,
        // A suppressed cold-path tidy-up is still a real observation; it is
        // just not a performance finding. Severity says which.
        // A cold-path tidy-up or an immaterial narrowing is still a real
        // observation; it is just not a finding worth a reader's attention.
        severity: suppression.reason === 'cold-path' || suppression.reason === 'immaterial'
          ? 'info'
          : finding.severity,
      })
      continue
    }

    published.push(calibrate(finding, scope))
  }

  return { published, suppressed, counts }
}

/** Returns a suppression, or null when the finding earns publication. */
function judge(
  finding: Finding,
  scope: EnclosingScope | null,
  input: GateInput,
): Suppression | null {
  const original = finding.original ?? ''
  const proposed = finding.suggestion.proposed ?? ''

  /* 1a. no proposal at all — the strictest kind of nothing to apply. */
  //
  // The no-op rule below required `proposed` to be non-empty before comparing,
  // so an *empty* proposal skipped it and published. One did, on a real scan: a
  // `missing-index` finding whose entire suggestion was the empty string.
  if (!proposed.trim()) {
    return {
      reason: 'no-op',
      detail: 'The finding proposes no change at all — the suggestion is empty, so there is nothing to apply or review.',
    }
  }

  /* 1b. no-op — unconditional. Nothing to apply is nothing to report. */
  if (collapse(original) === collapse(proposed)) {
    return {
      reason: 'no-op',
      detail: 'The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.',
    }
  }

  /* 1b-ii. no-op — different text, identical behaviour. */
  const inert = judgeSemanticNoOp(original, proposed)
  if (inert) return inert

  /* 1c. invented-symbol — the proposal cannot run. */
  //
  // Placed here, ahead of every judgement about *what kind* of finding this is,
  // because "this code would raise AttributeError" is the most specific and most
  // damning thing that can be said about a rewrite. An independent audit of one
  // real run found two published findings in this state — one accessed
  // `new_run.execution_model`, which appears nowhere in the repository — and the
  // gate's six rules all had something else to say first.
  const invented = judgeSymbols(finding, input)
  if (invented) return invented

  const sqlA = readSqlShape(original)
  const sqlB = readSqlShape(proposed)
  const isSqlA = !!sqlA && sqlA.kind !== 'other'
  const isSqlB = !!sqlB && sqlB.kind !== 'other'
  const ormA = readOrmShape(original, scope)
  const ormB = readOrmShape(proposed, scope)

  /* 3. not-data-access — checked before direction, because a snippet that is
        not data access has no query count to compare. */
  if (!isSqlA && !isSqlB && !ormA && !ormB) {
    return {
      reason: 'not-data-access',
      detail: 'Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.',
    }
  }

  /* 2. wrong-direction — the claim is "fewer queries", so count them. */
  //
  // Only when there is a count to compare. `0 >= 0` is true and means nothing:
  // it fires whenever neither snippet evaluates anything, which is the normal
  // shape of a lazy queryset assignment and the *guaranteed* shape of a mapping
  // declaration. On spring-petclinic that suppressed all three `FetchType`
  // findings with "issues 0 database calls where the original issues 0" — a
  // sentence that reads as a measurement and is an absence of one. The
  // round-trip effect of a mapping change lives at the call sites, not in the
  // declaration, so this rule has no evidence and must abstain rather than
  // suppress. Other rules and the severity calculation still apply.
  if (ROUND_TRIP_CATEGORIES.has(finding.category) && ormA && ormB) {
    const hasCountToCompare = ormA.queryCount > 0 || ormB.queryCount > 0
    if (hasCountToCompare && ormB.queryCount >= ormA.queryCount && !(ormA.perIteration && !ormB.perIteration)) {
      return {
        reason: 'wrong-direction',
        detail: `The proposal issues ${ormB.queryCount} database call(s) where the original issues ${ormA.queryCount}, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)`,
      }
    }
  }

  /* 6. unsupported-assumption — cheap, and it caught the one actively wrong
        finding in the run this gate was written for. */
  const contradiction = findContradictedAssumption(finding, input)
  if (contradiction) return contradiction

  /* 4. cold-path — runs once at install, or never in production. A tidy-up
        there is fine; a *performance* finding there is noise. */
  const coldTrigger = scope?.trigger === 'migration' || scope?.trigger === 'test'
  if (coldTrigger && finding.kind === 'equivalent' && !concernsASchemaObject(finding)) {
    return {
      reason: 'cold-path',
      detail: `This code is reached by a ${scope!.trigger === 'test' ? 'test' : 'migration or seed'}, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.`,
    }
  }

  /* 8. nothing supports this but the model's opinion. */
  //
  // Three independent signals have to be simultaneously empty for this to fire,
  // and each is one the tool computed rather than took on the model's word:
  //
  //   - `performance.status === 'questionable'` — the category's benefit
  //     depends entirely on table size, selectivity or which indexes exist in
  //     production, none of which are visible in source code.
  //   - zero counted facts — nothing structural could be derived from the two
  //     versions, so there is no fallback claim underneath the speed claim.
  //   - 1-of-3-or-more triage support — the other samples looked at this exact
  //     site and called it clean.
  //
  // Any one of these alone is ordinary and publishes: a data-dependent claim
  // with counted facts is a normal index finding, and a weakly-supported site
  // with counted facts is the variance sampling exists to cover. All three at
  // once is a finding whose entire content is a guess, and `countedFactCoverage`
  // sitting at 68% against an 80% gate is largely made of them.
  //
  // Suppressed, not dropped — it is rendered with this reason in the collapsed
  // section like every other gate decision, because a gate that silently eats a
  // true positive is worse than the padding it removes.
  const support = finding.triageSupport
  if (
    finding.performance?.status === 'questionable' &&
    (finding.performance?.counted.length ?? 0) === 0 &&
    support && support.samples >= 3 && support.flagged / support.samples < 0.5
  ) {
    return {
      reason: 'unsupported-speculation',
      detail:
        `${support.flagged} of ${support.samples} triage samples flagged this site; the rest read the same code and ` +
        'called it clean. No structural fact could be counted from the two versions, and the benefit of this ' +
        `category depends on table size, selectivity and which indexes exist in production — none of which are in ` +
        'the source. Nothing here is checkable, so it is held back rather than published as a finding.',
    }
  }

  /* 7. immaterial — real, and not worth reading. */
  //
  // Precision against a truth file of major defects sat at 17%: the other
  // findings were mostly "fetch two columns instead of the whole row" on a query
  // that runs once. Those are true, and publishing nineteen of them buries the
  // two that matter. The test is deliberately narrow — a column narrowing on a
  // query with no loop, no unbounded fetch and no round-trip reduction — so a
  // finding with any other evidence behind it still publishes. It runs last:
  // everything mechanically wrong gets first refusal.
  const immaterial = judgeMateriality(finding, scope)
  if (immaterial) return immaterial

  return null
}

/** Counted facts that describe a real but minor saving. */
const NARROWING_ONLY = /fewer column|named column/i
/** Counted facts that mean something happened worth reading about. */
const SUBSTANTIVE = /out of the loop|database call|per-row lookup|Caps the result|eager loading|unbounded/i

function judgeMateriality(
  finding: Finding,
  scope: EnclosingScope | null,
): Suppression | null {
  const counted = finding.performance?.counted ?? []
  if (counted.length === 0) return null
  if (counted.some((c) => SUBSTANTIVE.test(c))) return null
  if (!counted.every((c) => NARROWING_ONLY.test(c))) return null

  const perIteration = (scope?.loopDepth ?? 0) > 0 || scope?.opensLoop === true
  if (perIteration) return null
  if (concernsASchemaObject(finding)) return null

  return {
    reason: 'immaterial',
    detail:
      `The only thing counted here is a narrower column list (${counted.join(' ')}), on a query that ` +
      'does not run per iteration and is not unbounded. That is a real saving and a small one; ' +
      'publishing it beside a per-request N+1 costs the reader more attention than it returns.',
  }
}

/**
 * Attribute names the proposal accesses that the repository never defines.
 *
 * The repository is its own vocabulary, and that is what makes this cheap and
 * safe: every ORM method, model field and helper a real rewrite needs already
 * appears somewhere in the fetched tree, because the surrounding code uses it.
 * A name that appears *nowhere* was invented by the model.
 *
 * Deliberately narrow. Only attribute accesses are examined (`obj.name`), never
 * bare identifiers — a proposal legitimately introduces new local variables, and
 * flagging those would reject every good rewrite. Short names are skipped
 * because they collide with everything.
 */
const ATTRIBUTE_ACCESS = /(?:\b([A-Za-z_]\w*)\s*)?\.\s*([a-z_][a-z0-9_]{3,})\b/gi

/**
 * A member written in SCREAMING_CASE is a constant, and a constant reached
 * through a known type lives in that type's definition — which is in a
 * dependency this tool never reads.
 */
const CONSTANT_MEMBER = /^[A-Z][A-Z0-9_]*$/

/**
 * Names that may legitimately be absent from a repository's own source.
 *
 * Standard-library and framework members a rewrite can reach for even where the
 * existing code never did.
 */
const UNIVERSAL = new Set([
  'append', 'extend', 'items', 'keys', 'values', 'strip', 'split', 'join', 'format',
  'lower', 'upper', 'replace', 'setdefault', 'update', 'sort', 'reverse', 'copy',
  'annotate', 'aggregate', 'filter', 'exclude', 'exists', 'count', 'first', 'last',
  'distinct', 'order_by', 'values_list', 'select_related', 'prefetch_related',
  'bulk_create', 'bulk_update', 'get_or_create', 'update_or_create', 'in_bulk',
  'iterator', 'only', 'defer', 'none', 'union', 'push', 'map', 'reduce', 'concat',
  'includes', 'length', 'then', 'catch', 'toString', 'valueOf',
])

/** Below these, the fetched tree is too small to tell invention from absence. */
const MIN_VOCABULARY_FILES = 25
const MIN_VOCABULARY_CHARS = 20_000

function judgeSymbols(finding: Finding, input: GateInput): Suppression | null {
  const proposed = finding.suggestion.proposed
  if (!proposed.trim()) return null

  // The whole fetched tree, joined once. The cited file alone is not enough: a
  // rewrite may legitimately reach for a helper defined elsewhere.
  //
  // And the check only runs when there is enough source to be a vocabulary at
  // all. Against a handful of files almost every legitimate name looks invented,
  // which would reject good rewrites on small repositories and in tests — so
  // below the threshold this abstains rather than guesses.
  if (input.files.size < MIN_VOCABULARY_FILES) return null
  const vocabulary = [...input.files.values()].join('\n')
  if (vocabulary.length < MIN_VOCABULARY_CHARS) return null

  const seen = new Set<string>()
  for (const m of proposed.matchAll(ATTRIBUTE_ACCESS)) {
    const receiver = m[1]
    const name = m[2]!
    if (UNIVERSAL.has(name) || seen.has(name)) continue
    seen.add(name)

    /*
     * A constant reached through a type the repository knows is not invented.
     *
     * Found by running the benchmark, not by reasoning: on spring-petclinic
     * this rule suppressed all three findings the repo exists to test, each
     * proposing `FetchType.EAGER` -> `FetchType.LAZY`. `FetchType` is imported
     * in three entity files; `LAZY` appears nowhere, because it is an enum
     * constant declared in `jakarta.persistence`, a jar speeDB never reads.
     *
     * The rule was checking the member and ignoring the receiver, so every
     * framework constant a rewrite legitimately reaches for — `FetchType.LAZY`,
     * `CascadeType.MERGE`, `Propagation.REQUIRES_NEW` — read as invented. That
     * is a false suppression of exactly the findings this tool is best at, and
     * a gate that eats a true positive is worse than the padding it removes.
     *
     * `UNIVERSAL` cannot fix this: it is a fixed list, and the set of framework
     * constants across sixty engines and a dozen ORMs is not enumerable. The
     * receiver is the general signal — if the type is in the source and the
     * member is a constant, its definition is out of scope and this abstains
     * rather than guessing.
     *
     * Deliberately narrow. It requires SCREAMING_CASE, so `order.nonexistent`
     * is still caught: a lowercase member on a known receiver is an attribute
     * this tool *can* see, and its absence still means invented.
     */
    if (
      receiver &&
      CONSTANT_MEMBER.test(name) &&
      new RegExp(String.raw`\b${escapeRe(receiver)}\b`).test(vocabulary)
    ) {
      continue
    }

    if (!new RegExp(String.raw`\b${escapeRe(name)}\b`).test(vocabulary)) {
      return {
        reason: 'invented-symbol',
        detail:
          `The proposal accesses \`.${name}\`, and \`${name}\` appears nowhere in the ` +
          `${input.files.size.toLocaleString()} files that were read. The rewrite would fail at runtime, ` +
          'so it is held back rather than published as something to apply.',
      }
    }
  }

  return null
}

/**
 * Rule 6: a stated assumption that the file contradicts.
 *
 * The model asserted "`product` is not used later" from a ±6-line window, while
 * the identifier was consumed 70 lines further down. The whole file is already
 * in memory, so checking it costs nothing and no extra fetch.
 */
function findContradictedAssumption(finding: Finding, input: GateInput): Suppression | null {
  const source = input.files.get(finding.primaryOccurrence.file)
  if (!source) return null

  const lines = source.split('\n')
  const after = lines.slice(finding.primaryOccurrence.endLine)
  if (after.length === 0) return null

  const CLAIM = /\b([A-Za-z_]\w{2,})\b[^.]{0,60}?(?:is\s+not\s+used|isn't\s+used|unused|no\s+longer\s+used|only\s+used\s+(?:for|to|in))/i

  for (const assumption of finding.suggestion.assumptions) {
    const m = CLAIM.exec(assumption)
    const name = m?.[1]
    if (!name) continue
    // Words that are never identifiers in this position, only prose.
    if (/^(?:the|this|that|value|result|variable|field|column|query|row|data)$/i.test(name)) continue

    const use = new RegExp(String.raw`\b${escapeRe(name)}\b`)
    const lineOffset = after.findIndex((l) => use.test(stripComment(l)))
    if (lineOffset === -1) continue

    const lineNo = finding.primaryOccurrence.endLine + lineOffset + 1
    return {
      reason: 'unsupported-assumption',
      detail: `The finding assumes "${assumption.trim()}", but \`${name}\` is used again at ${finding.primaryOccurrence.file}:${lineNo} — \`${after[lineOffset]!.trim().slice(0, 100)}\`. The assumption the rewrite rests on is false.`,
    }
  }

  return null
}

/**
 * Severity, derived from evidence rather than clamped against the model's.
 *
 * This used to be a ceiling: the model proposed a severity and evidence could
 * only lower it. Three runs on a real repository showed why that is not enough —
 * across 27 published findings, **not one came out above `low`**, because the
 * model rated almost everything `low` and a ceiling can only agree. Meanwhile
 * the tool was holding checked facts the model had not used: the query sits two
 * loops deep, on a request path, with three counted structural facts.
 *
 * Evidence now sets the value in both directions. The model's own rating is kept
 * on the finding as `modelSeverity` — it is unverified prose, and the honest
 * place for it is beside the answer rather than in it.
 *
 * Every input is something this codebase computed and can defend: the trigger
 * and loop depth are read from the fetched file, not from the model's
 * `triggeredBy`, and the counted facts are derived from the two versions.
 */
export function severityFromEvidence(
  finding: Finding,
  scope: EnclosingScope | null,
): { severity: Severity; because: string } {
  const perIteration = (scope?.loopDepth ?? 0) > 0 || scope?.opensLoop === true
  const counted = finding.performance?.counted.length ?? 0
  // An index outlives the statement that created it, so where that statement
  // lives says nothing about its cost.
  const schemaObject = concernsASchemaObject(finding)

  if (!schemaObject && (scope?.trigger === 'migration' || scope?.trigger === 'test')) {
    return {
      severity: 'info',
      because: `this code is reached by a ${scope!.trigger === 'test' ? 'test' : 'migration or seed'}, so it runs once at install time or never in production.`,
    }
  }
  if (schemaObject && scope?.trigger === 'test') {
    return { severity: 'info', because: 'the index is declared only in test fixtures.' }
  }

  // A query per iteration on a request path is the highest-value thing this tool
  // can find, and it is decided from the file rather than from prose.
  if (perIteration && scope?.trigger === 'request-handler') {
    return {
      severity: counted > 0 ? 'high' : 'medium',
      because: counted > 0
        ? `the query runs once per iteration of an enclosing loop, on a request path, and ${counted} structural fact(s) were counted from the two versions.`
        : 'the query runs once per iteration of an enclosing loop, on a request path — but no structural fact could be counted, so it is not rated higher.',
    }
  }
  if (perIteration) {
    return {
      severity: counted > 0 ? 'medium' : 'low',
      because: `the query runs once per iteration of an enclosing loop, reached by ${scope?.trigger ?? 'an unknown path'}.`,
    }
  }

  if (finding.category === 'n-plus-one') {
    return {
      severity: 'low',
      because: 'it is reported as an N+1, but the query is not inside a loop in the fetched source.',
    }
  }
  if (schemaObject) {
    return {
      severity: counted > 0 ? 'medium' : 'low',
      because: 'it concerns an index, whose cost is paid on every write for as long as it exists.',
    }
  }
  if (counted === 0) {
    return {
      severity: 'low',
      because: 'no structural fact could be counted from the two versions, so nothing supports a higher rating.',
    }
  }
  return { severity: 'medium', because: `${counted} structural fact(s) were counted from the two versions.` }
}

/**
 * Weakly-supported sites cannot be rated `high`.
 *
 * Sampled triage authors the union of what any sample flagged, which is what
 * keeps recall up — a site only has to be caught once. The cost is that a site
 * one sample flagged and the others called clean reaches authoring on the same
 * footing as one every sample flagged, and the model, asked to write up a site
 * it has been handed as a problem, generally will.
 *
 * The cap is deliberately soft, and applied only in the absence of counted
 * facts. Agreement is evidence about the *site*; a counted fact is evidence
 * about the *rewrite*, and the second is stronger. A 1-of-3 site with three
 * structural facts counted from the two versions is a real finding that two
 * samples happened to miss — that is the variance sampling exists to cover, and
 * demoting it would undo the recall the union just bought. A 1-of-3 site with
 * nothing counted has no evidence from either direction.
 */
export function capBySupport(
  severity: Severity,
  finding: Finding,
): { severity: Severity; note?: string } {
  const support = finding.triageSupport
  if (!support || support.samples < 3) return { severity }

  const ratio = support.flagged / support.samples
  if (ratio >= 0.5) return { severity }
  if ((finding.performance?.counted.length ?? 0) > 0) return { severity }
  if (severity !== 'high' && severity !== 'medium') return { severity }

  return {
    severity: severity === 'high' ? 'medium' : 'low',
    note:
      `Rated down: ${support.flagged} of ${support.samples} triage samples flagged this site, ` +
      'and no structural fact could be counted from the two versions.',
  }
}

/** Kept for callers that only want the upper bound. */
export function severityCeiling(finding: Finding, scope: EnclosingScope | null): Severity {
  return severityFromEvidence(finding, scope).severity
}

function calibrate(finding: Finding, scope: EnclosingScope | null): Finding {
  const notes = [...finding.groundingNotes]
  const derived = severityFromEvidence(finding, scope)
  let severity = derived.severity

  if (severity !== finding.severity) {
    notes.push(
      `Severity is ${severity}, not the ${finding.severity} the model proposed: ${derived.because}`,
    )
  }

  /*
   * A citation that could not be confirmed caps the rating — and now means only
   * that. It used to fire on any note at all, "predicate equivalence is
   * undecidable" included, which is true of every ORM rewrite; so every ORM
   * finding was demoted and told the user its citations were unverified.
   */
  let summary = finding.summary
  if (finding.grounding === 'needs-verification' && SEVERITY_RANK[severity] < SEVERITY_RANK['low']) {
    severity = 'low'
    summary = `[Unverified citation] ${summary}`
    notes.push('Severity capped at low: a citation could not be confirmed against the fetched source.')
  }

  // Applied last, so it caps whatever the evidence and grounding settled on
  // rather than being overwritten by them.
  const capped = capBySupport(severity, finding)
  severity = capped.severity
  if (capped.note) notes.push(capped.note)

  return { ...finding, severity, modelSeverity: finding.severity, summary, groundingNotes: notes }
}

/** The empty report, stated as the good outcome it usually is. */
export function summariseGate(result: GateResult, sitesAnalysed: number, files: number): string {
  const total = result.suppressed.length
  if (result.published.length === 0 && total === 0) {
    return `**No findings.** ${sitesAnalysed.toLocaleString()} query site(s) analysed across ${files.toLocaleString()} file(s). ` +
      'Nothing here reduces a round trip, a scan or a fetch without changing output. That is a good outcome, not an empty one.'
  }
  if (total === 0) {
    return `**${result.published.length} finding(s) published.** None were suppressed by the value gate.`
  }
  const parts = (Object.keys(result.counts) as SuppressionReason[])
    .filter((r) => result.counts[r] > 0)
    .map((r) => `${result.counts[r]} ${LABELS[r]}`)
  return `**${result.published.length} finding(s) published, ${total} suppressed** — ${parts.join(', ')}.`
}

export const LABELS: Record<SuppressionReason, string> = {
  'no-op': 'no-op (proposal identical to the original)',
  'wrong-direction': 'wrong direction (proposal issues no fewer queries)',
  'not-data-access': 'not data access',
  'cold-path': 'cold path (migration, seed or test)',
  'unsupported-assumption': 'contradicted assumption',
  'immaterial': 'immaterial (a column narrowing on a query that runs once)',
  'invented-symbol': 'invented symbol (the proposal names something the repository does not contain)',
  'unsupported-speculation': 'unsupported speculation (nothing counted, weak triage support, benefit is data-dependent)',
}

/**
 * A rewrite whose text differs and whose behaviour does not.
 *
 * The whitespace comparison above catches reformatting. It cannot catch a
 * change that is real text and no change at all, and adjudicating one real run
 * found three of them among four false positives — every one published, one at
 * `high` with grounding `verified`:
 *
 *   `.only("pk").exists()`  vs  `.exists()`
 *   `get((Q(a) | Q(b)))`    vs  `get(Q(a) | Q(b))`
 *   a queryset re-indented into a `for` header, whose own equivalence argument
 *   opened "The proposed code is identical to the original."
 *
 * Each emits byte-identical SQL. Publishing them is worse than publishing a
 * merely weak finding: a reader who applies one and measures nothing learns
 * that the tool's `high` band is not worth reading.
 *
 * The approach is deliberately narrow — normalise the handful of constructs
 * that are *provably* inert, then compare. It is not an attempt at semantic
 * equivalence in general, which needs a solver; it is a list of things known to
 * do nothing, each of which has to be defensible on its own.
 */
export function judgeSemanticNoOp(original: string, proposed: string): Suppression | null {
  const a = normaliseInert(original)
  const b = normaliseInert(proposed)
  if (a !== b || a.length === 0) return null

  return {
    reason: 'no-op',
    detail:
      'The proposal reads differently but does the same thing: once inert constructs are ' +
      'normalised (redundant parentheses, and column-selection calls that have no effect on ' +
      'the statement they precede) the two versions are identical, so they emit the same SQL. ' +
      'There is nothing to apply.',
  }
}

/**
 * Constructs that provably do not change the emitted statement.
 *
 * `.only()` / `.defer()` before `.exists()` or `.count()` is the load-bearing
 * case. Those methods control which columns are SELECTed when a model instance
 * is *materialised*; `.exists()` materialises nothing — it compiles to
 * `SELECT (1) AS a1 ... LIMIT 1` — and `.count()` compiles to `SELECT COUNT(*)`.
 * Neither reads the deferred-field set at all, so removing the call changes
 * nothing. `.values()`/`.values_list()` are deliberately NOT included: they do
 * change what a queryset yields.
 *
 * Redundant parentheses are the other, and they need a balanced scan rather
 * than a regex — the real case was `get((Q(a) | Q(b)))`, whose inner group
 * contains parentheses of its own, so a character-class pattern cannot see it.
 */
function normaliseInert(code: string): string {
  let out = collapse(code)

  // `.only(...)` / `.defer(...)` immediately preceding a call that materialises
  // nothing. Repeated so `.only(...).defer(...).exists()` collapses fully.
  const INERT_BEFORE_SCALAR = /\.\s*(?:only|defer)\s*\([^()]*\)\s*(?=\.\s*(?:exists|count)\s*\()/g
  let previous: string
  do {
    previous = out
    out = out.replace(INERT_BEFORE_SCALAR, '')
  } while (out !== previous)

  do {
    previous = out
    out = stripRedundantParens(out)
  } while (out !== previous)

  // Python treats `if (cond):` and `if cond:` identically. The trailing colon
  // is dropped alongside so a statement and its bare expression compare equal —
  // which is what makes the `if`-wrapped and unwrapped forms of the same
  // condition register as the same code.
  out = out.replace(/\b(if|elif|while|return|assert)\s+/g, '$1 ').replace(/\s*:\s*$/, '')

  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Remove one layer of parentheses that wraps nothing but another complete
 * group, or that wraps an entire `if` / `while` / `return` operand.
 *
 * Balanced, because the constructs this exists for are nested: `((Q(a) | Q(b)))`
 * and `if ( x and y.filter(z).exists() ):`.
 */
function stripRedundantParens(code: string): string {
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '(') continue
    const close = matchingParen(code, i)
    if (close === -1) continue

    const inner = code.slice(i + 1, close).trim()
    if (inner.length === 0) continue

    // `f((x))` — the outer pair encloses exactly one complete group.
    if (inner.startsWith('(') && matchingParen(inner, 0) === inner.length - 1) {
      return code.slice(0, i) + '(' + inner.slice(1, -1).trim() + ')' + code.slice(close + 1)
    }

    // `if ( cond ):` — the pair follows a keyword and is the whole operand.
    const before = code.slice(0, i).trimEnd()
    const after = code.slice(close + 1).trim()
    const keyword = /\b(?:if|elif|while|return|assert|not)$/.test(before)
    if (keyword && (after === '' || after === ':')) {
      return `${before} ${inner}${after}`
    }
  }
  return code
}

/** Index of the `)` closing the `(` at `from`, or -1 when unbalanced. */
function matchingParen(code: string, from: number): number {
  let depth = 0
  for (let i = from; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function stripComment(line: string): string {
  return line.replace(/(?:#|\/\/).*$/, '')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
