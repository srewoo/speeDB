import type { RepoFile, RepoRef } from '@/core/types'
import type { ParsedRepoUrl } from './parse-url'

export class RepoError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'auth' | 'not-found' | 'rate-limit' | 'too-large'
      | 'network' | 'timeout' | 'cancelled' | 'unknown',
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

/** What a token test reports back to Settings. */
export interface TokenCheck {
  ok: boolean
  /** Authenticated account, when the token resolves to one. */
  account?: string
  /** Remaining requests in the current window, when the forge reports it. */
  remaining?: number
  limit?: number
  message: string
}

/** Passed to every client call so a scan can be cancelled or time-bounded. */
export interface RequestCtx {
  signal?: AbortSignal
}

export interface ArchiveCtx extends RequestCtx {
  accept: (path: string, size: number) => boolean
  onProgress?: (bytes: number, files: number) => void
}

/** An archive can legitimately take minutes on a large repository. */
export const ARCHIVE_TIMEOUT_MS = 300_000

/** Result of a whole-repository archive fetch. */
export interface ArchiveResult {
  files: { path: string; size: number; content: string }[]
  /** Bytes downloaded, for progress and telemetry. */
  bytes: number
}

export interface RepoClient {
  /**
   * Paths changed by a pull/merge request. One request, not a whole tree walk.
   * Returns null when the forge cannot answer, so the caller can fall back to
   * a full scan rather than failing.
   */
  listChangedFiles(repo: RepoRef, pr: number, ctx?: RequestCtx): Promise<string[] | null>
  /**
   * Fetch the entire repository as one gzipped tarball.
   *
   * This is the difference between one request and one per file. A 2,000-file
   * repository costs 2,000 of GitHub's 5,000/hour budget the naive way, which
   * makes a repeat scan impossible; the archive endpoint costs one.
   *
   * Returns null when the forge cannot serve an archive, so the caller can
   * fall back to per-file reads rather than failing the scan.
   */
  fetchArchive(repo: RepoRef, ctx?: ArchiveCtx): Promise<ArchiveResult | null>
  /**
   * Validate credentials without starting a scan. Reports the authenticated
   * account and the rate-limit headroom, because "the token works" and "the
   * token has enough quota to finish a scan" are different questions.
   */
  validateToken(apiOrigin?: string): Promise<TokenCheck>
  /** Resolve the ref to a commit SHA. That SHA is the cache key for the scan. */
  resolve(parsed: ParsedRepoUrl, ref?: string, ctx?: RequestCtx): Promise<RepoRef>
  /** Full recursive file listing. Paths + sizes only, no content. */
  listFiles(repo: RepoRef, ctx?: RequestCtx): Promise<RepoFile[]>
  /** Fetch one file's text. */
  readFile(repo: RepoRef, path: string, ctx?: RequestCtx): Promise<string>
  listBranches(parsed: ParsedRepoUrl, ctx?: RequestCtx): Promise<string[]>
}

/** Files we never fetch: vendored, generated, or binary. Saves quota and tokens. */
const SKIP_DIRS = [
  'node_modules/', 'vendor/', 'dist/', 'build/', 'target/', '.git/',
  'venv/', '.venv/', 'site-packages/', '__pycache__/', 'coverage/',
  '.next/', '.nuxt/', 'bower_components/', 'third_party/', 'Pods/',
]
const SKIP_EXT = new Set([
  'png','jpg','jpeg','gif','svg','ico','webp','avif','mp4','mov','mp3','wav',
  'pdf','zip','gz','tar','bz2','7z','rar','woff','woff2','ttf','eot','otf',
  'so','dylib','dll','exe','bin','class','jar','wasm','pyc','o','a','lock',
  'map','min.js','snap',
])
/** Anything bigger than this is almost certainly generated. */
export const MAX_FILE_BYTES = 512 * 1024

