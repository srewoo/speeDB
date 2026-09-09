import { beforeEach, describe, expect, it } from 'vitest'
import { runScan } from '../pipeline'
import { detectedFromUrl } from '../repo/detect-tab'
import { toPatchFile, toUnifiedDiff } from '../report/patch'
import { estimateCost, formatUsd, priceFor } from '@/config/pricing'
import type { RepoClient } from '../repo/client'
import type { LlmProvider, LlmRequest } from '../providers'
import type { Finding, RepoRef, ScanReport } from '../types'

/* ------------------------------------------------------------- PR scope -- */

describe('pull request detection', () => {
  it('reads a GitHub PR number, including from a sub-tab', () => {
    expect(detectedFromUrl('https://github.com/acme/svc/pull/412')?.pullRequest).toBe(412)
    expect(detectedFromUrl('https://github.com/acme/svc/pull/412/files')?.pullRequest).toBe(412)
  })

  it('reads a GitLab MR number through a subgroup path', () => {
    expect(
      detectedFromUrl('https://gitlab.com/g/sub/proj/-/merge_requests/45/diffs')?.pullRequest,
    ).toBe(45)
  })

  it('leaves pullRequest unset on an ordinary repo page', () => {
    expect(detectedFromUrl('https://github.com/acme/svc')?.pullRequest).toBeUndefined()
    expect(detectedFromUrl('https://github.com/acme/svc/tree/main')?.pullRequest).toBeUndefined()
  })
})

const REPO: RepoRef = {
  forge: 'github', apiOrigin: 'https://api.github.com',
  owner: 'acme', name: 'svc', ref: 'main', commitSha: 'sha1234567',
}

const FILES = [
  { path: 'src/changed.py', size: 90, content: `rows = await conn.fetch("SELECT a FROM t WHERE id=$1", i)` },
  { path: 'src/untouched.py', size: 90, content: `rows = await conn.fetch("SELECT b FROM u WHERE id=$1", i)` },
]

function client(changed: string[] | null): RepoClient {
  return {
    validateToken: async () => ({ ok: true, message: '' }),
    resolve: async () => REPO,
    fetchArchive: async () => ({ files: FILES, bytes: 1 }),
    listFiles: async () => FILES.map((f) => ({ path: f.path, size: f.size })),
    readFile: async (_r, p) => FILES.find((f) => f.path === p)?.content ?? '',
    listBranches: async () => ['main'],
    listChangedFiles: async () => changed,
  } as RepoClient
}

function provider(capture: { prompts: string[] }): LlmProvider {
  return {
    id: 'anthropic', model: 'claude-sonnet-5',
    isAvailable: async () => ({ ok: true }),
    listModels: async () => [],
    async complete(req: LlmRequest) {
      capture.prompts.push(req.user)
      return { text: '{"findings":[]}', promptTokens: 10, completionTokens: 5 }
    },
  }
}

const BASE = {
  provider: 'anthropic' as const, model: 'claude-sonnet-5', apiKey: 'sk-ant-x',
  temperature: 0.1, maxOutputTokens: 4096, tokenBudget: 100_000,
}
const parsed = { forge: 'github' as const, apiOrigin: 'https://api.github.com', owner: 'acme', name: 'svc' }

let store: Record<string, unknown> = {}
beforeEach(() => {
  store = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o) },
      remove: async (k: string) => { delete store[k] },
    } },
  }
})

describe('runScan — diff scope', () => {
  it('analyses only the files the PR touches', async () => {
    const capture = { prompts: [] as string[] }
    const report = await runScan(parsed, {
      ...BASE, pullRequest: 7,
      deps: { client: client(['src/changed.py']), provider: provider(capture) },
    })

    expect(report.scope).toEqual({ kind: 'pull-request', number: 7, files: 1 })
    expect(capture.prompts.join()).toContain('src/changed.py')
    expect(capture.prompts.join()).not.toContain('src/untouched.py')
    // The whole tree is still ingested — schema evidence may live outside the diff.
    expect(report.stats.filesFetched).toBe(2)
  })

  it('falls back to a full scan and says so when the change list is unavailable', async () => {
    const capture = { prompts: [] as string[] }
    const report = await runScan(parsed, {
      ...BASE, pullRequest: 9,
      deps: { client: client(null), provider: provider(capture) },
    })
    expect(report.truncatedReason ?? '').toMatch(/whole repository/)
    expect(capture.prompts.join()).toContain('src/untouched.py')
  })

  it('does not serve a repo-scoped result for a PR-scoped scan', async () => {
    const capture = { prompts: [] as string[] }
    await runScan(parsed, { ...BASE, deps: { client: client(null), provider: provider(capture) } })
    const prScan = await runScan(parsed, {
      ...BASE, pullRequest: 7,
      deps: { client: client(['src/changed.py']), provider: provider(capture) },
    })
    expect(prScan.cache).toBeUndefined()
    expect(prScan.scope?.kind).toBe('pull-request')
  })
})

