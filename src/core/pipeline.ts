import type { Candidate, Finding, RepoFile, RepoRef, ScanReport } from './types'
import type { ParsedRepoUrl } from './repo/parse-url'
import type { RepoClient } from './repo/client'
import { GitHubClient } from './repo/github'
import { GitLabClient } from './repo/gitlab'

import { detectInFile } from './detect/scan'
import { isSchemaFile } from './detect/rules'
import { isScannable, RepoError } from './repo/client'
import { buildUserPrompt, SYSTEM_PROMPT } from './analyze/prompt'
import { parseFindings } from './analyze/parse'
import { groundFindings } from './analyze/ground'
import { buildSchemaFacts } from './analyze/schema-facts'
import { findRelevantFiles, sampleRelevantFile } from './detect/relevance'
import {
  createProvider, estimateTokens, LlmError,
  type LlmProvider, type ProviderConfig,
} from './providers'
import {
  cacheKey, chunkKey, hashChunk, readCache, readChunkCache, writeCache, writeChunkCache,
} from './report/cache'
import { findModel } from '@/config/models'
import { estimateCost, type CostEstimate } from '@/config/pricing'

export interface ScanOptions extends ProviderConfig {
  temperature: number
  maxOutputTokens: number
  tokenBudget: number
  githubToken?: string
  gitlabToken?: string
  ref?: string
  /**
   * Restrict findings to the files a pull/merge request touches.
   *
   * The whole repository is still ingested — one archive request costs the
   * same either way, and schema files elsewhere in the tree are needed as
   * evidence. Only the *candidates* are narrowed, which is where the tokens go.
   */
  pullRequest?: number
  signal?: AbortSignal
  onProgress?: (p: ScanProgress) => void
  /** Skip the session cache and re-run everything from scratch. */
  noCache?: boolean
  /**
   * Called once the work is known but before any tokens are spent. Returning
   * false cancels the scan. This is the only point at which a real estimate
   * exists — before detection there is nothing to estimate from.
   */
  onEstimate?: (estimate: ScanEstimate) => boolean | Promise<boolean>
  /**
   * Dependency injection seam, for tests.
   *
   * runScan owns a lot of orchestration — ingest strategy, chunking, budget,
   * cancellation, grounding — and none of it was reachable without real
   * network calls. Overriding the two boundaries makes all of it testable.
   */
  deps?: {
    client?: RepoClient
    provider?: LlmProvider
  }
}

export interface ScanEstimate {
  candidates: number
  passes: number
  /** Passes already cached, which cost nothing. */
  cachedPasses: number
  cost: CostEstimate
}

export type ScanPhase =
  | 'resolving' | 'cached' | 'listing' | 'fetching' | 'detecting'
  | 'estimating' | 'analysing' | 'grounding' | 'done'

export interface ScanProgress {
  phase: ScanPhase
  message: string
  /** 0..1, or undefined when the total isn't known yet. */
  fraction?: number
  filesFetched: number
  candidatesFound: number
  chunksAnalysed: number
  chunksTotal: number
  tokensUsed: number
  /** Files that timed out or errored and were skipped. Never silent. */
  filesSkipped: number
  /** How the source was obtained. Surfaced so scan cost is legible. */
  ingest?: 'archive' | 'per-file' | null
  /** Forge API calls made so far. One for an archive scan; N+2 otherwise. */
  apiCalls?: number
}

/** Files fetched per batch. Keeps forge rate limits and memory in check. */
const FETCH_CONCURRENCY = 8

