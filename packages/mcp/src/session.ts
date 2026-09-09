import { randomUUID } from 'node:crypto'
import { runScan } from '@speedb/core'
import type { ParsedRepoUrl, RepoClient, ScanOptions, ScanProgress, ScanReport } from '@speedb/core'
import { AgentProvider } from './agent-provider.js'

export interface Session {
  id: string
  provider: AgentProvider
  abort: AbortController
  /** Resolves when `runScan` returns or throws. Never rejects — see `start`. */
  done: Promise<void>
  report: ScanReport | null
  error: string | null
  progress: ScanProgress | null
  startedAt: number
  lastTouchedAt: number
}

/**
 * How long a session may sit untouched before it is reaped.
 *
 * A live session holds every fetched file body in memory — `runScan` keeps them
 * for the whole run because grounding and the value gate both need whole files
 * at the end. An agent that starts a scan and wanders off would otherwise pin
 * that indefinitely, and a stdio server lives as long as the editor does.
 */
const SESSION_TTL_MS = 30 * 60 * 1000

/**
 * Concurrent sessions allowed.
 *
 * `runScan` is re-entrant and holds no module state, so the limit is memory
 * rather than correctness — a large monorepo is hundreds of megabytes of file
 * bodies, and three of those is already more than most machines should spend on
 * a background code review.
 */
const MAX_SESSIONS = 3

export class SessionStore {
  private sessions = new Map<string, Session>()

  /**
   * Start a scan and return immediately.
   *
   * The scan runs as a detached promise: it will suspend at its first model
   * call, inside `AgentProvider.complete`, and stay suspended until the agent
   * answers. Nothing here awaits it, so `scan_start` returns as soon as ingest
   * and detection have work to report.
   */
  start(parsed: ParsedRepoUrl, opts: Omit<ScanOptions, 'signal' | 'deps'>, client?: RepoClient): Session {
    this.reap()
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `${MAX_SESSIONS} scans are already open. Finish one, or call scan_cancel, before starting another.`,
      )
    }

    const provider = new AgentProvider(opts.model)
    const abort = new AbortController()
    const session: Session = {
      id: randomUUID(),
      provider,
      abort,
      done: Promise.resolve(),
      report: null,
      error: null,
      progress: null,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
    }

    session.done = runScan(parsed, {
      ...opts,
      signal: abort.signal,
      onProgress: (p) => { session.progress = p },
      deps: { provider, ...(client ? { client } : {}) },
    })
      .then((report) => { session.report = report })
      .catch((e: unknown) => { session.error = e instanceof Error ? e.message : String(e) })
      .finally(() => { provider.close('Scan finished.') })

    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) {
      throw new Error(`Unknown session ${id}. It may have finished and been reaped.`)
    }
    session.lastTouchedAt = Date.now()
    return session
  }

  cancel(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.abort.abort()
    session.provider.close('Scan cancelled.')
    this.sessions.delete(id)
  }

  list(): Session[] {
    this.reap()
    return [...this.sessions.values()]
  }

  /** Drop sessions nobody has touched inside the TTL, freeing their file bodies. */
  private reap(): void {
    const cutoff = Date.now() - SESSION_TTL_MS
    for (const [id, s] of this.sessions) {
      if (s.lastTouchedAt < cutoff) {
        s.abort.abort()
        s.provider.close('Session expired.')
        this.sessions.delete(id)
      }
    }
  }
}
