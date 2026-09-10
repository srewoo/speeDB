import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../session.js'
import { LocalClient } from '../local-client.js'

/**
 * The concurrency cap counts scans that are still holding memory.
 *
 * `MAX_SESSIONS` is justified by memory: a live session pins every fetched
 * file body, because grounding and the value gate both need whole files at the
 * end of the run. A *finished* session has released those — `runScan` has
 * returned and only its report is retained, so the agent can still call
 * `scan_report`.
 *
 * Counting finished scans against a memory cap blocked a fourth scan while
 * three completed ones sat idle, and the only way through was `scan_cancel` on
 * a scan that had already produced its report. Observed while scanning five
 * repositories in one session.
 */

/** A repository with no query sites: `runScan` completes without a model call. */
async function emptyRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'speedb-session-'))
  await writeFile(join(root, 'README.md'), '# nothing to see\n')
  return root
}

const PARSED = {
  forge: 'github' as const,
  apiOrigin: 'https://api.github.com',
  owner: 'local',
  name: 'repo',
}

const OPTS = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5',
  temperature: 0,
  maxOutputTokens: 8192,
  tokenBudget: Number.MAX_SAFE_INTEGER,
  analysis: 'two-stage' as const,
  noCache: true,
  onEstimate: () => true,
}

async function startFinished(store: SessionStore, root: string) {
  const session = store.start(PARSED as never, OPTS, new LocalClient(root))
  await session.done
  return session
}

describe('SessionStore concurrency', () => {
  it('does not count a finished scan against the cap', async () => {
    const store = new SessionStore()
    const root = await emptyRepo()

    for (let i = 0; i < 3; i++) {
      const s = await startFinished(store, root)
      expect(s.report, 'scan should have completed').not.toBeNull()
    }

    // Previously threw "3 scans are already open".
    expect(() => store.start(PARSED as never, OPTS, new LocalClient(root))).not.toThrow()
  })

  it('still keeps a finished report readable after a later scan starts', async () => {
    const store = new SessionStore()
    const root = await emptyRepo()

    const first = await startFinished(store, root)
    for (let i = 0; i < 3; i++) await startFinished(store, root)

    expect(store.get(first.id).report).not.toBeNull()
  })

  it('still caps scans that are genuinely active', async () => {
    const store = new SessionStore()
    const root = await emptyRepo()

    // Never awaited, so these stay active for the duration of the assertion.
    const active = [0, 1, 2].map(() => store.start(PARSED as never, OPTS, new LocalClient(root)))
    expect(active).toHaveLength(3)

    expect(() => store.start(PARSED as never, OPTS, new LocalClient(root)))
      .toThrow(/already open|already running/i)

    await Promise.all(active.map((s) => s.done))
  })

  it('evicts the oldest finished scan rather than growing without bound', async () => {
    const store = new SessionStore()
    const root = await emptyRepo()

    const first = await startFinished(store, root)
    for (let i = 0; i < 24; i++) await startFinished(store, root)

    // The oldest finished session is gone, and the store has not grown forever.
    expect(() => store.get(first.id)).toThrow(/Unknown session/)
    expect(store.list().length).toBeLessThanOrEqual(16)
  })
})
