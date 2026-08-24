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
  /** 0..1. Detector's own confidence; used to order work under a token budget. */
  confidence: number
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
  stats: ScanStats
  /** Populated when the scan stopped early (budget, cancel, rate limit). */
  truncatedReason?: string
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
