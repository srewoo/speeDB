import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { runScan } from '../pipeline'

/**
 * Exercises runScan with NO dependency injection.
 *
 * Every other pipeline test passes `deps`, which means the real GitLabClient,
 * GitHubClient and provider adapters — and every module only they pull in —
 * were never loaded during a test. A module-initialisation error there is
 * invisible until someone runs an actual scan.
 */

const SOURCE = `
async def get_all(conn, tenant_id):
    rows = await conn.fetch(
        "SELECT id, policy_uname, status FROM policy WHERE tenant_id=$1",
        tenant_id,
    )
    return rows
`.trim()

/** A minimal well-formed tar.gz, as the forge archive endpoints serve. */
function archive(files: { name: string; body: string }[]): Uint8Array {
  const enc = new TextEncoder()
  const blocks: Uint8Array[] = []
  for (const f of files) {
    const header = new Uint8Array(512)
    const body = enc.encode(f.body)
    header.set(enc.encode(`repo-abc123/${f.name}`.slice(0, 100)), 0)
    header.set(enc.encode(body.length.toString(8).padStart(11, '0') + '\0'), 124)
    header[156] = '0'.charCodeAt(0)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512)
    padded.set(body)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const b of blocks) { out.set(b, at); at += b.length }
  return new Uint8Array(gzipSync(Buffer.from(out)))
}

const TARBALL = archive([
  { name: 'src/repo.py', body: SOURCE },
  { name: 'db/schema.sql', body: 'CREATE TABLE "policy" ("id" int4, "tenant_id" int8);' },
])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } })
}

const MODEL_REPLY = JSON.stringify({ findings: [] })

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

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

/** Routes every URL the real clients and adapters hit. */
function route(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/repository/archive') || u.includes('/tarball/')) {
      return new Response(streamOf(TARBALL), { status: 200 })
    }
    if (u.includes('/repository/commits/') || u.includes('/commits/')) {
      return Response.json({ id: 'abc1234567', sha: 'abc1234567' })
    }
    if (u.includes('/merge_requests/') || u.includes('/pulls/')) {
      return Response.json({ changes: [] })
    }
    if (u.includes('api.openai.com')) {
      return Response.json({
        choices: [{ message: { content: MODEL_REPLY } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    }
    if (u.includes('api.anthropic.com')) {
      return Response.json({
        content: [{ type: 'text', text: MODEL_REPLY }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    }
    // Project / repo metadata.
    return Response.json({ default_branch: 'main' })
  }) as ReturnType<typeof vi.fn>
}

describe('runScan through the real clients and adapters', () => {
  it('completes a GitLab scan with OpenAI selected', async () => {
    globalThis.fetch = route() as unknown as typeof fetch
    const report = await runScan(
      { forge: 'gitlab', apiOrigin: 'https://gitlab.com/api', owner: 'mindtickle/migrated-call-ai', name: 'next-step-service' },
      {
        provider: 'openai', model: 'gpt-5.1-mini', apiKey: 'sk-test',
        temperature: 0.1, maxOutputTokens: 4096, tokenBudget: 100_000,
      },
    )
    expect(report.stats.ingest).toBe('archive')
    expect(report.stats.filesFetched).toBe(2)
    expect(report.repo.commitSha).toBe('abc1234567')
  })

  it('completes a GitHub scan with Anthropic selected', async () => {
    globalThis.fetch = route() as unknown as typeof fetch
    const report = await runScan(
      { forge: 'github', apiOrigin: 'https://api.github.com', owner: 'acme', name: 'svc' },
      {
        provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-test',
        temperature: 0.1, maxOutputTokens: 4096, tokenBudget: 100_000,
      },
    )
    expect(report.stats.ingest).toBe('archive')
    expect(report.findings).toEqual([])
  })

  it('completes a scan with the cost gate engaged', async () => {
    // The store always supplies onEstimate; no other test did, so the whole
    // estimate block — and a use-before-declaration inside it — went unexercised.
    globalThis.fetch = route() as unknown as typeof fetch
    const seen: { candidates: number; passes: number; usd: number | null }[] = []

    const report = await runScan(
      { forge: 'gitlab', apiOrigin: 'https://gitlab.com/api', owner: 'g', name: 'p' },
      {
        provider: 'openai', model: 'gpt-5.1-mini', apiKey: 'sk-test',
        temperature: 0.1, maxOutputTokens: 4096, tokenBudget: 100_000,
        onEstimate: (e) => {
          seen.push({ candidates: e.candidates, passes: e.passes, usd: e.cost.usd })
          return true
        },
      },
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]!.candidates).toBeGreaterThan(0)
    expect(seen[0]!.passes).toBeGreaterThan(0)
    expect(seen[0]!.usd).toBeGreaterThan(0)
    expect(report.stats.ingest).toBe('archive')
  })

  it('cancels cleanly when the cost gate is declined', async () => {
    globalThis.fetch = route() as unknown as typeof fetch
    await expect(
      runScan(
        { forge: 'gitlab', apiOrigin: 'https://gitlab.com/api', owner: 'g', name: 'p' },
        {
          provider: 'openai', model: 'gpt-5.1-mini', apiKey: 'sk-test',
          temperature: 0.1, maxOutputTokens: 4096, tokenBudget: 100_000,
          onEstimate: () => false,
        },
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('completes a scan of a repository containing no queries at all', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('archive') || u.includes('tarball')) {
        return new Response(streamOf(archive([{ name: 'README.md', body: '# hi' }])), { status: 200 })
      }
      if (u.includes('commits/')) return Response.json({ id: 'deadbeef99' })
      return Response.json({ default_branch: 'main' })
    }) as unknown as typeof fetch

    const report = await runScan(
      { forge: 'gitlab', apiOrigin: 'https://gitlab.com/api', owner: 'g', name: 'p' },
      {
        provider: 'openai', model: 'gpt-5.1-mini', apiKey: 'sk-test',
        temperature: 0.1, maxOutputTokens: 4096, tokenBudget: 100_000,
      },
    )
    expect(report.findings).toEqual([])
    expect(report.stats.candidatesFound).toBe(0)
  })
})
