/**
 * speeDB core domain types.
 *
 * These types are the contract between the four stages of the pipeline:
 *   ingest (repo -> RepoFile[])
 *   detect (RepoFile[] -> Candidate[])       ... deterministic, zero tokens
 *   analyze (Candidate[] -> Finding[])       ... LLM
 *   ground  (Finding[] -> Finding[])         ... deterministic re-validation
 *
 * The `ground` stage is why this product is trustworthy: every claim the model
 * makes about a file path, line range, column, index or table is re-checked
 * against the bytes we actually fetched before it is ever shown to a user.
 */

import type { EquivalenceCheck } from './analyze/equivalence'
import type { PerformanceCheck } from './analyze/performance'
import type { IndexAdvice } from './analyze/schema-facts'
import type { EnclosingScope } from './detect/scope'
import type { EngineProfile } from './detect/engine-profile'
import type { Suppression } from './analyze/gate'
export type { EnclosingScope, TriggerKind } from './detect/scope'
export type { EngineProfile, EngineDeclaration } from './detect/engine-profile'
export type { SuppressionReason, Suppression } from './analyze/gate'
export type { EquivalenceCheck, EquivalenceStatus, EquivalenceDelta } from './analyze/equivalence'
export type { PerformanceCheck, PerformanceStatus, VerificationStep } from './analyze/performance'
export type { IndexAdvice, SchemaFacts, IndexFact } from './analyze/schema-facts'

/* ------------------------------------------------------------------ repo -- */

export type Forge = 'github' | 'gitlab'

export interface RepoRef {
  forge: Forge
  /** Base API origin. Lets us support self-hosted GitLab later without a type change. */
  apiOrigin: string
  owner: string
  name: string
  /** Branch, tag, or SHA as the user typed it. */
  ref: string
  /** Resolved commit SHA. This, not `ref`, is the cache key. */
  commitSha: string
}

export interface RepoFile {
  path: string
  size: number
  /** Populated lazily — the tree walk lists every file, we only fetch candidates. */
  content?: string
}

/* --------------------------------------------------------------- detect -- */

/**
 * An engine id from the registry in `config/engines.ts`. Kept as a string
 * rather than a closed union so adding an engine is a one-file change; the
 * registry is the single source of truth and `engineSpec()` always resolves,
 * falling back to 'unknown'.
 */
export type DbEngine = string

export type AccessStyle =
  | 'raw-sql' | 'query-builder' | 'orm' | 'stored-procedure'
  | 'aggregation-pipeline' | 'search-dsl' | 'kv-command' | 'ddl-migration'
  | 'graph-traversal' | 'vector-search' | 'timeseries-query' | 'object-query'
  | 'map-reduce' | 'rest-data-api'

/** A span of source the detector thinks contains a query. Cheap, local, no LLM. */
export interface Candidate {
  id: string
  file: string
  startLine: number
  endLine: number
  /** The raw source excerpt, plus a few lines of context either side. */
  excerpt: string
  engine: DbEngine
  accessStyle: AccessStyle
  /** Which detector rule matched — useful for tuning precision. */
  detector: string
  /**
   * 0..1. Detector's own confidence that this IS a query — a precision signal.
   * Gated on, never ranked on: it says nothing about whether the query matters.
   */
  confidence: number
  /**
   * 0..1. How likely this query is to matter — the ranking signal.
   *
   * The per-file cap used to keep the first N spans by line number, which in a
   * file whose expensive report view sits at the bottom discarded exactly the
   * half worth analysing. Capping now happens on this.
   */
  priority: number
  /** Why it scored that way. Surfaced in the report's coverage section. */
  priorityReasons: string[]
  /**
   * What encloses the query: loop nesting, the nearest symbol, and what
   * triggers the path. A query that runs once per request inside a loop and a
   * query at module scope are not the same finding, and without this the
   * `n-plus-one` category was unreachable except by luck.
   */
  scope?: EnclosingScope
}

/* -------------------------------------------------------------- findings -- */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type FindingCategory =
  | 'missing-index' | 'redundant-index' | 'full-scan' | 'n-plus-one'
  | 'over-fetch' | 'unbounded-result' | 'plan-cache-miss' | 'round-trip'
  | 'inefficient-join' | 'implicit-cast' | 'sort-in-memory' | 'batching'
  | 'transaction-scope' | 'connection-handling' | 'other'

/**
 * Two classes of output, never mixed in the UI:
 *  - `equivalent`  : the promise. Same rows, same order, same NULL/dup semantics.
 *  - `behavioural` : a real bug or an improvement that DOES change output.
 *                    Shown in its own clearly-labelled section.
 */
export type FindingKind = 'equivalent' | 'behavioural'

/** Where a query is actually used — the "where is it used" half of the report. */
export interface QueryOccurrence {
  file: string
  startLine: number
  endLine: number
  /** Enclosing function or method name, as found in the source. */
  enclosingSymbol?: string
  /** The route, event handler, job or CLI entry that ultimately triggers this. */
  triggeredBy?: string
  /** Verbatim excerpt from the fetched file. Re-verified by the grounding pass. */
  excerpt: string
}

