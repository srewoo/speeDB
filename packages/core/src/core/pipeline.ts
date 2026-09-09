import type { Candidate, Finding, RepoFile, RepoRef, ScanReport } from './types'
import type { ParsedRepoUrl } from './repo/parse-url'
import type { RepoClient } from './repo/client'
import { GitHubClient } from './repo/github'
import { GitLabClient } from './repo/gitlab'

import { detectInFileVerbose, type Truncation } from './detect/scan'
import { inferEngines, type EngineProfile } from './detect/engine-profile'
import { applyValueGate } from './analyze/gate'
import { isSchemaFile } from './detect/rules'
import { isScannable, RepoError } from './repo/client'
import { buildUserPrompt, SYSTEM_PROMPT } from './analyze/prompt'
import {
  buildTriagePrompt, flaggedIds, parseTriage, TRIAGE_SYSTEM_PROMPT, type TriageVerdict,
} from './analyze/triage'
import { AUTHOR_SYSTEM_PROMPT, buildAuthorPrompt, reconcileAuthoring } from './analyze/author'
import { parseFindings } from './analyze/parse'
import {
  AUTHOR_SCHEMA, SINGLE_SHOT_SCHEMA, TRIAGE_SCHEMA, type ResponseSchema,
} from './analyze/schemas'
import { groundFindings } from './analyze/ground'
import { buildSchemaFacts } from './analyze/schema-facts'
import { findRelevantFiles, sampleRelevantFile } from './detect/relevance'
import {
  createProvider, estimateTokens, LlmError,
  type LlmProvider, type LlmRequest, type LlmResponse, type ProviderConfig,
} from './providers'
import {
  cacheKey, chunkKey, hashChunk, readCache, readChunkCache, writeCache, writeChunkCache,
  type AnalysisConfig,
} from './report/cache'
import { DEFAULTS, findModel } from '@/config/models'
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
  /**
   * How to describe the narrowing in the report.
   *
   * A local scan reuses `pullRequest` to reach the same changed-file narrowing,
   * because the mechanism is identical. Only the label differs, and a label
   * that invents a pull request number for a `git diff` is the kind of small
   * untruth this product exists not to tell.
   */
  scopeLabel?: 'pull-request' | 'changed-files'
  signal?: AbortSignal
  onProgress?: (p: ScanProgress) => void
  /**
   * Called once with the candidate set, after detection and before analysis.
   *
   * Exists for the benchmark: candidate coverage — did a real N+1 even become a
   * candidate? — is the metric that isolates detection from the model, and it
   * cannot be computed from a finished report, because the report only contains
   * what the model chose to say. Not used by the extension.
   */
  onCandidates?: (candidates: readonly Candidate[]) => void
  /** Skip the session cache and re-run everything from scratch. */
  noCache?: boolean
  /**
   * Analyse at most this many candidates, highest priority first.
   *
   * A bounded scan: useful for a quick look at a large repository, and for
   * isolating whether a poor result comes from the model or from how much was
   * asked of it at once.
   */
  maxCandidates?: number
  /**
   * How the analysis stage is structured.
   *
   * `single-shot` is the original: one request per chunk, which both decides
   * what is a problem and writes it up. Measured on a real repository it
   * produced about three and a half findings per pass whatever the pass
   * contained, and missed defects sitting at the top of its own input — nothing
   * in the contract required it to say anything about a given site.
   *
   * `two-stage` triages every site cheaply and exhaustively, with the parser
   * checking that each id came back, then authors only the flagged ones.
   * Retained as an option so the two can be compared rather than argued about.
   */
  analysis?: 'single-shot' | 'two-stage'
  /** Sites per triage pass. Output is ~30 tokens each, so this can be large. */
  triageSitesPerPass?: number
  /**
   * Sites per authoring request. Defaults to 1.
   *
   * Batching invited the failure it was meant to avoid. Told to account for
   * every site in a batch of three, a real model covered 45% of them — inside
   * the 33-52% range it managed before being told anything. Asking did not work.
   *
   * One site per request removes the opportunity: there is no batch to skip a
   * site within, so a site is either written up, declined, or visibly returned
   * nothing — and the last case can be retried, which a dropped site inside a
   * batch never could be. It costs more requests, which the cost gate shows.
   */
  authorSitesPerRequest?: number
  /** Retries for a site that came back with neither a finding nor a decline. */
  authorRetries?: number
  /**
   * How many times to triage each pass, taking the union of what is flagged.
   *
   * Run-to-run variance was the largest single term in the measurements: the
   * same configuration found 0 and 2 of the same two defects on different runs.
   * Triage output is small enough that sampling it three times costs less than
   * one authoring request, which makes this the cheapest available answer to
   * variance.
   */
  triageSamples?: number
  /**
   * Drop candidates below this priority before analysis.
   *
   * The counterpart to `MIN_CONFIDENCE`, and the same argument: a candidate that
   * costs a full analysis slot and yields nothing is worse than one that is
   * merely ranked low. Measured on mt-test-studio, 871 candidates of which 36
   * score >= 0.90 and 399 below 0.30 — analysing all of them scored 4%
   * precision, analysing the top 40 scored 50%.
   *
   * There is no safe absolute default: spring-petclinic's entire data layer is
   * DDL that scores low, and a floor of 0.9 would leave it with nothing to
   * analyse. `keepAtLeast` is what makes a floor usable on a small repository.
   */
  minPriority?: number
  /** Never let `minPriority` reduce the set below this many candidates. */
  keepAtLeast?: number
  /**
   * Cap the number of query sites in one analysis pass.
   *
   * `chunkCandidates` packs as many as the context window allows, which
   * minimises round trips and maximises how much the model is asked to reason
   * about at once. Those are not the same objective: 290 sites in a single
   * prompt is efficient and may still be too much to review carefully.
   */
  maxCandidatesPerChunk?: number
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
  /**
   * How the work is actually shaped, when it is not one request per chunk.
   *
   * The gate is the consent mechanism, so it has to describe the work that will
   * happen. When the two-stage analysis landed, the estimate still quoted a
   * chunk count the two-stage path never uses — it said "35 passes" for a scan
   * that ran 15 triage passes and then a number of write-ups nobody could know
   * in advance.
   *
   * Triage input is known exactly: the prompts are built. Authoring is not — it
   * depends on what triage flags — so it is projected from a stated assumption
   * rather than presented as a figure.
   */
  stages?: {
    triage: { passes: number; samples: number; calls: number }
    /** Projected, with the assumption named. Never presented as known. */
    author: { projectedRequests: number; assumption: string }
  }
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
  // Every knob that changes the analysis is in the key. Resolving the defaults
  // *here* rather than passing the raw options matters: a caller that omits
  // `triageSamples` and one that passes the default must produce the same key,
  // or turning a default into an explicit value would evict every cached scan.
  const key = cacheKey({
    commitSha: repo.commitSha,
    provider: opts.provider,
    model: opts.model,
    scope: opts.pullRequest !== undefined ? `pr-${opts.pullRequest}` : 'repo',
    config: {
      sitesPerPass: opts.maxCandidatesPerChunk,
      triageSamples: Math.max(1, opts.triageSamples ?? DEFAULTS.triageSamples),
      minPriority: opts.minPriority,
      mode: opts.analysis ?? 'two-stage',
    } as AnalysisConfig,
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
  /** Why the single-archive ingest failed, when it did. Never swallowed. */
  let archiveError: string | undefined

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
  /**
   * Query sites actually put in front of the model, counted per completed pass.
   *
   * `candidates.length` is what was *queued*, and on a large repository the
   * token budget stops the loop long before the queue empties — Discourse
   * queues 11,046 sites, of which only 396 score above 0.60 and 5,500 sit at
   * the floor. Reporting the queue as "analysed" would be the same overclaim
   * the coverage rewrite exists to remove, in a stat added by that rewrite.
   *
   * Declared up here with the other totals for the reason the comment above
   * gives: `finish()` reads it, and the no-candidates path returns before the
   * analysis loop. Putting it next to that loop threw a temporal dead zone
   * error on every repository with zero query sites — the same way this was
   * found the first time.
   */
  let sitesSent = 0
  /**
   * Sites triage was asked about and never answered for. Reported, not ignored.
   *
   * Declared up here with the other totals, and not beside the triage loop that
   * fills it, because `finish()` reads it and the no-candidates path returns
   * before that loop exists. This is the third variable in this function to
   * learn that lesson; the comment above is the first two.
   */
  const unaccountedSites: string[] = []
  /**
   * Every triage verdict, kept so a miss can be diagnosed instead of guessed at.
   *
   * Declared with the other totals for the reason above: `finish()` reads it and
   * the no-candidates path returns before the triage loop exists.
   */
  const triageLog: {
    flagged: { id: string; category: string; why: string }[]
    unsure: { id: string; category: string; why: string }[]
    clean: string[]
  } = { flagged: [], unsure: [], clean: [] }
  /**
   * What the authoring stage did with each site it was handed.
   *
   * The accounting contract was applied to triage and not to authoring, and the
   * gap was the bottleneck: on a real run triage flagged all ten lines of the
   * three known defects with accurate reasons, and authoring wrote up 42% of
   * flagged sites, dropping those ten without a word.
   */
  const authorLog: {
    declined: { siteId: string; why: string }[]
    unaccounted: string[]
  } = { declined: [], unaccounted: [] }
  /**
   * The token ceiling actually enforced.
   *
   * Starts at the configured budget and is raised to whatever the user approved
   * at the cost gate — see the comment at the `onEstimate` call.
   */
  let effectiveBudget = opts.tokenBudget

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
    // The reason is kept, not discarded. Swallowing it hid a total failure of
    // the headline ingest path: a CORS block on the codeload redirect meant
    // every GitHub scan quietly took the one-request-per-file route instead,
    // three orders of magnitude more expensive against the rate limit, with
    // nothing anywhere saying so.
    .catch((e: unknown) => {
      archiveError = e instanceof Error ? e.message : String(e)
      return null
    })

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
    report({
      phase: 'listing',
      message: archiveError
        ? `Archive request failed (${archiveError}) — falling back to one request per file, which is far more expensive against the forge rate limit.`
        : 'Archive unavailable — listing files…',
    })

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

  // Read what the repository declares it connects to, once, before detection.
  // Every engine guess used to be local, so whichever regex shouted loudest set
  // the label — which is how a Django/MySQL project acquired MongoDB, Hive,
  // BigQuery, Redshift and OpenSearch findings. A declaration in `settings.py`
  // or `docker-compose.yml` is a fact; a vocabulary match is not.
  const engineProfile: EngineProfile = inferEngines(fetched)
  if (engineProfile.declared.length > 0) {
    report({
      message: `Declared data store(s): ${engineProfile.declared.map((d) => d.engine).join(', ')}.`,
    })
  }

  const candidates: Candidate[] = []
  let sitesMatched = 0
  let belowConfidence = 0
  let lowPriority = 0
  const truncatedFiles: Truncation[] = []

  for (const file of fetched) {
    throwIfAborted(opts.signal)
    if (scopedTo && !scopedTo.has(file.path)) continue
    const result = detectInFileVerbose(file.path, file.content ?? '', { profile: engineProfile })
    candidates.push(...result.candidates)
    sitesMatched += result.matched
    belowConfidence += result.belowConfidence
    lowPriority += result.lowPriority
    if (result.truncation) truncatedFiles.push(result.truncation)
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
  // Tier two counts toward the matched total. It produces one candidate per
  // file and none of them are filtered, so leaving it out made `analysed`
  // exceed `matched` — an impossible pair of numbers in the report header.
  let sitesSampled = candidates.length - (
    sitesMatched - belowConfidence - lowPriority
  )
  if (sitesSampled < 0) sitesSampled = 0
  sitesMatched += sitesSampled

  if (relevant.length > 0) {
    report({ message: `${relevant.length} data-access file(s) had no visible query text and were sampled.` })
  }

  // Highest-priority candidates first, so a budget cut-off truncates the tail
  // that matters least rather than the tail that happens to sort last. Ranking
  // on confidence put a certain-but-trivial `objects.get(pk=…)` ahead of a
  // probable N+1 in a request handler, which is the wrong way round.
  candidates.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence)

  if (opts.minPriority !== undefined) {
    const floor = opts.minPriority
    const keep = Math.max(opts.keepAtLeast ?? 0, candidates.filter((c) => c.priority >= floor).length)
    if (keep < candidates.length) {
      const dropped = candidates.length - keep
      lowPriority += dropped
      candidates.length = keep
      truncatedScope =
        `${dropped.toLocaleString()} candidate(s) scored below the ${floor} priority floor and were not analysed. ` +
        'They are counted in the coverage figures, not hidden.'
    }
  }

  if (opts.maxCandidates !== undefined && candidates.length > opts.maxCandidates) {
    const dropped = candidates.length - opts.maxCandidates
    candidates.length = opts.maxCandidates
    truncatedScope =
      `Bounded scan: the ${opts.maxCandidates.toLocaleString()} highest-priority query sites were ` +
      `analysed and ${dropped.toLocaleString()} were not.`
  }

  report({ candidatesFound: candidates.length })
  opts.onCandidates?.(candidates)

  if (candidates.length === 0) {
    const result = finish([], [], truncatedScope ?? 'no-candidates', [])
    await writeCache(key, result)
    return result
  }

  /* 5. Analyse ------------------------------------------------------------ */
  const schemaFiles = fetched.filter((f) => isSchemaFile(f.path)).slice(0, 12)
  const model = findModel(opts.provider, opts.model)
  const chunks = chunkCandidates(
    candidates, schemaFiles, model?.contextWindow ?? 100_000, opts.maxOutputTokens,
    opts.maxCandidatesPerChunk,
  )

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

    let estimate: ScanEstimate

    if ((opts.analysis ?? 'two-stage') === 'two-stage') {
      /*
       * Two stages, so two different estimates. Triage is known: the prompts are
       * built and counted. Authoring depends on what triage flags, which nobody
       * can know before it runs — so it is projected from an assumption that is
       * named in the estimate rather than buried in it.
       */
      const perTriagePass = opts.triageSitesPerPass ?? 60
      const samples = Math.max(1, opts.triageSamples ?? DEFAULTS.triageSamples)
      const triagePasses: Candidate[][] = []
      for (let i = 0; i < candidates.length; i += perTriagePass) {
        triagePasses.push(candidates.slice(i, i + perTriagePass))
      }

      const triageInput = triagePasses.reduce(
        (sum, pass) => sum + estimateTokens(buildTriagePrompt({ candidates: pass, schemaFiles, repoLabel })),
        0,
      ) * samples

      // One site in ten, batched. A guess, stated as one.
      const FLAG_RATE = 0.1
      const perAuthorRequest = Math.max(1, opts.authorSitesPerRequest ?? 1)
      const projectedRequests = Math.max(1, Math.ceil((candidates.length * FLAG_RATE) / perAuthorRequest))
      const authorInput = projectedRequests * estimateTokens(
        buildAuthorPrompt({
          sites: candidates.slice(0, perAuthorRequest).map((c) => ({
            candidate: c,
            verdict: { id: c.id, verdict: 'problem' as const, category: 'other', why: '' },
          })),
          schemaFiles,
          repoLabel,
        }),
      )

      estimate = {
        candidates: candidates.length,
        passes: triagePasses.length * samples + projectedRequests,
        cachedPasses: 0,
        cost: estimateCost({
          provider: opts.provider,
          model: opts.model,
          promptTokens: triageInput + authorInput,
          // Triage output is tiny; the authoring requests are what use the
          // per-pass ceiling, so only those are projected against it.
          passes: projectedRequests,
          maxOutputTokens: opts.maxOutputTokens,
        }),
        stages: {
          triage: { passes: triagePasses.length, samples, calls: triagePasses.length * samples },
          author: {
            projectedRequests,
            assumption: `assumes about ${Math.round(FLAG_RATE * 100)}% of sites are flagged, ${perAuthorRequest} per request — the real number is not knowable until triage runs`,
          },
        },
      }
    } else {
      const billablePasses = chunks.length - cachedPasses
      const promptTokens = chunks.reduce((sum, chunk, i) => {
        if (!opts.noCache && cachedPasses > 0 && chunkKeys[i] === undefined) return sum
        return sum + estimateTokens(buildUserPrompt({ candidates: chunk, schemaFiles, repoLabel }))
      }, 0)

      estimate = {
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
    }

    const proceed = await opts.onEstimate(estimate)
    if (!proceed) throw new LlmError('Scan cancelled.', 'cancelled')

    // Consent sets the ceiling. The gate quotes the whole scan, so cutting that
    // scan short at a *separate* fixed budget would truncate work the user has
    // just approved and quote a figure the run never honours — two mechanisms
    // arguing about the same decision. The fixed budget stays as the safety net
    // for runs with no gate at all.
    if (estimate.cost.totalTokens > effectiveBudget) {
      effectiveBudget = estimate.cost.totalTokens
    }
  }

  // Deliberately no progress line here: the two strategies count their work
  // differently, and announcing a chunk count before dispatching would report a
  // number the two-stage path never uses. Each branch announces its own.

  const raw: Finding[] = []
  let truncatedReason: string | undefined

  const strategy = opts.analysis ?? 'two-stage'
  const budgetSpent = () => promptTokens + completionTokens

  /** Shared by both strategies: one model call, cached, with token accounting. */
  const complete = async (
    system: string,
    user: string,
    cacheSeed: string[],
    schema?: ResponseSchema,
  ) => {
    // The schema is part of the cache identity. A response produced without one
    // and a response the provider guaranteed are different artefacts, and
    // serving the first for the second would hide the change that was just made.
    const ckey = chunkKey({
      hash: hashChunk([...cacheSeed, schema ? `schema:${schema.name}` : 'schema:none']),
      provider: opts.provider,
      model: opts.model,
    })

    if (!opts.noCache) {
      const hit = await readChunkCache(ckey)
      if (hit) {
        chunksReused++
        return { text: hit.text, cached: true }
      }
    }

    const res = await completeWithRateLimitRetry(provider, {
      system,
      user,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      schema,
      signal: opts.signal,
    }, (p) => report({ message: p }))
    promptTokens += res.promptTokens
    completionTokens += res.completionTokens
    void writeChunkCache(ckey, {
      text: res.text,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
    })
    return { text: res.text, cached: false }
  }

  if (strategy === 'two-stage') {
    /* 5b. Triage ---------------------------------------------------------- */
    // Cheap, and required to be exhaustive. The parser reconciles the response
    // against the ids that were sent, so a skipped site is a visible failure
    // rather than a silent "clean".
    const perTriagePass = opts.triageSitesPerPass ?? 60
    const samples = Math.max(1, opts.triageSamples ?? DEFAULTS.triageSamples)
    const triagePasses: Candidate[][] = []
    for (let i = 0; i < candidates.length; i += perTriagePass) {
      triagePasses.push(candidates.slice(i, i + perTriagePass))
    }

    report({
      phase: 'analysing',
      chunksTotal: triagePasses.length,
      message: `Triaging ${candidates.length} query sites in ${triagePasses.length} pass(es)…`,
    })

    const flagged = new Map<string, TriageVerdict>()
    /** Site id -> how many samples flagged it. Denominator in `support`. */
    const agreement = new Map<string, number>()
    /** Site id -> how many samples ran for the pass that site was in. */
    const support = new Map<string, { flagged: number; samples: number }>()

    for (const [index, pass] of triagePasses.entries()) {
      throwIfAborted(opts.signal)
      if (budgetSpent() >= effectiveBudget) {
        truncatedReason = budgetNote(triagePasses, index, effectiveBudget, 'triage')
        break
      }

      const ids = pass.map((c) => c.id)
      const user = buildTriagePrompt({ candidates: pass, schemaFiles, repoLabel })
      const seed = [...pass.map((c) => `${c.file}:${c.excerpt}`), 'triage']

      // Sampling the union: variance was the largest term in the measurements,
      // and a site only has to be flagged once to reach authoring.
      //
      // Every sample runs. An earlier version stopped as soon as every id had
      // come back, which conflated two different jobs — completing the
      // accounting, and seeing what a second opinion flags. Accounting was
      // always complete after the first sample, so sampling never happened.
      const missing = new Set(ids)
      // How many samples actually returned a usable verdict for this pass.
      // The denominator of the agreement ratio has to be the number of samples
      // that *ran*, not the number requested: a pass where two of three calls
      // failed would otherwise report every site as 1/3-supported, which is a
      // statement about the network rather than about the site.
      let samplesCompleted = 0
      for (let sample = 0; sample < samples; sample++) {
        try {
          const { text } = await complete(TRIAGE_SYSTEM_PROMPT, user, [...seed, `sample:${sample}`], TRIAGE_SCHEMA)
          const parsed = parseTriage(text, ids)
          samplesCompleted++
          for (const id of flaggedIds(parsed)) {
            const v = parsed.verdicts.find((x) => x.id === id)!
            if (!flagged.has(id)) flagged.set(id, v)
            // The union decides what gets authored; the count decides how much
            // to trust it. Keeping only the union threw away a signal that was
            // already computed and free: a site three of three samples flagged
            // and a site one of three flagged reached authoring as identical
            // evidence.
            agreement.set(id, (agreement.get(id) ?? 0) + 1)
          }
          for (const v of parsed.verdicts) {
            missing.delete(v.id)
            // Recorded once per site. With sampling, the first verdict that
            // flags a site wins, and a site only ever seen as clean is logged
            // clean — which is exactly what you need to read when a real defect
            // was never written up.
            if (v.verdict === 'clean') {
              if (!flagged.has(v.id) && !triageLog.clean.includes(v.id)) triageLog.clean.push(v.id)
            } else {
              const into = v.verdict === 'unsure' ? triageLog.unsure : triageLog.flagged
              if (!into.some((x) => x.id === v.id)) {
                into.push({ id: v.id, category: v.category, why: v.why })
                // A site flagged on a later sample is no longer clean.
                triageLog.clean = triageLog.clean.filter((id) => id !== v.id)
              }
            }
          }
        } catch (e) {
          if (e instanceof LlmError && e.kind === 'cancelled') throw e
          if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'unavailable')) throw e
          truncatedReason = `Some triage passes failed: ${(e as Error).message}`
          break
        }
      }

      // A site nobody answered for is escalated to authoring, not assumed
      // clean. Assuming clean is precisely the silent skip being fixed.
      for (const id of missing) {
        unaccountedSites.push(id)
        if (!flagged.has(id)) {
          flagged.set(id, { id, verdict: 'unsure', category: 'other', why: 'triage returned no verdict for this site' })
        }
      }

      // Freeze the support ratio for every site in this pass, now that its
      // sample count is final. An escalated site records 0 of N: it was never
      // flagged by anyone, it is here because nobody answered, and recording it
      // as supported would be a lie in the direction that matters.
      for (const id of ids) {
        support.set(id, { flagged: agreement.get(id) ?? 0, samples: Math.max(1, samplesCompleted) })
      }

      sitesSent += pass.length
      report({
        chunksAnalysed: index + 1,
        tokensUsed: budgetSpent(),
        fraction: (index + 1) / triagePasses.length,
        message: `Triaged pass ${index + 1} of ${triagePasses.length} — ${flagged.size} site(s) flagged so far…`,
      })
    }

    /* 5c. Author ---------------------------------------------------------- */
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const toAuthor = [...flagged.entries()]
      .map(([id, verdict]) => ({ candidate: byId.get(id)!, verdict }))
      .filter((x) => x.candidate)
    const perAuthorRequest = Math.max(1, opts.authorSitesPerRequest ?? 1)
    const authorBatches: typeof toAuthor[] = []
    for (let i = 0; i < toAuthor.length; i += perAuthorRequest) {
      authorBatches.push(toAuthor.slice(i, i + perAuthorRequest))
    }

    if (authorBatches.length > 0) {
      report({
        chunksTotal: triagePasses.length + authorBatches.length,
        message: `${toAuthor.length} site(s) flagged; writing them up in ${authorBatches.length} request(s)…`,
      })
    }

    for (const [index, batch] of authorBatches.entries()) {
      throwIfAborted(opts.signal)
      if (budgetSpent() >= effectiveBudget) {
        truncatedReason =
          `Stopped at the ${effectiveBudget.toLocaleString()} token budget while writing findings. ` +
          `${authorBatches.length - index} of ${authorBatches.length} write-ups were not run, so ` +
          `${authorBatches.slice(index).flat().length} triaged site(s) have no finding.`
        break
      }

      const user = buildAuthorPrompt({ sites: batch, schemaFiles, repoLabel })
      const seed = [
        ...batch.map((b) => `${b.candidate.file}:${b.candidate.excerpt}`),
        ...schemaFiles.map((f) => f.content ?? ''),
        'author',
      ]

      try {
        const batchIds = batch.map((b) => b.candidate.id)
        const sites = batch.map((b) => ({
          id: b.candidate.id, file: b.candidate.file, startLine: b.candidate.startLine,
        }))
        const attempts = 1 + Math.max(0, opts.authorRetries ?? 1)
        let acc = {
          authored: [] as string[],
          declined: [] as { siteId: string; why: string }[],
          unaccounted: batchIds,
        }
        // Keyed by site so a retry cannot publish the same finding twice: the
        // second attempt re-answers sites the first already covered.
        const covered = new Set<string>()

        for (let attempt = 0; attempt < attempts; attempt++) {
          const { text } = await complete(AUTHOR_SYSTEM_PROMPT, user, [...seed, `attempt:${attempt}`], AUTHOR_SCHEMA)
          acc = reconcileAuthoring(text, batchIds, sites)

          const fresh = parseFindings(text).findings
          for (const [k, f] of fresh.entries()) {
            const id = acc.authored[k] ?? `${f.primaryOccurrence.file}:${f.primaryOccurrence.startLine}`
            if (covered.has(id)) continue
            covered.add(id)
            // Carry the triage agreement onto the finding. It is computed
            // whether or not anything reads it, and without it the report has
            // no way to distinguish a site every sample flagged from one a
            // single sample flagged and the others called clean.
            const s = support.get(id)
            raw.push(s ? { ...f, triageSupport: s } : f)
          }

          // A site that came back with neither a finding nor a decline is the
          // failure this stage kept committing. With one site per request it is
          // now retryable, which it never was inside a batch.
          if (acc.unaccounted.length === 0) break
        }

        authorLog.declined.push(...acc.declined)
        authorLog.unaccounted.push(...acc.unaccounted)
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'cancelled') throw e
        if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'unavailable')) throw e
        truncatedReason = `Some write-ups failed: ${(e as Error).message}`
      }

      report({
        chunksAnalysed: triagePasses.length + index + 1,
        tokensUsed: budgetSpent(),
        fraction: (triagePasses.length + index + 1) / (triagePasses.length + authorBatches.length),
        message: `Wrote up ${index + 1} of ${authorBatches.length} batch(es) — ${raw.length} finding(s) so far…`,
      })
    }
  } else {
    /* 5b. Single-shot ----------------------------------------------------- */
    for (const [index, chunk] of chunks.entries()) {
      throwIfAborted(opts.signal)

      if (budgetSpent() >= effectiveBudget) {
        truncatedReason = budgetNote(chunks, index, effectiveBudget, 'analysis')
        break
      }

      const user = buildUserPrompt({ candidates: chunk, schemaFiles, repoLabel })
      const seed = [
        ...chunk.map((c) => `${c.file}:${c.excerpt}`),
        ...schemaFiles.map((f) => f.content ?? ''),
      ]

      try {
        const { text } = await complete(SYSTEM_PROMPT, user, seed, SINGLE_SHOT_SCHEMA)
        sitesSent += chunk.length
        raw.push(...parseFindings(text).findings)
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'cancelled') throw e
        if (e instanceof LlmError && e.kind === 'context-length' && chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2)
          chunks.splice(index + 1, 0, chunk.slice(0, half), chunk.slice(half))
          continue
        }
        if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'unavailable')) throw e
        truncatedReason = `Some passes failed: ${(e as Error).message}`
      }

      report({
        chunksAnalysed: index + 1,
        tokensUsed: budgetSpent(),
        fraction: (index + 1) / chunks.length,
        message: `Analysed pass ${index + 1} of ${chunks.length}…`,
      })
    }
  }

  /* 6. Ground ------------------------------------------------------------- */
  // A cancel arriving during the last pass must not yield a report that looks
  // complete. The loop only checks on entry, so check once more on the way out.
  throwIfAborted(opts.signal)
  report({ phase: 'grounding', message: 'Verifying every citation against the source…' })
  const { kept, rejected } = groundFindings(raw, { files: contents, schema })

  /* 7. Gate --------------------------------------------------------------- */
  // Grounding proves the citations are real. It says nothing about whether the
  // finding is worth reading: a byte-identical no-op, a rewrite that issues
  // more queries than the original, a finding on code that touches no data
  // store, and an assumption the file itself contradicts all survive grounding
  // untouched. Suppressed findings are kept with their reason so the gate is
  // auditable — a gate that silently eats a true positive is worse than the
  // padding it removes.
  report({ phase: 'grounding', message: 'Checking every finding is worth publishing…' })
  const gate = applyValueGate(kept, { files: contents })

  const result = finish(gate.published, rejected, truncatedReason ?? truncatedScope, gate.suppressed)

  // Awaited, not fire-and-forget: an un-awaited write can land *after* a
  // subsequent clear and silently resurrect the entry.
  // Caching an empty or truncated result is deliberate — "we looked and found
  // nothing" is an answer worth not paying for twice. A cancelled scan throws
  // before reaching here, so a partial run is never cached.
  await writeCache(key, result)
  return result

  function finish(
    kept: Finding[],
    rejected: Finding[],
    reason?: string,
    suppressed: Finding[] = [],
  ): ScanReport {
    report({ phase: 'done', message: 'Done.', fraction: 1 })
    const result: ScanReport = {
      id: `${repo.commitSha.slice(0, 8)}-${Date.now().toString(36)}`,
      repo,
      createdAt: new Date().toISOString(),
      provider: opts.provider,
      model: opts.model,
      findings: sortFindings(kept),
      rejected,
      suppressed: sortFindings(suppressed),
      engineProfile,
      triageLog: triageLog.flagged.length + triageLog.unsure.length + triageLog.clean.length > 0
        ? { ...triageLog, unaccounted: unaccountedSites }
        : undefined,
      authorLog: authorLog.declined.length + authorLog.unaccounted.length > 0
        ? authorLog
        : undefined,
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
        sitesMatched,
        sitesSampled,
        sitesQueued: candidates.length,
        // What reached the model, not what was lined up for it.
        sitesAnalysed: sitesSent,
        sitesFiltered: { belowConfidence, lowPriority },
        truncatedFiles,
        sitesUnaccounted: unaccountedSites.length,
        triage: triageLog.flagged.length + triageLog.unsure.length + triageLog.clean.length > 0
          ? {
              flagged: triageLog.flagged.length,
              clean: triageLog.clean.length,
              unsure: triageLog.unsure.length,
            }
          : undefined,
        chunksAnalysed: progress.chunksAnalysed,
        promptTokens,
        completionTokens,
        chunksReused,
        elapsedMs: Date.now() - startedAt,
      },
      truncatedReason: reason === 'no-candidates' ? undefined : reason,
      // Surfaced in the report, not just in a progress line that scrolled past.
      ingestNote: archiveError
        ? `The single-archive request failed (${archiveError}), so this scan read ${fetched.length} files one request at a time. ` +
          'That consumes far more of the forge rate limit than a scan should; the finding quality is unaffected.'
        : undefined,
      scope: scopedTo
        ? opts.scopeLabel === 'changed-files'
          ? { kind: 'changed-files', files: scopedTo.size }
          : opts.pullRequest !== undefined
            ? { kind: 'pull-request', number: opts.pullRequest, files: scopedTo.size }
            : { kind: 'repository' }
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
  /** Optional hard cap on sites per pass, independent of the token fit. */
  maxPerChunk?: number,
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
    const full = maxPerChunk !== undefined && current.length >= maxPerChunk
    if (current.length > 0 && (full || currentTokens + cost > available)) {
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

/** Names what a budget cut-off actually left unexamined. */
function budgetNote(
  passes: Candidate[][],
  stoppedAt: number,
  budget: number,
  stage: string,
): string {
  const left = passes.slice(stoppedAt).flat()
  const files = [...new Set(left.map((c) => c.file))]
  return (
    `Stopped at the ${budget.toLocaleString()} token budget during ${stage}. ` +
    `${passes.length - stoppedAt} pass(es) were not run, leaving ${left.length} query site(s) ` +
    `in ${files.length} file(s) unexamined` +
    (files.length <= 8 ? `: ${files.join(', ')}.` : `, including ${files.slice(0, 8).join(', ')}.`)
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('Scan cancelled.', 'cancelled')
}

/** Total attempts (first try + retries) made for a single rate-limited call. */
const RATE_LIMIT_MAX_ATTEMPTS = 4
const RATE_LIMIT_BASE_MS = 1_000
const RATE_LIMIT_MAX_MS = 30_000

/**
 * Every provider adapter maps a 429 to `LlmError('rate-limit', retryAfterMs)`,
 * but until now nothing read `retryAfterMs` — a rate limit on request N just
 * meant request N+1 fired immediately after and got rate-limited again, so a
 * scan that hit one 429 typically failed every remaining request in that
 * stage. This is the one place all three analysis stages call the provider,
 * so retrying here fixes triage, authoring and single-shot at once.
 *
 * Honours the server's `Retry-After` when the provider supplied one; falls
 * back to exponential backoff with jitter otherwise. Any other error kind —
 * auth, context-length, refusal, cancelled — is not retryable and rethrows on
 * the first attempt, unchanged from before.
 */
async function completeWithRateLimitRetry(
  provider: LlmProvider,
  req: LlmRequest,
  onWait: (message: string) => void,
): Promise<LlmResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.complete(req)
    } catch (e) {
      if (!(e instanceof LlmError) || e.kind !== 'rate-limit') throw e
      if (attempt >= RATE_LIMIT_MAX_ATTEMPTS - 1) throw e

      const backoff = Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** attempt)
      const jittered = backoff * (0.85 + Math.random() * 0.3)
      const waitMs = e.retryAfterMs && e.retryAfterMs > 0 ? e.retryAfterMs : jittered

      onWait(
        `Rate limited by ${provider.id} — retrying in ${Math.ceil(waitMs / 1000)}s ` +
        `(attempt ${attempt + 2} of ${RATE_LIMIT_MAX_ATTEMPTS})…`,
      )
      await sleep(waitMs, req.signal)
    }
  }
}

/** Resolves after `ms`, or rejects immediately if the scan is cancelled. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('Scan cancelled.', 'cancelled'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new LlmError('Scan cancelled.', 'cancelled'))
      },
      { once: true },
    )
  })
}
