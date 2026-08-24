import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runScan } from '../pipeline'
import type { ArchiveResult, RepoClient } from '../repo/client'
import type { LlmProvider, LlmRequest } from '../providers'
import type { RepoRef } from '../types'
import { clearCache } from '../report/cache'

/* --------------------------------------------------------- test doubles -- */

const REPO: RepoRef = {
  forge: 'github', apiOrigin: 'https://api.github.com',
  owner: 'acme', name: 'svc', ref: 'main', commitSha: 'abc123def456',
}

const SOURCE = `
import asyncpg

async def get_all(conn, tenant_id):
    rows = await conn.fetch(
        "SELECT id, policy_uname, status FROM policy WHERE tenant_id=$1",
        tenant_id,
    )
    return rows
`.trim()

const SCHEMA = `CREATE TABLE "policy" ("id" int4, "tenant_id" int8 NOT NULL);
CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id);`

function fakeClient(over: Partial<RepoClient> & { archive?: ArchiveResult | null } = {}): RepoClient {
  const files = [
    { path: 'src/repo.py', size: SOURCE.length, content: SOURCE },
    { path: 'db/schema.sql', size: SCHEMA.length, content: SCHEMA },
    { path: 'README.md', size: 4, content: '# hi' },
  ]
  return {
    validateToken: async () => ({ ok: true, message: 'ok' }),
    resolve: async () => REPO,
    fetchArchive: async () => ('archive' in over ? over.archive! : { files, bytes: 1234 }),
    listFiles: async () => files.map((f) => ({ path: f.path, size: f.size })),
    readFile: async (_r, path) => files.find((f) => f.path === path)?.content ?? '',
    listBranches: async () => ['main'],
    listChangedFiles: async () => null,
    ...over,
  } as RepoClient
}

const GOOD_FINDING = {
  findings: [{
    kind: 'equivalent',
    title: 'Drop the redundant tenant_id_key index',
    summary: 'It duplicates the leading column of another index.',
    severity: 'medium',
    category: 'redundant-index',
    engine: 'postgres',
    accessStyle: 'ddl-migration',
    original: 'CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id)',
    primaryOccurrence: {
      file: 'db/schema.sql', startLine: 2, endLine: 2,
      excerpt: 'CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id);',
    },
    otherOccurrences: [],
    suggestion: {
      proposed: 'DROP INDEX IF EXISTS tenant_id_key',
      rationale: 'Redundant with the composite index.',
      equivalenceArgument:
        'Indexes never change which rows a query returns; the column list, ordering, NULL and duplicate handling are all untouched.',
      assumptions: [],
      expectedImpact: 'One less index to maintain per write.',
    },
    evidence: [{
      kind: 'index-definition', file: 'db/schema.sql', startLine: 2, endLine: 2,
      quote: 'CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id)',
      relevance: 'Shows the redundant index.',
    }],
    modelConfidence: 0.9,
  }],
}

function fakeProvider(
  respond: (req: LlmRequest, call: number) => string | Promise<string>,
): LlmProvider & { calls: number } {
  const p = {
    id: 'anthropic' as const,
    model: 'claude-sonnet-5',
    calls: 0,
    isAvailable: async () => ({ ok: true }),
    listModels: async () => [],
    async complete(req: LlmRequest) {
      p.calls++
      const text = await respond(req, p.calls)
      return { text, promptTokens: 1000, completionTokens: 250 }
    },
  }
  return p
}

const BASE = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5',
  apiKey: 'sk-ant-test',
  temperature: 0.1,
  maxOutputTokens: 4096,
  tokenBudget: 500_000,
}

/* Chrome storage stub — the pipeline reads and writes both caches. */
let store: Record<string, unknown> = {}
beforeEach(() => {
  store = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => { Object.assign(store, o) },
        remove: async (k: string) => { delete store[k] },
      },
    },
  }
})

const parsed = { forge: 'github' as const, apiOrigin: 'https://api.github.com', owner: 'acme', name: 'svc' }

/* ------------------------------------------------------------- the tests -- */