export type EvidenceKind =
  | 'schema' | 'migration' | 'index-definition' | 'model-definition'
  | 'call-site' | 'config'

/**
 * A citation. The grounding pass asserts that `file` exists in the scanned tree
 * and that `quote` appears verbatim within the given line range. Anything that
 * fails is stripped and the finding is downgraded.
 */
export interface Evidence {
  kind: EvidenceKind
  file: string
  startLine: number
  endLine: number
  quote: string
  /** Why this citation supports the suggestion. One sentence. */
  relevance: string
}

export interface Suggestion {
  /** The rewritten query / code, ready to paste. */
  proposed: string
  /** Plain-English, jargon-light. "Why this is faster." */
  rationale: string
  /**
   * The equivalence argument — the single most important field in the product.
   * Must address: same rows, same column set, same ordering guarantees,
   * same NULL and duplicate handling, same error behaviour.
   */
  equivalenceArgument: string
  /** Anything that must be true for the rewrite to be safe. */
  assumptions: string[]
  /** e.g. "one plan cached instead of four", "1 round trip instead of N". */
  expectedImpact: string
  /** Migration/DDL that must run first, if any. */
  requiredMigration?: string
}

export type GroundingStatus =
  /** Every citation verified against fetched bytes. */
  | 'verified'
  /** Rendered, but one or more citations could not be confirmed. Badged in UI. */
  | 'needs-verification'
  /** Failed hard (fabricated path, quote not present). Dropped from the report. */
  | 'rejected'

export interface Finding {
  id: string
  kind: FindingKind
  title: string
  /** One-sentence statement of the problem. */
  summary: string
  severity: Severity
  category: FindingCategory
  engine: DbEngine
  accessStyle: AccessStyle

  /** The query as it exists today. */
  original: string
  /** Primary site, plus every other place the same query shape appears. */
  primaryOccurrence: QueryOccurrence
  otherOccurrences: QueryOccurrence[]

  suggestion: Suggestion
  evidence: Evidence[]

  /**
   * Machine check of the same-output claim. Distinct from `grounding`, which
   * only proves the citations are real — this examines the queries themselves.
   */
  equivalence?: EquivalenceCheck
  /**
   * The speed claim. Always unmeasured — speeDB executes nothing — and carries
   * the commands that settle it. Kept separate from `equivalence` because
   * "returns the same rows" and "is faster" are different claims with
   * different evidence.
   */
  performance?: PerformanceCheck
  /** Result of checking a proposed index against the declared schema. */
  indexAdvice?: IndexAdvice

  /**
   * The enclosing scope of the primary occurrence, recomputed from the fetched
   * file rather than taken from the model. Drives the severity ceiling and the
   * cold-path suppression rule.
   */
  scope?: EnclosingScope
  /** Set when the value gate held this finding back. Never silently dropped. */
  suppression?: Suppression

  /**
   * The severity the model proposed, kept beside the derived one.
   *
   * `severity` is computed from checked evidence — loop depth, trigger, counted
   * facts. This is the model's unverified guess, retained so a disagreement is
   * visible rather than silently overwritten.
   */
  modelSeverity?: Severity

  /**
   * How many triage samples flagged this site, out of how many ran.
   *
   * Sampled triage runs the same pass N times and authors the union — a site
   * only has to be flagged once to get written up, which is what keeps recall
   * up. But the union threw away the count, so a site 3 of 3 samples called a
   * problem and a site 1 of 3 flagged while the other two called it clean
   * arrived at authoring, at severity, and at the report as identical evidence.
   *
   * The count is already computed and costs nothing to keep. It is a confidence
   * signal about the *site*, not about the argument — which is why it caps
   * severity and feeds the value gate rather than deciding either on its own. A
   * weakly-supported site with three counted facts is still a real finding; a
   * weakly-supported site with none is the shape of a guess.
   *
   * Absent on the single-shot path, which has no triage stage to sample.
   */
  triageSupport?: { flagged: number; samples: number }

  grounding: GroundingStatus
  /** Human-readable reasons the grounding pass flagged this. */
  groundingNotes: string[]
  /** Model's own confidence, 0..1. Never the only gate — grounding is. */
  modelConfidence: number
}

/* ---------------------------------------------------------------- report -- */

