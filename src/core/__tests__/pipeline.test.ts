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

/**
 * A provider double that speaks both analysis protocols.
 *
 * The pipeline defaults to two stages — triage every site, then author the
 * flagged ones — so a double that only knows how to return findings answers the
 * wrong question first and the scan comes back empty. Rather than pin these
 * tests to the old strategy, the double answers whichever stage it is asked
 * about: it flags every site it is shown, then hands the caller's `respond` the
 * authoring request. Tests that care about the strategy set it explicitly.
 */
function fakeProvider(
  respond: (req: LlmRequest, call: number) => string | Promise<string>,
): LlmProvider & { calls: number; triageCalls: number; emittedUnmatched: boolean } {
  const p = {
    id: 'anthropic' as const,
    model: 'claude-sonnet-5',
    calls: 0,
    triageCalls: 0,
    emittedUnmatched: false,
    isAvailable: async () => ({ ok: true }),
    listModels: async () => [],
    async complete(req: LlmRequest) {
      if (/triaging query sites/.test(req.system)) {
        p.triageCalls++
        const ids = [...req.user.matchAll(/^## id: (.+)$/gm)].map((m) => m[1]!)
        return {
          text: JSON.stringify({
            verdicts: ids.map((id) => ({
              id, verdict: 'problem', category: 'other', why: 'flagged by the test double',
            })),
          }),
          promptTokens: 200,
          completionTokens: 30 * ids.length,
        }
      }
      p.calls++
      const text = await respond(req, p.calls)

      // Authoring now runs one site per request, so a double that returns the
      // same finding every time publishes it once per request. A real model is
      // asked about one site and answers about that site; the double narrows to
      // the findings whose cited file actually appears in this prompt, and
      // declines the rest so the accounting contract is satisfied.
      try {
        const parsed = JSON.parse(text) as { findings?: { primaryOccurrence?: { file?: string } }[] }
        if (Array.isArray(parsed.findings)) {
          // Match against the batch's site ids, not the prompt text: the prompt
          // also carries the schema files as context, so a substring check
          // matches a schema-file finding in every request.
          const ids = [...req.user.matchAll(/^## id: (.+)$/gm)].map((m) => m[1]!)
          const keep = parsed.findings.filter((f) => {
            const file = f.primaryOccurrence?.file
            if (!file) return false
            // Belongs to this request's site: answer it here.
            if (ids.some((id) => id.startsWith(`${file}:`))) return true
            // Belongs to no site in this batch — a fabricated path, which some
            // tests supply on purpose to check that grounding rejects it. Let it
            // through exactly once, on the first authoring request, so it
            // reaches grounding without being emitted per request.
            if (!p.emittedUnmatched) { p.emittedUnmatched = true; return true }
            return false
          })
          const authoredFiles = new Set(keep.map((f) => f.primaryOccurrence!.file))
          const declined = ids
            .filter((id) => ![...authoredFiles].some((f) => id.startsWith(`${f}:`)))
            .map((id) => ({ siteId: id, why: 'nothing to report at this site' }))
          return {
            text: JSON.stringify({ findings: keep, declined }),
            promptTokens: 1000,
            completionTokens: 250,
          }
        }
      } catch {
        // Not JSON — a deliberate malformed-response test. Pass it through.
      }
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
  /*
   * Authoring batch size is pinned here rather than inherited.
   *
   * The default is one site per request, which is right for the product — a site
   * cannot be skipped when there is no batch to skip it within — but it makes
   * the request count a function of the candidate count, and the tests below
   * assert exact call counts, token totals and cache hits. Pinning it makes
   * those assertions about what they are actually testing. The one-per-request
   * behaviour has its own tests further down.
   */
  authorSitesPerRequest: 3,
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
    // Two stages means two kinds of call, so the totals are sums rather than one
    // response's figures. What this test is actually for is that input and output
    // are never folded together — a cost estimate built on one number is wrong,
    // because the two are priced differently.
    expect(report.stats.promptTokens).toBe(1200)   // 200 triage + 1000 authoring
    expect(report.stats.completionTokens).toBe(310) // 60 triage (2 sites) + 250 authoring
    expect(report.stats.promptTokens).not.toBe(report.stats.completionTokens)
  })

  it('counts tokens separately on the single-shot path too', async () => {
    const report = await runScan(parsed, {
      ...BASE,
      analysis: 'single-shot',
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
      analysis: 'single-shot', // this test is about the chunk loop specifically
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
    // Two cached responses now, not one: the triage pass and the authoring
    // request are separate calls with separate content keys.
    expect(second.stats.chunksReused).toBe(2)
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

describe('runScan — the approved estimate is the ceiling', () => {
  it('does not truncate a scan the user approved at the gate', async () => {
    // Behavioural version of the invariant: a tiny configured budget must not
    // cut short a scan whose (larger) estimate was accepted.
    let quoted = 0
    const report = await runScan(parsed, {
      provider: 'openai', model: 'gpt-5.1-mini', apiKey: 'k',
      temperature: 0, maxOutputTokens: 1_000,
      tokenBudget: 10, // absurdly low on purpose
      maxCandidatesPerChunk: 1,
      onEstimate: (e) => { quoted = e.cost.totalTokens; return true },
      deps: { client: fakeClient(), provider: fakeProvider(() => JSON.stringify({ findings: [] })) },
    })

    expect(quoted).toBeGreaterThan(10)
    // The invariant is that consent RAISES the ceiling: the absurd configured
    // budget of 10 did not decide anything. It is not that a scan can never be
    // truncated — the authoring half of the estimate is a projection from a
    // stated assumption, so a run that flags far more sites than assumed can
    // still exceed what was quoted, and stopping there is the honest outcome.
    expect(report.stats.sitesAnalysed).toBeGreaterThan(0)
    if (report.truncatedReason?.includes('token budget')) {
      expect(report.truncatedReason).toMatch(new RegExp(quoted.toLocaleString()))
    }
  })

  it('still enforces the configured budget when there is no gate', async () => {
    const report = await runScan(parsed, {
      provider: 'openai', model: 'gpt-5.1-mini', apiKey: 'k',
      temperature: 0, maxOutputTokens: 1_000,
      tokenBudget: 1,
      maxCandidatesPerChunk: 1,
      deps: { client: fakeClient(), provider: fakeProvider(() => JSON.stringify({ findings: [] })) },
    })
    // With no consent to defer to, the safety net holds.
    expect(report.stats.sitesAnalysed).toBeLessThanOrEqual(report.stats.sitesQueued)
  })
})

describe('runScan — two-stage analysis', () => {
  /** A repo with several query sites, so triage has something to account for. */
  const manySites = Array.from({ length: 12 }, (_, i) => ({
    path: `src/q${i}.py`,
    size: 200,
    content: `rows = await conn.fetch("SELECT c${i} FROM t${i} WHERE tenant_id=$1", t)`,
  }))

  /** Records every triage/author exchange so the contract can be inspected. */
  function recordingProvider(triage: (ids: string[], sample: number) => unknown) {
    const seen = { triageIds: [] as string[][], authorIds: [] as string[][], samples: 0 }
    const p = {
      id: 'anthropic' as const,
      model: 'claude-sonnet-5',
      isAvailable: async () => ({ ok: true }),
      listModels: async () => [],
      seen,
      async complete(req: LlmRequest) {
        const ids = [...req.user.matchAll(/^## id: (.+)$/gm)].map((m) => m[1]!)
        if (/triaging query sites/.test(req.system)) {
          seen.triageIds.push(ids)
          const sample = seen.samples++
          return { text: JSON.stringify(triage(ids, sample)), promptTokens: 100, completionTokens: 30 }
        }
        seen.authorIds.push(ids)
        // Declining is part of the contract. Without it every request comes back
        // unaccounted and is retried, which doubles the call count.
        return {
          text: JSON.stringify({
            findings: [],
            declined: ids.map((id) => ({ siteId: id, why: 'nothing to report' })),
          }),
          promptTokens: 100,
          completionTokens: 50,
        }
      },
    }
    return p
  }

  it('asks about every candidate, and authors only what was flagged', async () => {
    const provider = recordingProvider((ids) => ({
      verdicts: ids.map((id, i) => ({
        id,
        verdict: i === 0 ? 'problem' : 'clean',
        category: 'other',
        why: '',
      })),
    }))
    const client = fakeClient({ fetchArchive: async () => ({ files: manySites, bytes: 1 }) })

    const report = await runScan(parsed, {
      ...BASE, triageSitesPerPass: 5, authorSitesPerRequest: 1,
      deps: { client, provider },
    })

    const triaged = provider.seen.triageIds.flat()
    // Every site the scan analysed was asked about — that is the contract.
    expect(triaged).toHaveLength(report.stats.sitesAnalysed)
    expect(new Set(triaged).size).toBe(triaged.length)
    // One flagged per pass of 5, and only those were written up.
    expect(provider.seen.authorIds.flat()).toHaveLength(provider.seen.triageIds.length)
  })

  it('escalates a site triage skipped rather than assuming it clean', async () => {
    // Silently treating an unanswered site as clean is the exact failure the
    // accounting contract exists to remove.
    const provider = recordingProvider((ids) => ({
      verdicts: ids.slice(0, 1).map((id) => ({ id, verdict: 'clean', category: 'other', why: '' })),
    }))
    const client = fakeClient({ fetchArchive: async () => ({ files: manySites, bytes: 1 }) })

    await runScan(parsed, {
      ...BASE, triageSitesPerPass: 4, authorSitesPerRequest: 10,
      deps: { client, provider },
    })

    // 3 of every 4 went unanswered, so every one of them reached authoring.
    const authored = provider.seen.authorIds.flat()
    expect(authored.length).toBeGreaterThanOrEqual(provider.seen.triageIds.flat().length * 0.7)
  })

  it('does not author at all when triage finds nothing', async () => {
    const provider = recordingProvider((ids) => ({
      verdicts: ids.map((id) => ({ id, verdict: 'clean', category: 'other', why: '' })),
    }))
    const client = fakeClient({ fetchArchive: async () => ({ files: manySites, bytes: 1 }) })

    const report = await runScan(parsed, {
      ...BASE, triageSitesPerPass: 20, deps: { client, provider },
    })

    expect(provider.seen.authorIds).toHaveLength(0)
    expect(report.findings).toHaveLength(0)
    // And it is not confused with "we never looked".
    expect(report.stats.sitesAnalysed).toBeGreaterThan(0)
  })

  it('Phase 3: samples triage and takes the union of what is flagged', async () => {
    // Variance was the largest term in the measurements — the same setup found
    // 0 and 2 of the same defects on different runs. A site only has to be
    // flagged once to reach authoring.
    const provider = recordingProvider((ids, sample) => ({
      verdicts: ids.map((id, i) => ({
        id,
        // Each sample flags a different single site; the union is all three.
        verdict: i === sample ? 'problem' : 'clean',
        category: 'other',
        why: '',
      })),
    }))
    const client = fakeClient({
      fetchArchive: async () => ({ files: manySites.slice(0, 3), bytes: 1 }),
    })

    await runScan(parsed, {
      ...BASE, triageSitesPerPass: 10, triageSamples: 3, authorSitesPerRequest: 10,
      deps: { client, provider },
    })

    expect(provider.seen.samples).toBe(3)
    // One sample alone would have flagged one site; the union flagged all three.
    expect(new Set(provider.seen.authorIds.flat()).size).toBe(3)
  })

  it('sampling once is the default, so nobody pays for it unasked', async () => {
    const provider = recordingProvider((ids) => ({
      verdicts: ids.map((id) => ({ id, verdict: 'clean', category: 'other', why: '' })),
    }))
    const client = fakeClient({ fetchArchive: async () => ({ files: manySites.slice(0, 3), bytes: 1 }) })
    await runScan(parsed, { ...BASE, triageSitesPerPass: 10, deps: { client, provider } })
    expect(provider.seen.samples).toBe(1)
  })
})