describe('runScan — ingest', () => {
  it('uses the archive endpoint and spends three API calls, not one per file', async () => {
    const client = fakeClient()
    const report = await runScan(parsed, {
      ...BASE,
      deps: { client, provider: fakeProvider(() => JSON.stringify(GOOD_FINDING)) },
    })
    expect(report.stats.ingest).toBe('archive')
    expect(report.stats.apiCalls).toBe(3)
    expect(report.stats.filesFetched).toBe(3)
  })

  it('falls back to per-file reads when the archive is unavailable', async () => {
    const readFile = vi.fn(async (_r: RepoRef, path: string) =>
      path === 'src/repo.py' ? SOURCE : path === 'db/schema.sql' ? SCHEMA : '# hi')
    const client = fakeClient({ archive: null, readFile })

    const report = await runScan(parsed, {
      ...BASE,
      deps: { client, provider: fakeProvider(() => JSON.stringify(GOOD_FINDING)) },
    })
    expect(report.stats.ingest).toBe('per-file')
    expect(readFile).toHaveBeenCalledTimes(3)
    expect(report.stats.apiCalls).toBe(6) // resolve(2) + list(1) + 3 files
  })

  it('counts a file that fails to read rather than hiding it', async () => {
    const client = fakeClient({
      archive: null,
      readFile: async (_r, path) => {
        if (path === 'README.md') throw new Error('LFS pointer')
        return path === 'src/repo.py' ? SOURCE : SCHEMA
      },
    })
    const report = await runScan(parsed, {
      ...BASE,
      deps: { client, provider: fakeProvider(() => JSON.stringify(GOOD_FINDING)) },
    })
    expect(report.stats.filesSkipped).toBe(1)
    expect(report.stats.filesFetched).toBe(2)
  })

  it('raises an error when nothing could be read, instead of reporting no findings', async () => {
    const client = fakeClient({
      archive: null,
      listFiles: async () => [{ path: 'a.py', size: 10 }],
      readFile: async () => { throw new Error('403') },
    })
    await expect(
      runScan(parsed, { ...BASE, deps: { client, provider: fakeProvider(() => '{}') } }),
    ).rejects.toThrow(/could be read/i)
  })
})

describe('runScan — a repository with no queries', () => {
  it('returns an empty report instead of throwing', async () => {
    // Regression: finish() reads counters and the schema catalog that were
    // declared *after* this early return, so every repository with zero query
    // sites died with "Cannot access 'X' before initialization".
    const noQueries = [
      { path: 'README.md', size: 20, content: '# next-step-service' },
      { path: 'src/util.ts', size: 60, content: 'export const add = (a: number, b: number) => a + b' },
      { path: 'src/handler.ts', size: 80, content: 'export function handle(req) { return items.find(i => i.id === req.id) }' },
    ]
    const client = fakeClient({ fetchArchive: async () => ({ files: noQueries, bytes: 400 }) })
    const provider = fakeProvider(() => { throw new Error('the model must not be called') })

    const report = await runScan(parsed, { ...BASE, deps: { client, provider } })

    expect(report.findings).toEqual([])
    expect(report.stats.candidatesFound).toBe(0)
    expect(report.stats.filesFetched).toBe(3)
    expect(provider.calls).toBe(0)
  })

  it('still reports what it looked at, so "nothing found" is distinguishable from "nothing scanned"', async () => {
    const client = fakeClient({
      fetchArchive: async () => ({
        files: [{ path: 'a.ts', size: 10, content: 'export const x = 1' }],
        bytes: 10,
      }),
    })
    const report = await runScan(parsed, {
      ...BASE, deps: { client, provider: fakeProvider(() => '{}') },
    })
    expect(report.stats.filesFetched).toBe(1)
    expect(report.stats.ingest).toBe('archive')
    expect(report.schema).toBeTruthy()
  })
})