export interface ScanStats {
  filesInTree: number
  filesFetched: number
  /** Files that could not be read (timeout, LFS pointer, permissions). */
  filesSkipped: number
  /** How the source was obtained: one archive request, or one call per file. */
  ingest: 'archive' | 'per-file' | null
  /** Total forge API calls. The archive path makes three; per-file makes N+3. */
  apiCalls: number
  candidatesFound: number
  /**
   * Every candidate site either tier produced, before any filtering.
   *
   * Tier two is included, and must be: counting only the tier-one merged spans
   * made `sitesAnalysed` exceed `sitesMatched` on any repository where a
   * data-access file has no lexically visible query — which is most Java and
   * Rails repositories, and was 5 of 29 sites on spring-petclinic. Numbers that
   * do not add up are their own kind of dishonesty.
   */
  sitesMatched: number
  /** Of those, how many came from tier two: whole-file samples. */
  sitesSampled: number
  /**
   * Candidates that survived filtering and were lined up for analysis.
   *
   * Distinct from `sitesAnalysed`, which counts only what a completed pass
   * actually sent. On a large repository the token budget stops the loop with
   * most of the queue untouched, and conflating the two would claim coverage
   * the scan never had.
   */
  sitesQueued: number
  /** Spans actually sent to the model. */
  sitesAnalysed: number
  /** Dropped before analysis, split by why. `candidatesFound` counts neither. */
  sitesFiltered: { belowConfidence: number; lowPriority: number }
  /** Files where the per-file cap bit, and by how much. Never silent. */
  truncatedFiles: { path: string; found: number; analysed: number }[]
  /**
   * Sites the triage stage was asked about and returned no verdict for.
   *
   * The accounting contract is that every site gets an answer. When one does not
   * it is escalated to the authoring stage rather than assumed clean — but the
   * escalation is a workaround, and a scan where it happened often is a scan
   * whose triage was not working. Surfacing the count is what makes that
   * visible instead of merely handled.
   */
  sitesUnaccounted: number
  /** Triage outcome counts. Tiny, so always recorded. */
  triage?: { flagged: number; clean: number; unsure: number }
  chunksAnalysed: number
  /** Input tokens. Kept separate from output — they are priced differently. */
  promptTokens: number
  completionTokens: number
  /** Analysis passes served from the chunk cache instead of the model. */
  chunksReused: number
  elapsedMs: number
}

export interface ScanReport {
  id: string
  repo: RepoRef
  createdAt: string
  provider: string
  model: string
  findings: Finding[]
  /** Findings the grounding pass rejected — kept for transparency/debugging. */
  rejected: Finding[]
  /**
   * Findings the value gate held back, each carrying its reason.
   *
   * Kept rather than dropped so the gate is auditable: a gate that silently
   * eats a true positive is worse than the padding it was written to remove.
   */
  suppressed: Finding[]
  stats: ScanStats
  /** Populated when the scan stopped early (budget, cancel, rate limit). */
  truncatedReason?: string
  /**
   * Set when the single-archive ingest failed and the scan fell back to reading
   * one file per request.
   *
   * The fallback works, so nothing about the findings changes — but it costs
   * three orders of magnitude more forge API calls, and for a long time it was
   * happening on every GitHub scan without a word anywhere. A performance
   * failure that hides itself is indistinguishable from no failure.
   */
  ingestNote?: string
  /**
   * What the repository declares about its schema, and — just as importantly —
   * what could not be known from source at all.
   */
  schema?: {
    tables: number
    indexes: number
    sources: string[]
    unknowable: readonly string[]
  }
  /**
   * What the repository declares it connects to, with the file and line that
   * declared it. In the header so a wrong inference is visible, not silent.
   */
  engineProfile?: EngineProfile
  /**
   * Per-site triage outcomes.
   *
   * The two-stage analysis built an accounting contract and then threw the
   * accounting away, which left every miss with three indistinguishable causes:
   * triage answered `clean`, triage was never asked, or the author declined the
   * site. A defect at priority 1.0, inside a loop, in a request handler was
   * missed on a real scan and none of those could be ruled out.
   *
   * Flagged and unsure sites carry their reason because that is what you read
   * when a finding looks wrong. Clean sites carry only their id — the bulk of
   * the list, and "was it triaged clean" is the whole question for them.
   */
  triageLog?: {
    flagged: { id: string; category: string; why: string }[]
    unsure: { id: string; category: string; why: string }[]
    clean: string[]
    /** Sites triage never answered for, escalated rather than assumed clean. */
    unaccounted: string[]
  }
  /**
   * What the authoring stage did with each site triage handed it.
   *
   * A site that is neither written up nor explicitly declined was dropped in
   * silence — the same failure the two-stage split was built to remove, one
   * stage later. On the run that exposed it, authoring covered 42% of flagged
   * sites and dropped all ten lines of the three known defects.
   */
  authorLog?: {
    declined: { siteId: string; why: string }[]
    unaccounted: string[]
  }
  /** What was analysed: the whole repository, or one pull/merge request. */
  scope?:
    | { kind: 'repository' }
    | { kind: 'pull-request'; number: number; files: number }
  /** Set when this report was served from the session cache rather than re-run. */
  cache?: {
    /** Epoch ms the underlying scan completed. */
    storedAt: number
    /** Milliseconds until the entry expires. */
    expiresInMs: number
  }
}