export async function runScan(parsed: ParsedRepoUrl, opts: ScanOptions): Promise<ScanReport> {
  const startedAt = Date.now()
  const client: RepoClient =
    opts.deps?.client ??
    (parsed.forge === 'github' ? new GitHubClient(opts.githubToken) : new GitLabClient(opts.gitlabToken))

  const progress: ScanProgress = {
    phase: 'resolving',
    message: 'Resolving repository…',
    filesFetched: 0,
    candidatesFound: 0,
    chunksAnalysed: 0,
    chunksTotal: 0,
    tokensUsed: 0,
    filesSkipped: 0,
    ingest: null,
    apiCalls: 0,
  }
  const report = (p: Partial<ScanProgress>) => {
    Object.assign(progress, p)
    opts.onProgress?.({ ...progress })
  }

  const provider = opts.deps?.provider ?? createProvider(opts)
  const availability = await provider.isAvailable()
  if (!availability.ok) throw new LlmError(availability.reason ?? 'Provider unavailable.', 'unavailable')

  /* 1. Resolve ------------------------------------------------------------ */
  const ctx = { signal: opts.signal }
  const repo: RepoRef = await client.resolve(parsed, opts.ref, ctx)

  /* 1a. Cache -------------------------------------------------------------- */
  // Checked here, after resolving the ref to a commit SHA but before any file
  // fetching. Resolution costs two API calls; a hit then skips several hundred
  // file reads and every LLM pass. Keyed by SHA, so a new commit never hits.
  const key = cacheKey({
    commitSha: repo.commitSha,
    provider: opts.provider,
    model: opts.model,
    scope: opts.pullRequest !== undefined ? `pr-${opts.pullRequest}` : 'repo',
  })

  if (!opts.noCache) {
    const hit = await readCache(key)
    if (hit) {
      report({
        phase: 'cached',
        message: 'Reusing the cached result for this commit.',
        fraction: 1,
      })
      return { ...hit.report, cache: { storedAt: hit.storedAt, expiresInMs: hit.expiresInMs } }
    }
  }

  report({ phase: 'listing', message: 'Listing files…' })

  /* 2+3. Ingest ----------------------------------------------------------- */
  // One archive request beats one request per file by three orders of
  // magnitude against the forge rate limit. Per-file reads remain as a
  // fallback for the cases the archive endpoint cannot serve.
  report({ phase: 'fetching', message: 'Downloading repository archive…' })

  const contents = new Map<string, string>()
  const fetched: RepoFile[] = []
  let skipped = 0
  let apiCalls = 2 // resolve() costs two
  let ingest: 'archive' | 'per-file' = 'archive'
  let treeSize = 0
  let truncatedScope: string | undefined

  // Declared here, not next to the analysis loop, because `finish()` reads them
  // and there is an early return for the no-candidates case. A `let` read before
  // its declaration is a temporal dead zone error, not undefined — which is how
  // this surfaced: every repository with zero query sites threw instead of
  // reporting "nothing found".
  // Input and output are counted separately; folding them into one number makes
  // any cost estimate built on it wrong.
  let promptTokens = 0
  let completionTokens = 0
  let chunksReused = 0

  const archive = await client
    .fetchArchive(repo, {
      signal: opts.signal,
      accept: (path, size) => isScannable(path, size),
      onProgress: (bytes, files) =>
        report({
          filesFetched: files,
          message: `Downloading archive — ${(bytes / 1048576).toFixed(1)} MB, ${files} source files…`,
        }),
    })
    .catch(() => null)

  if (archive) {
    apiCalls += 1
    treeSize = archive.files.length
    for (const f of archive.files) {
      contents.set(f.path, f.content)
      fetched.push({ path: f.path, size: f.size, content: f.content })
    }
    report({
      filesFetched: fetched.length,
      fraction: 1,
      message: `Read ${fetched.length} files from one archive request.`,
    })
  } else {
    /* Fallback: list, then read each file. */
    ingest = 'per-file'
    report({ phase: 'listing', message: 'Archive unavailable — listing files…' })

    const tree = await client.listFiles(repo, ctx)
    apiCalls += 1
    treeSize = tree.length

    // Schema files first: they are the evidence the grounding pass checks index
    // claims against, so a scan that runs out of budget must still have them.
    const ordered = [...tree].sort(
      (a, b) => Number(isSchemaFile(b.path)) - Number(isSchemaFile(a.path)),
    )

    report({ phase: 'fetching', message: `Reading ${ordered.length} files…` })

    for (let i = 0; i < ordered.length; i += FETCH_CONCURRENCY) {
      throwIfAborted(opts.signal)
      const batch = ordered.slice(i, i + FETCH_CONCURRENCY)

      const results = await Promise.allSettled(
        batch.map(async (f) => ({ ...f, content: await client.readFile(repo, f.path, ctx) })),
      )
      apiCalls += batch.length

      for (const r of results) {
        if (r.status === 'fulfilled') {
          contents.set(r.value.path, r.value.content)
          fetched.push(r.value)
          continue
        }
        const reason = r.reason as { kind?: string } | undefined
        if (reason?.kind === 'cancelled') throw new LlmError('Scan cancelled.', 'cancelled')
        skipped++
      }

      report({
        filesFetched: fetched.length,
        filesSkipped: skipped,
        ingest,
        apiCalls,
        fraction: (i + batch.length) / ordered.length,
        message: skipped
          ? `Read ${fetched.length} of ${ordered.length} files (${skipped} skipped)…`
          : `Read ${fetched.length} of ${ordered.length} files…`,
      })
    }
  }

  report({ ingest, apiCalls })

  // Reading nothing at all is a failure, not an empty result — surface it
  // rather than reporting a confident "no findings" over an empty tree.
  if (fetched.length === 0) {
    throw new RepoError(
      treeSize === 0
        ? 'No scannable source files were found in this repository.'
        : `None of the ${treeSize} files could be read. Check the token's access and try again.`,
      treeSize === 0 ? 'not-found' : 'network',
    )
  }

  // Built from the DDL the repository declares, before the no-candidates early
  // return so `finish()` can always read it. It cannot know row counts or which
  // indexes exist in production — `unknowable` states that explicitly.
  const schema = buildSchemaFacts(
    fetched
      .filter((f) => isSchemaFile(f.path))
      .map((f) => ({ path: f.path, content: f.content ?? '' })),
  )

  /* 4. Detect ------------------------------------------------------------- */
  report({ phase: 'detecting', message: 'Finding query sites…', fraction: undefined })

  // Diff scope: narrow to the files under review, but keep the rest of the
  // tree available so schema evidence can still be cited.
  let scopedTo: Set<string> | null = null
  if (opts.pullRequest !== undefined) {
    const changed = await client.listChangedFiles(repo, opts.pullRequest, ctx).catch(() => null)
    apiCalls += 1
    if (changed && changed.length > 0) {
      scopedTo = new Set(changed)
      report({ message: `Scoped to ${changed.length} files changed in #${opts.pullRequest}.` })
    } else {
      truncatedScope = `Could not read the files for #${opts.pullRequest}; scanned the whole repository instead.`
    }
  }

  const candidates: Candidate[] = []
  for (const file of fetched) {
    throwIfAborted(opts.signal)
    if (scopedTo && !scopedTo.has(file.path)) continue
    candidates.push(...detectInFile(file.path, file.content ?? ''))
  }
  // Second tier: files that are unmistakably data access but whose queries are
  // not lexically visible — JPA criteria, Django managers, ActiveRecord scopes,
  // Prisma fragments. A regex will never find these, and tightening the rules
  // only trades one error for the other.
  const covered = new Set(candidates.map((c) => c.file))
  const scopedFiles = scopedTo
    ? fetched.filter((f) => scopedTo!.has(f.path))
    : fetched
  const relevant = findRelevantFiles(
    scopedFiles.map((f) => ({ path: f.path, content: f.content ?? '' })),
    covered,
  )
  for (const file of relevant) {
    const content = contents.get(file.path)
    if (!content) continue
    const sample = sampleRelevantFile(file, content)
    if (sample) candidates.push(sample)
  }
  if (relevant.length > 0) {
    report({ message: `${relevant.length} data-access file(s) had no visible query text and were sampled.` })
  }

  // Highest-confidence candidates first, so a budget cut-off truncates the tail.
  candidates.sort((a, b) => b.confidence - a.confidence)
  report({ candidatesFound: candidates.length })

  if (candidates.length === 0) {
    const result = finish([], [], truncatedScope ?? 'no-candidates')
    await writeCache(key, result)
    return result
  }

  /* 5. Analyse ------------------------------------------------------------ */
  const schemaFiles = fetched.filter((f) => isSchemaFile(f.path)).slice(0, 12)
  const model = findModel(opts.provider, opts.model)
  const chunks = chunkCandidates(candidates, schemaFiles, model?.contextWindow ?? 100_000, opts.maxOutputTokens)

  // Declared before the estimate block, which also builds prompts. TypeScript
  // cannot catch a use-before-declaration inside a closure — it has no way to
  // know when the closure runs — so ordering here is on us, and is covered by
  // a test that supplies onEstimate.
  const repoLabel = `${repo.owner}/${repo.name} @ ${repo.ref} (${repo.commitSha.slice(0, 8)})`

  /* 5a. Estimate ---------------------------------------------------------- */
  // A user should know the bill before the money is spent, not after. The
  // chunks are built, so the input side is known rather than guessed.
  const chunkKeys = chunks.map((chunk) =>
    chunkKey({
      hash: hashChunk([
        ...chunk.map((c) => `${c.file}:${c.excerpt}`),
        ...schemaFiles.map((f) => f.content ?? ''),
      ]),
      provider: opts.provider,
      model: opts.model,
    }),
  )

  let cachedPasses = 0
  if (!opts.noCache) {
    const hits = await Promise.all(chunkKeys.map((k) => readChunkCache(k)))
    cachedPasses = hits.filter(Boolean).length
  }

  if (opts.onEstimate) {
    report({ phase: 'estimating', message: 'Working out what this will cost…' })

    const billablePasses = chunks.length - cachedPasses
    const promptTokens = chunks.reduce((sum, chunk, i) => {
      if (!opts.noCache && cachedPasses > 0 && chunkKeys[i] === undefined) return sum
      return sum + estimateTokens(buildUserPrompt({ candidates: chunk, schemaFiles, repoLabel }))
    }, 0)

    const estimate: ScanEstimate = {
      candidates: candidates.length,
      passes: chunks.length,
      cachedPasses,
      cost: estimateCost({
        provider: opts.provider,
        model: opts.model,
        promptTokens: Math.round(promptTokens * (billablePasses / Math.max(1, chunks.length))),
        passes: billablePasses,
        maxOutputTokens: opts.maxOutputTokens,
      }),
    }

    const proceed = await opts.onEstimate(estimate)
    if (!proceed) throw new LlmError('Scan cancelled.', 'cancelled')
  }

  report({
    phase: 'analysing',
    chunksTotal: chunks.length,
    message: `Analysing ${candidates.length} query sites in ${chunks.length} passes…`,
  })

  const raw: Finding[] = []
  let truncatedReason: string | undefined

  for (const [index, chunk] of chunks.entries()) {
    throwIfAborted(opts.signal)

    if (promptTokens + completionTokens >= opts.tokenBudget) {
      truncatedReason = `Stopped at the ${opts.tokenBudget.toLocaleString()} token budget. ${chunks.length - index} passes were not run.`
      break
    }

    const user = buildUserPrompt({ candidates: chunk, schemaFiles, repoLabel })

    // Keyed on the analysed *content*, deliberately excluding the repo label —
    // that carries the commit SHA, and hashing it would make this cache miss on
    // every commit, which is exactly the case it exists to serve.
    const ckey = chunkKey({
      hash: hashChunk([
        ...chunk.map((c) => `${c.file}:${c.excerpt}`),
        ...schemaFiles.map((f) => f.content ?? ''),
      ]),
      provider: opts.provider,
      model: opts.model,
    })

    if (!opts.noCache) {
      const cachedChunk = await readChunkCache(ckey)
      if (cachedChunk) {
        chunksReused++
        raw.push(...parseFindings(cachedChunk.text).findings)
        report({
          chunksAnalysed: index + 1,
          fraction: (index + 1) / chunks.length,
          message: `Reused pass ${index + 1} of ${chunks.length} from cache…`,
        })
        continue
      }
    }

    try {
      const res = await provider.complete({
        system: SYSTEM_PROMPT,
        user,
        temperature: opts.temperature,
        maxOutputTokens: opts.maxOutputTokens,
        signal: opts.signal,
      })
      promptTokens += res.promptTokens
      completionTokens += res.completionTokens
      void writeChunkCache(ckey, {
        text: res.text,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
      })
      const { findings } = parseFindings(res.text)
      raw.push(...findings)
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'cancelled') throw e
      if (e instanceof LlmError && e.kind === 'context-length' && chunk.length > 1) {
        // Split and retry once. Common on the on-device model.
        const half = Math.ceil(chunk.length / 2)
        chunks.splice(index + 1, 0, chunk.slice(0, half), chunk.slice(half))
        continue
      }
      if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'unavailable')) throw e
      // Anything else: skip this pass, keep the scan alive, note it.
      truncatedReason = `Some passes failed: ${(e as Error).message}`
    }

    report({
      chunksAnalysed: index + 1,
      tokensUsed: promptTokens + completionTokens,
      fraction: (index + 1) / chunks.length,
      message: `Analysed pass ${index + 1} of ${chunks.length}…`,
    })
  }

  /* 6. Ground ------------------------------------------------------------- */
  // A cancel arriving during the last pass must not yield a report that looks
  // complete. The loop only checks on entry, so check once more on the way out.
  throwIfAborted(opts.signal)
  report({ phase: 'grounding', message: 'Verifying every citation against the source…' })
  const { kept, rejected } = groundFindings(raw, { files: contents, schema })

  const result = finish(kept, rejected, truncatedReason ?? truncatedScope)

  // Awaited, not fire-and-forget: an un-awaited write can land *after* a
  // subsequent clear and silently resurrect the entry.
  // Caching an empty or truncated result is deliberate — "we looked and found
  // nothing" is an answer worth not paying for twice. A cancelled scan throws
  // before reaching here, so a partial run is never cached.
  await writeCache(key, result)
  return result

  function finish(kept: Finding[], rejected: Finding[], reason?: string): ScanReport {
    report({ phase: 'done', message: 'Done.', fraction: 1 })
    const result: ScanReport = {
      id: `${repo.commitSha.slice(0, 8)}-${Date.now().toString(36)}`,
      repo,
      createdAt: new Date().toISOString(),
      provider: opts.provider,
      model: opts.model,
      findings: sortFindings(kept),
      rejected,
      schema: {
        tables: schema.tables.size,
        indexes: schema.indexes.length,
        sources: schema.sources,
        unknowable: schema.unknowable,
      },
      stats: {
        filesInTree: treeSize,
        filesFetched: fetched.length,
        filesSkipped: skipped,
        ingest,
        apiCalls,
        candidatesFound: candidates.length,
        chunksAnalysed: progress.chunksAnalysed,
        promptTokens,
        completionTokens,
        chunksReused,
        elapsedMs: Date.now() - startedAt,
      },
      truncatedReason: reason === 'no-candidates' ? undefined : reason,
      scope: opts.pullRequest !== undefined && scopedTo
        ? { kind: 'pull-request', number: opts.pullRequest, files: scopedTo.size }
        : { kind: 'repository' },
    }

    return result
  }
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    // Verified findings outrank unverified ones at the same severity — the
    // report should lead with what we can prove.
    const byKind = Number(a.kind === 'behavioural') - Number(b.kind === 'behavioural')
    if (byKind !== 0) return byKind
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    return Number(b.grounding === 'verified') - Number(a.grounding === 'verified')
  })
}

/**
 * Pack candidates into chunks that fit the model's context alongside the
 * schema files, the system prompt and the reserved output space.
 */
export function chunkCandidates(
  candidates: Candidate[],
  schemaFiles: RepoFile[],
  contextWindow: number,
  maxOutputTokens: number,
): Candidate[][] {
  const overhead =
    estimateTokens(SYSTEM_PROMPT) +
    schemaFiles.reduce((sum, f) => sum + estimateTokens(f.content ?? ''), 0)

  // Leave 20% headroom — token estimates are approximate and a context
  // overflow costs a whole round trip.
  const available = Math.max(1_500, Math.floor((contextWindow - overhead - maxOutputTokens) * 0.8))

  const chunks: Candidate[][] = []
  let current: Candidate[] = []
  let currentTokens = 0

  for (const c of candidates) {
    const cost = estimateTokens(c.excerpt) + 60
    if (current.length > 0 && currentTokens + cost > available) {
      chunks.push(current)
      current = []
      currentTokens = 0
    }
    current.push(c)
    currentTokens += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('Scan cancelled.', 'cancelled')
}
