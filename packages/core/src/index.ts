/**
 * The public surface of `@speedb/core`.
 *
 * Curated rather than a wildcard re-export of every module. Everything named
 * here is something a caller outside this package has a reason to use, and
 * anything absent is free to change — the alternative, exporting the whole
 * tree, would turn every internal helper into a compatibility obligation.
 *
 * The two consumers today are the Chrome extension and `@speedb/mcp`. The
 * extension resolves this package from source through a build alias, so it is
 * not restricted to this list; the MCP server consumes the published build and
 * is.
 */

// ── The pipeline ────────────────────────────────────────────────────────────
export { runScan, chunkCandidates } from '@/core/pipeline'
export type { ScanOptions, ScanEstimate, ScanPhase, ScanProgress } from '@/core/pipeline'

// ── The contracts ───────────────────────────────────────────────────────────
export type {
  Candidate, Finding, RepoFile, RepoRef, ScanReport, Severity, DbEngine,
} from '@/core/types'

// ── Detection: deterministic, free, and useful on its own ───────────────────
export {
  detectInFile, detectInFileVerbose, pickEngine, sliceLines,
  MAX_CANDIDATES_PER_FILE, MIN_CONFIDENCE,
} from '@/core/detect/scan'
export type { DetectResult, DetectOptions, Truncation } from '@/core/detect/scan'
export {
  inferEngines, describeEngineProfile, engineFromPath, profileDeclares, sameDialect,
} from '@/core/detect/engine-profile'
export type { EngineProfile, EngineDeclaration } from '@/core/detect/engine-profile'
export { isSchemaFile } from '@/core/detect/rules'
export { findRelevantFiles, sampleRelevantFile } from '@/core/detect/relevance'

// ── The checks that make a claim defensible ─────────────────────────────────
export { checkEquivalence, checkOrmEquivalence } from '@/core/analyze/equivalence'
export type { EquivalenceCheck, EquivalenceStatus, EquivalenceDelta } from '@/core/analyze/equivalence'
export {
  buildSchemaFacts, checkProposedIndex, findRedundantIndexes, UNKNOWABLE,
} from '@/core/analyze/schema-facts'
export type { SchemaFacts, TableFact, IndexFact, IndexAdvice } from '@/core/analyze/schema-facts'
export { groundFindings } from '@/core/analyze/ground'
export { applyValueGate, summariseGate, severityFromEvidence, LABELS } from '@/core/analyze/gate'
export type { GateResult, Suppression, SuppressionReason } from '@/core/analyze/gate'
export { readSqlShape } from '@/core/analyze/sql-shape'
export { readOrmShape } from '@/core/analyze/orm-shape'

// ── Prompts and parsers, exposed so a caller can drive the model itself ─────
export { SYSTEM_PROMPT, buildUserPrompt } from '@/core/analyze/prompt'
export {
  TRIAGE_SYSTEM_PROMPT, buildTriagePrompt, parseTriage, flaggedIds,
} from '@/core/analyze/triage'
export { AUTHOR_SYSTEM_PROMPT, buildAuthorPrompt, reconcileAuthoring } from '@/core/analyze/author'
export { parseFindings } from '@/core/analyze/parse'
export { AUTHOR_SCHEMA, SINGLE_SHOT_SCHEMA, TRIAGE_SCHEMA } from '@/core/analyze/schemas'
export type { ResponseSchema } from '@/core/analyze/schemas'

// ── Reporting ───────────────────────────────────────────────────────────────
export { exportReport, toMarkdown } from '@/core/report/export'
export type { ExportFormat } from '@/core/report/export'
export { toUnifiedDiff, toPatchFile } from '@/core/report/patch'
export { diffLines } from '@/core/report/diff-lines'
export type { DiffLine } from '@/core/report/diff-lines'
export {
  cacheKey, chunkKey, clearCache, cacheSummary, readCache, writeCache, CACHE_TTL_MS,
} from '@/core/report/cache'

// ── Forge access ────────────────────────────────────────────────────────────
export { parseRepoUrl } from '@/core/repo/parse-url'
export type { ParsedRepoUrl } from '@/core/repo/parse-url'
export { GitHubClient } from '@/core/repo/github'
export { GitLabClient } from '@/core/repo/gitlab'
export { isScannable, RepoError } from '@/core/repo/client'
export type { RepoClient, ArchiveCtx, ArchiveResult, RequestCtx, TokenCheck } from '@/core/repo/client'

// ── Providers ───────────────────────────────────────────────────────────────
export { createProvider, estimateTokens, LlmError } from '@/core/providers'
export type {
  LlmProvider, LlmRequest, LlmResponse, ProviderConfig,
} from '@/core/providers'

// ── Storage: the seam that lets any of the above run outside a browser ──────
export { setStorageBackend, resetStorageBackend, memoryBackend, memoryArea, storage } from '@/core/storage'
export type { StorageBackend, StorageArea } from '@/core/storage'

// ── Reference data ──────────────────────────────────────────────────────────
export { ENGINES, FAMILIES, engineSpec, engineLabel, familyLabel, equivalenceNotesFor } from '@/config/engines'
export type { EngineSpec, FamilySpec, DbFamily } from '@/config/engines'
export { explainFor, recipeFor } from '@/config/explain'
export type { ExplainRecipe, ClaimRecipe } from '@/config/explain'
export { estimateCost, PRICES_VERIFIED_ON } from '@/config/pricing'
export type { CostEstimate } from '@/config/pricing'
export { DEFAULTS, PROVIDERS, findModel, findProvider, modelSupportsTemperature } from '@/config/models'
export type { ModelSpec, ProviderId, ProviderSpec } from '@/config/models'