/* ---------------------------------------------------------------- patch -- */

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1', kind: 'equivalent', title: 'Add a LIMIT',
    summary: '', severity: 'medium', category: 'over-fetch',
    engine: 'postgres', accessStyle: 'raw-sql',
    original: 'SELECT id, name\nFROM users\nWHERE tenant = $1',
    primaryOccurrence: {
      file: 'src/repo.py', startLine: 42, endLine: 44,
      enclosingSymbol: 'load_users', excerpt: '',
    },
    otherOccurrences: [],
    suggestion: {
      proposed: 'SELECT id, name\nFROM users\nWHERE tenant = $1\nLIMIT 1',
      rationale: '', equivalenceArgument: '', assumptions: [],
      expectedImpact: 'One row instead of many.',
    },
    evidence: [], grounding: 'verified', groundingNotes: [], modelConfidence: 0.9,
    ...over,
  }
}

describe('unified diff', () => {
  it('emits a hunk anchored at the finding’s real line numbers', () => {
    const diff = toUnifiedDiff(finding())
    expect(diff).toContain('--- a/src/repo.py')
    expect(diff).toContain('+++ b/src/repo.py')
    expect(diff).toContain('@@ -42,3 +42,4 @@ load_users')
    expect(diff).toContain('+LIMIT 1')
    // Unchanged lines carry a leading space, as the format requires.
    expect(diff).toContain(' SELECT id, name')
  })

  it('excludes behaviour-changing findings from a bulk patch', () => {
    const report = { repo: REPO } as ScanReport
    const patch = toPatchFile(report, [
      finding(),
      finding({ id: 'f2', kind: 'behavioural', title: 'Fix the wrong column' }),
    ])
    expect(patch).toContain('Add a LIMIT')
    expect(patch).not.toContain('Fix the wrong column')
    expect(patch).toMatch(/1 behaviour-changing finding.*NOT included/s)
  })

  it('tells the reader to check the patch before applying it', () => {
    const patch = toPatchFile({ repo: REPO } as ScanReport, [finding()])
    expect(patch).toContain('git apply --check')
  })
})

/* ----------------------------------------------------------------- cost -- */

describe('cost estimate', () => {
  it('prices input and output separately', () => {
    const e = estimateCost({
      provider: 'anthropic', model: 'claude-sonnet-5',
      promptTokens: 1_000_000, passes: 0, maxOutputTokens: 0,
    })
    expect(e.usd).toBeCloseTo(3, 5) // $3/M input, no output
  })

  it('reports free for on-device inference', () => {
    const e = estimateCost({
      provider: 'chrome', model: 'gemini-nano',
      promptTokens: 5_000_000, passes: 10, maxOutputTokens: 1024,
    })
    expect(e.free).toBe(true)
    expect(e.usd).toBe(0)
  })

  it('returns null rather than inventing a price for an unknown model', () => {
    const e = estimateCost({
      provider: 'openai', model: 'gpt-9-unreleased',
      promptTokens: 1000, passes: 1, maxOutputTokens: 1000,
    })
    expect(e.usd).toBeNull()
    expect(e.totalTokens).toBeGreaterThan(0)
  })

  it('matches a dated model id by its longest known prefix', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 })
    expect(priceFor('gpt-5.1-2026-01-01')?.input).toBe(1.25)
  })

  it('formats small amounts without pretending to precision', () => {
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(0.42)).toBe('$0.42')
    expect(formatUsd(12.7)).toBe('$13')
  })
})