/**
 * Reject an oversized response before reading its body.
 *
 * GitLab's tree endpoint does not report file sizes, so `isScannable` sees 0
 * for every entry and a multi-megabyte blob passes the pre-filter. Streaming
 * one into memory is slow enough to look like a hang, so the check moves to
 * response headers where the size is finally known.
 */
export function isOversized(res: Response): boolean {
  const len = Number(res.headers.get('content-length') ?? NaN)
  return Number.isFinite(len) && len > MAX_FILE_BYTES
}

export function isScannable(path: string, size: number): boolean {
  if (size > MAX_FILE_BYTES) return false
  const lower = path.toLowerCase()
  if (SKIP_DIRS.some((d) => lower.includes(d))) return false
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum|Cargo\.lock)$/.test(lower)) {
    return false
  }
  const ext = lower.split('.').pop() ?? ''
  return !SKIP_EXT.has(ext)
}

/**
 * 30s for a single file. Generous for a source file on any connection, and
 * short enough that a stalled request costs one file rather than the scan.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Listing a whole tree is legitimately slower than reading one file. */
export const LIST_TIMEOUT_MS = 90_000

/**
 * Shared fetch with backoff, a hard per-request timeout, and real cancellation.
 *
 * The timeout is not optional. Without one, a single stalled connection hangs
 * the whole scan: the batch that contains it never settles, the between-batch
 * cancellation check is never reached, and "Stop scan" does nothing because the
 * user's signal was never attached to the request. All three of those are fixed
 * here rather than at the call sites.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  attempts = 3,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const userSignal = init.signal
  let lastError: unknown

  for (let i = 0; i < attempts; i++) {
    if (userSignal?.aborted) throw new RepoError('Scan cancelled.', 'cancelled')

    // A fresh timeout per attempt, combined with the caller's signal so either
    // can abort the request. AbortSignal.any is available from Chrome 116.
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout

    let res: Response
    try {
      res = await fetch(url, { ...init, signal })
    } catch (e) {
      // Distinguish the two aborts: the user's is final, a timeout is retryable.
      if (userSignal?.aborted) throw new RepoError('Scan cancelled.', 'cancelled')

      if (timeout.aborted) {
        lastError = new Error(`Timed out after ${timeoutMs}ms`)
        if (i === attempts - 1) {
          throw new RepoError(`Request timed out: ${url}`, 'timeout')
        }
        await sleep(300 * 2 ** i)
        continue
      }

      lastError = e
      await sleep(400 * 2 ** i)
      continue
    }

    if (res.status === 429 || (res.status === 403 && hasRateLimitHeader(res))) {
      const wait = rateLimitWaitMs(res)
      // Don't sit and block for minutes — surface it and let the user decide.
      if (wait > 20_000 || i === attempts - 1) {
        throw new RepoError(
          'Rate limited by the forge. Add a personal access token in Settings to raise the limit.',
          'rate-limit',
          wait,
        )
      }
      await sleep(wait, userSignal)
      continue
    }

    if (res.status >= 500) {
      lastError = new Error(`Server error ${res.status}`)
      await sleep(400 * 2 ** i, userSignal)
      continue
    }

    return res
  }
  throw new RepoError(`Could not reach the forge: ${String(lastError)}`, 'network')
}

function hasRateLimitHeader(res: Response): boolean {
  // GitHub sends x-ratelimit-remaining; GitLab sends ratelimit-remaining.
  // Checking only the former silently misclassified GitLab throttling as a
  // plain 403.
  return (
    res.headers.get('x-ratelimit-remaining') === '0' ||
    res.headers.get('ratelimit-remaining') === '0'
  )
}

function rateLimitWaitMs(res: Response): number {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) return Number(retryAfter) * 1000
  const reset = res.headers.get('x-ratelimit-reset')
  if (reset) return Math.max(0, Number(reset) * 1000 - Date.now())
  return 60_000
}

/** Abortable sleep — a backoff must not outlive a cancelled scan. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RepoError('Scan cancelled.', 'cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new RepoError('Scan cancelled.', 'cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