describe('runScan — analysis and grounding', () => {
  it('produces a grounded finding end to end', async () => {
    const report = await runScan(parsed, {
      ...BASE,
      deps: { client: fakeClient(), provider: fakeProvider(() => JSON.stringify(GOOD_FINDING)) },
    })
    expect(report.findings).toHaveLength(1)
    const f = report.findings[0]!
    expect(f.grounding).toBe('verified')
    expect(f.equivalence?.status).toBe('machine-verified')
    expect(report.rejected).toHaveLength(0)
  })

  it('drops a finding that cites a file the scan never read', async () => {
    const fabricated = {
      findings: [{
        ...GOOD_FINDING.findings[0],
        primaryOccurrence: {
          ...GOOD_FINDING.findings[0]!.primaryOccurrence,
          file: 'db/invented.sql',
        },
      }],
    }
    const report = await runScan(parsed, {
      ...BASE,
      deps: { client: fakeClient(), provider: fakeProvider(() => JSON.stringify(fabricated)) },
    })
    expect(report.findings).toHaveLength(0)
    expect(report.rejected).toHaveLength(1)
    expect(report.rejected[0]!.groundingNotes.join(' ')).toMatch(/does not exist/)
  })

  it('survives a model returning unparseable text', async () => {
    const report = await runScan(parsed, {
      ...BASE,
      deps: { client: fakeClient(), provider: fakeProvider(() => 'I cannot help with that.') },
    })
    expect(report.findings).toHaveLength(0)
    expect(report.stats.filesFetched).toBe(3)
  })

  it('accounts for input and output tokens separately', async () => {
    const report = await runScan(parsed, {
      ...BASE,
      deps: { client: fakeClient(), provider: fakeProvider(() => JSON.stringify(GOOD_FINDING)) },
    })
    expect(report.stats.promptTokens).toBe(1000)
    expect(report.stats.completionTokens).toBe(250)
  })

  it('stops at the token budget and says how many passes did not run', async () => {
    // Many query sites so the chunker produces several passes; the budget is
    // only meaningful when there is a later pass to skip.
    const many = Array.from({ length: 30 }, (_, i) => ({
      path: `src/q${i}.py`,
      size: 200,
      content: `rows = await conn.fetch("SELECT c${i} FROM t${i} WHERE tenant_id=$1", t)`,
    }))
    const client = fakeClient({ fetchArchive: async () => ({ files: many, bytes: 1 }) })
    const provider = fakeProvider(() => JSON.stringify({ findings: [] }))

    const report = await runScan(parsed, {
      ...BASE,
      maxOutputTokens: 198_000, // squeezes the per-chunk budget, forcing several passes
      tokenBudget: 1,           // exhausted after the first
      deps: { client, provider },
    })

    expect(report.stats.chunksAnalysed).toBeGreaterThan(0)
    expect(provider.calls).toBe(1)
    expect(report.truncatedReason ?? '').toMatch(/token budget/)
  })

  it('propagates a cancellation instead of returning a partial report', async () => {
    // Cancelling during the final pass must not yield a report that looks
    // complete — the loop only checks on entry.
    const controller = new AbortController()
    const provider = fakeProvider(() => { controller.abort(); return JSON.stringify(GOOD_FINDING) })
    await expect(
      runScan(parsed, { ...BASE, signal: controller.signal, deps: { client: fakeClient(), provider } }),
    ).rejects.toMatchObject({ kind: 'cancelled' })
  })
})

describe('runScan — caching', () => {
  it('serves a repeat scan of the same commit from cache without calling the model', async () => {
    const provider = fakeProvider(() => JSON.stringify(GOOD_FINDING))
    const client = fakeClient()

    await runScan(parsed, { ...BASE, deps: { client, provider } })
    expect(provider.calls).toBe(1)

    const second = await runScan(parsed, { ...BASE, deps: { client, provider } })
    expect(provider.calls).toBe(1) // unchanged — served from cache
    expect(second.cache).toBeTruthy()
  })

  it('honours noCache by re-running the analysis', async () => {
    const provider = fakeProvider(() => JSON.stringify(GOOD_FINDING))
    const client = fakeClient()

    await runScan(parsed, { ...BASE, deps: { client, provider } })
    await runScan(parsed, { ...BASE, noCache: true, deps: { client, provider } })
    expect(provider.calls).toBe(2)
  })

  it('reuses unchanged chunks when the commit changes but the source does not', async () => {
    const provider = fakeProvider(() => JSON.stringify(GOOD_FINDING))

    await runScan(parsed, { ...BASE, deps: { client: fakeClient(), provider } })
    expect(provider.calls).toBe(1)

    // A new commit misses the scan cache, but the analysed content is identical
    // so the chunk cache still hits — that is the one-file-commit case.
    const movedOn = fakeClient({ resolve: async () => ({ ...REPO, commitSha: 'newsha999' }) })
    const second = await runScan(parsed, { ...BASE, deps: { client: movedOn, provider } })

    expect(second.cache).toBeUndefined()          // genuinely a fresh scan
    expect(provider.calls).toBe(1)                // but no new model call
    expect(second.stats.chunksReused).toBe(1)
    expect(second.findings).toHaveLength(1)
  })

  it('starts clean after the cache is cleared', async () => {
    const provider = fakeProvider(() => JSON.stringify(GOOD_FINDING))
    await runScan(parsed, { ...BASE, deps: { client: fakeClient(), provider } })
    await clearCache()
    await runScan(parsed, { ...BASE, deps: { client: fakeClient(), provider } })
    expect(provider.calls).toBe(2)
  })
})
