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
 * Concurrent *running* scans allowed.
 *
 * `runScan` is re-entrant and holds no module state, so the limit is memory
 * rather than correctness — a large monorepo is hundreds of megabytes of file
 * bodies, and three of those is already more than most machines should spend on
 * a background code review.
 *
 * It counts running scans only, which is what the memory argument is actually
 * about. A finished scan has released those file bodies: `runScan` has
 * returned and all that is retained is its report. Counting finished scans too
 * meant a fourth scan was refused while three completed ones sat idle, and the
 * only way through was `scan_cancel` on a scan that had already produced its
 * report — cancelling something finished, to free memory nobody was holding.
 */
const MAX_ACTIVE_SESSIONS = 3

/**
 * Finished sessions kept for `scan_report`, newest first.
 *
 * Reports are small next to file bodies, but "small" is not "free" and a
 * long-lived stdio server would otherwise accumulate them for the life of the
 * editor. Past this, the oldest finished session is dropped — never a running
 * one, and never in preference to a running one.
 */
const MAX_RETAINED_SESSIONS = 16

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
    const active = [...this.sessions.values()].filter(isActive)
    if (active.length >= MAX_ACTIVE_SESSIONS) {
      throw new Error(
        `${MAX_ACTIVE_SESSIONS} scans are already running. Answer one to completion, or call scan_cancel, before starting another.`,
      )
    }
    this.evictOldestFinished()

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

  /**
   * Keep the retained set bounded, dropping finished sessions oldest-first.
   *
   * Only finished sessions are candidates. A running scan is never evicted to
   * make room, however old it is: it is holding an agent mid-conversation, and
   * dropping it would strand a parked prompt that the agent is about to answer.
   */
  private evictOldestFinished(): void {
    if (this.sessions.size < MAX_RETAINED_SESSIONS) return

    const finished = [...this.sessions.values()]
      .filter((s) => !isActive(s))
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)

    let over = this.sessions.size - MAX_RETAINED_SESSIONS + 1
    for (const s of finished) {
      if (over <= 0) break
      s.provider.close('Session evicted to make room for a new scan.')
      this.sessions.delete(s.id)
      over--
    }
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

/**
 * A scan still doing work, and therefore still holding file bodies.
 *
 * `report` and `error` are both set from `start`'s own continuations, so
 * exactly one of them is non-null once `runScan` has settled — which makes
 * "neither is set" the definition of still running.
 */
function isActive(s: Session): boolean {
  return s.report === null && s.error === null
}
