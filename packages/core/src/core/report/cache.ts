import type { ScanReport } from '@/core/types'
import { storage } from '@/core/storage'

/**
 * Scan cache.
 *
 * Backed by the `session` storage area rather than cookies: a cookie is capped at
 * ~4KB, is sent to a server on every matching request, and is readable by the
 * page it belongs to. A scan report is none of those things. Session storage
 * gives the property that actually matters — memory-backed, gone when the
 * browser closes, never written to disk — plus room for real reports.
 *
 * On top of that lifetime we apply our own 60-minute TTL, because "the browser
 * is still open" is not a good reason to keep showing an hour-old analysis of a
 * branch that has probably moved on.
 */

export const CACHE_TTL_MS = 60 * 60 * 1000

/** Bounded so a long session of scanning cannot exhaust the storage quota. */
const MAX_ENTRIES = 6

const KEY = 'speedb.scanCache'

interface CacheEntry {
  key: string
  storedAt: number
  report: ScanReport
}

/**
 * Identity of a scan result.
 *
 * The commit SHA is in the key, so a new commit is a natural miss and there is
 * never a stale-branch problem. Provider and model are in it too: the same
 * commit analysed by a different model is a different result, and serving one
 * for the other would be misleading.
 *
 * `PROMPT_VERSION` and the analysis config are in it for the same reason, and
 * their absence was a real defect rather than a missing nicety. The key used to
 * be `sha:provider:model:scope`, so editing a prompt — the single most common
 * change made to this product — left every cached scan of that commit serving
 * results from the *previous* prompt for the next hour. Every measurement taken
 * inside that window silently compared a new prompt against old output. The
 * chunk cache already carried `PROMPT_VERSION`; the scan cache, which sits in
 * front of it and short-circuits the whole pipeline, did not.
 *
 * The same argument applies to `sitesPerPass`, `triageSamples`, the confidence
 * floor and temperature: each changes the analysis, so each must change the
 * identity of its result. They are folded into one short fingerprint rather
 * than concatenated, so adding a knob later does not keep lengthening the key.
 */
export function cacheKey(input: {
  commitSha: string
  provider: string
  model: string
  /** A pull-request-scoped scan is a different result from a whole-repo one. */
  scope?: string
  /** Everything about *how* the analysis was run. See `analysisFingerprint`. */
  config?: AnalysisConfig
}): string {
  const cfg = analysisFingerprint(input.config)
  return [
    `v${PROMPT_VERSION}`,
    input.commitSha,
    input.provider,
    input.model,
    input.scope ?? 'repo',
    cfg,
  ].join(':')
}

/**
 * The knobs that change what an analysis produces.
 *
 * Deliberately not `Settings`: theme and `maxOutputTokens` do not change the
 * findings, and including them would evict a cache on a colour change.
 */
export interface AnalysisConfig {
  sitesPerPass?: number
  triageSamples?: number
  /** The priority floor applied before analysis. */
  minPriority?: number
  /** Two-stage triage/authoring versus the single-shot path. */
  mode?: string
}

/**
 * A short, stable fingerprint of the analysis config.
 *
 * Sorted by key so property order cannot produce two fingerprints for one
 * config, and hashed so the key length is fixed however many knobs exist.
 * Undefined values are dropped rather than stringified, so a caller that omits
 * a knob and one that passes its default agree — the default is resolved
 * before this is called.
 */
export function analysisFingerprint(config?: AnalysisConfig): string {
  if (!config) return 'default'
  const entries = Object.entries(config)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
  return entries.length === 0 ? 'default' : hashChunk(entries)
}

async function readAll(): Promise<CacheEntry[]> {
  try {
    const got = await storage().session.get(KEY)
    const entries = got[KEY]
    return Array.isArray(entries) ? (entries as CacheEntry[]) : []
  } catch {
    return []
  }
}

export interface CacheHit {
  report: ScanReport
  storedAt: number
  /** Milliseconds until this entry expires. */
  expiresInMs: number
}

export async function readCache(key: string): Promise<CacheHit | null> {
  const now = Date.now()
  const entries = await readAll()
  const hit = entries.find((e) => e.key === key)
  if (!hit) return null

  const age = now - hit.storedAt
  if (age >= CACHE_TTL_MS) {
    // Expired. Drop it now rather than leaving it to occupy the quota.
    await writeAll(entries.filter((e) => e.key !== key))
    return null
  }

  return { report: hit.report, storedAt: hit.storedAt, expiresInMs: CACHE_TTL_MS - age }
}

