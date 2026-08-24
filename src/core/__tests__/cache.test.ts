import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_TTL_MS, cacheKey, cacheSummary, clearCache, readCache, writeCache,
} from '../report/cache'
import type { ScanReport } from '../types'

/** Minimal in-memory stand-in for chrome.storage.session. */
let store: Record<string, unknown> = {}
let failNextWrite = false

beforeEach(() => {
  store = {}
  failNextWrite = false
  vi.useRealTimers()
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (obj: Record<string, unknown>) => {
          if (failNextWrite) { failNextWrite = false; throw new Error('QUOTA_BYTES exceeded') }
          Object.assign(store, obj)
        },
        remove: async (k: string) => { delete store[k] },
      },
    },
  }
})

function report(id: string): ScanReport {
  return {
    id,
    repo: { forge: 'github', apiOrigin: '', owner: 'o', name: 'r', ref: 'main', commitSha: id },
    createdAt: new Date().toISOString(),
    provider: 'anthropic', model: 'claude-sonnet-5',
    findings: [], rejected: [],
    stats: {
      filesInTree: 1, filesFetched: 1, filesSkipped: 0, ingest: 'archive', apiCalls: 3, candidatesFound: 0,
      chunksAnalysed: 0, chunksReused: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 1,
    },
  }
}

describe('cacheKey', () => {
  it('separates results by commit, provider and model', () => {
    const base = { commitSha: 'abc', provider: 'anthropic', model: 'claude-sonnet-5' }
    expect(cacheKey(base)).toBe(cacheKey({ ...base }))
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, commitSha: 'def' }))
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, model: 'claude-opus-5' }))
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, provider: 'openai' }))
  })
})

describe('scan cache', () => {
  it('returns null on a miss', async () => {
    expect(await readCache('nope')).toBeNull()
  })

  it('round-trips a report', async () => {
    await writeCache('k1', report('abc'))
    const hit = await readCache('k1')
    expect(hit?.report.id).toBe('abc')
    expect(hit?.expiresInMs).toBeGreaterThan(CACHE_TTL_MS - 5_000)
  })

  it('expires an entry after the TTL and evicts it', async () => {
    await writeCache('k1', report('abc'))
    // Age the stored entry past the TTL.
    const entries = store['speedb.scanCache'] as { storedAt: number }[]
    entries[0]!.storedAt = Date.now() - CACHE_TTL_MS - 1
    expect(await readCache('k1')).toBeNull()
    // The expired entry should have been dropped, not merely ignored.
    expect((store['speedb.scanCache'] as unknown[]).length).toBe(0)
  })

  it('keeps an entry that is just inside the TTL', async () => {
    await writeCache('k1', report('abc'))
    const entries = store['speedb.scanCache'] as { storedAt: number }[]
    entries[0]!.storedAt = Date.now() - CACHE_TTL_MS + 30_000
    const hit = await readCache('k1')
    expect(hit).not.toBeNull()
    expect(hit!.expiresInMs).toBeLessThanOrEqual(30_000)
  })

  it('evicts the oldest entry beyond the cap', async () => {
    for (let i = 0; i < 8; i++) await writeCache(`k${i}`, report(`c${i}`))
    const entries = store['speedb.scanCache'] as { key: string }[]
    expect(entries.length).toBe(6)
    // k0 and k1 were the first written, so they should be gone.
    expect(entries.map((e) => e.key)).not.toContain('k0')
    expect(entries.map((e) => e.key)).toContain('k7')
  })

  it('overwrites rather than duplicating the same key', async () => {
    await writeCache('k1', report('first'))
    await writeCache('k1', report('second'))
    expect((store['speedb.scanCache'] as unknown[]).length).toBe(1)
    expect((await readCache('k1'))?.report.id).toBe('second')
  })

  it('never throws when storage rejects the write', async () => {
    failNextWrite = true
    await expect(writeCache('k1', report('abc'))).resolves.toBeUndefined()
  })

  it('reports only live entries in the summary', async () => {
    await writeCache('k1', report('a'))
    await writeCache('k2', report('b'))
    const entries = store['speedb.scanCache'] as { storedAt: number }[]
    entries[1]!.storedAt = Date.now() - CACHE_TTL_MS - 1
    expect((await cacheSummary()).count).toBe(1)
  })

  it('clears everything', async () => {
    await writeCache('k1', report('a'))
    await clearCache()
    expect(await readCache('k1')).toBeNull()
    expect((await cacheSummary()).count).toBe(0)
  })
})