export async function writeCache(key: string, report: ScanReport): Promise<void> {
  const now = Date.now()
  const entries = (await readAll()).filter(
    (e) => e.key !== key && now - e.storedAt < CACHE_TTL_MS,
  )

  // Newest first, then trim — an eviction should drop the oldest entry.
  const next = [{ key, storedAt: now, report }, ...entries].slice(0, MAX_ENTRIES)

  try {
    await writeAll(next)
  } catch {
    // Over quota. Fall back to keeping only this report; if even that fails,
    // caching is skipped. A cache write must never fail a scan.
    try {
      await writeAll([{ key, storedAt: now, report }])
    } catch {
      /* give up silently */
    }
  }
}

async function writeAll(entries: CacheEntry[]): Promise<void> {
  await storage().session.set({ [KEY]: entries })
}

export async function clearCache(): Promise<void> {
  try {
    await storage().session.remove(KEY)
  } catch {
    /* nothing to clear */
  }
  await clearChunkCache()
}

/** Live, non-expired entries. Used by Settings to report what is held. */
export async function cacheSummary(): Promise<{ count: number; oldestAgeMs: number | null }> {
  const now = Date.now()
  const live = (await readAll()).filter((e) => now - e.storedAt < CACHE_TTL_MS)
  if (live.length === 0) return { count: 0, oldestAgeMs: null }
  return { count: live.length, oldestAgeMs: now - Math.min(...live.map((e) => e.storedAt)) }
}


/* ------------------------------------------------------- chunk-level cache -- */

/**
 * Analysis results cached per chunk of source, not per commit.
 *
 * The scan cache is keyed on the commit SHA, so a one-line commit throws away
 * an entire prior analysis. This second layer is keyed on the *content* of
 * what was analysed, so a new commit re-analyses only the chunks that actually
 * changed and reuses the rest.
 */

const CHUNK_KEY = 'speedb.chunkCache'

/**
 * Bumped whenever anything that changes a finding changes.
 *
 * Not only the prompt text, despite the name it was given: enforced response
 * schemas, sampled triage, the support-derived severity cap and the
 * claim-specific verification recipes all change what a scan produces from the
 * same commit. Now also part of `cacheKey`, which it was not — see there.
 *
 * 3: structured output enforced on every adapter, triage sampled by default,
 *    triage agreement carried onto findings, per-category recipes.
 */
export const PROMPT_VERSION = 3

/** Chunks are small; more of them fit, and each is cheaper to lose. */
const MAX_CHUNK_ENTRIES = 400

interface ChunkEntry {
  key: string
  storedAt: number
  /** Raw model text. Parsing and grounding always re-run against fresh source. */
  text: string
  promptTokens: number
  completionTokens: number
}

/**
 * FNV-1a over the chunk's source. A hash, not a cryptographic digest — the
 * only requirement is that different content produces a different key.
 */
export function hashChunk(parts: string[]): string {
  let h = 0x811c9dc5
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    h ^= 0x5f
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

export function chunkKey(input: { hash: string; provider: string; model: string }): string {
  return `${PROMPT_VERSION}:${input.provider}:${input.model}:${input.hash}`
}

async function readChunks(): Promise<ChunkEntry[]> {
  try {
    const got = await storage().session.get(CHUNK_KEY)
    return Array.isArray(got[CHUNK_KEY]) ? (got[CHUNK_KEY] as ChunkEntry[]) : []
  } catch {
    return []
  }
}

export async function readChunkCache(key: string): Promise<ChunkEntry | null> {
  const now = Date.now()
  const hit = (await readChunks()).find((e) => e.key === key)
  if (!hit) return null
  return now - hit.storedAt < CACHE_TTL_MS ? hit : null
}

export async function writeChunkCache(
  key: string,
  value: { text: string; promptTokens: number; completionTokens: number },
): Promise<void> {
  const now = Date.now()
  const entries = (await readChunks()).filter(
    (e) => e.key !== key && now - e.storedAt < CACHE_TTL_MS,
  )
  const next = [{ key, storedAt: now, ...value }, ...entries].slice(0, MAX_CHUNK_ENTRIES)
  try {
    await storage().session.set({ [CHUNK_KEY]: next })
  } catch {
    // Over quota. A missed cache write costs tokens on the next scan; it must
    // never cost the current one.
  }
}

export async function clearChunkCache(): Promise<void> {
  try {
    await storage().session.remove(CHUNK_KEY)
  } catch {
    /* nothing to clear */
  }
}
