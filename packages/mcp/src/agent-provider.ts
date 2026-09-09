import { LlmError, estimateTokens } from '@speedb/core'
import type { LlmProvider, LlmRequest, LlmResponse, ProviderId } from '@speedb/core'

export interface PendingRequest {
  /** Stable id the agent echoes back, so a late answer cannot resolve the wrong call. */
  id: string
  request: LlmRequest
}

/**
 * An `LlmProvider` whose completions come from the agent calling this server.
 *
 * `runScan` calls `provider.complete()` and awaits it. Nothing in the pipeline
 * requires that call to be an HTTP request, or to finish quickly — so here it
 * returns a promise that is simply not resolved yet. The scan suspends, exactly
 * as it would mid-`fetch`, and the MCP server hands the prompt to the agent.
 * When the agent submits an answer, the promise resolves and the scan resumes
 * from the same line with all of its state intact.
 *
 * The consequence worth being explicit about: this reimplements none of the
 * analysis. Chunking, triage sampling, the authoring retry loop, citation
 * grounding and the value gate all run as written and as tested. The agent is
 * substituted for the model, not for the pipeline — so a finding it produces is
 * checked against the fetched bytes just as strictly as one from an API model,
 * and an invented file path is rejected the same way.
 *
 * Why not MCP Sampling, which exists for precisely this: it is deprecated as of
 * protocol revision 2026-07-28 (SEP-2577), which tells new implementations not
 * to adopt it. This needs no protocol feature at all.
 */
export class AgentProvider implements LlmProvider {
  /**
   * Reported as a real provider id.
   *
   * `runScan` reads `provider.id` for a rate-limit message and looks the model
   * up for the cost estimate, so an invented id would either fail the lookup or
   * force a new member into a union that four exhaustive switches depend on.
   * The value is cosmetic here — nothing bills, and the estimate is reported as
   * agent-borne rather than as dollars.
   */
  readonly id: ProviderId = 'anthropic'
  readonly model: string

  private pending: {
    id: string
    request: LlmRequest
    resolve: (r: LlmResponse) => void
    reject: (e: unknown) => void
  } | null = null

  private waiters: ((p: PendingRequest | null) => void)[] = []
  private seq = 0
  private finished = false

  constructor(model = 'claude-sonnet-5') {
    this.model = model
  }

  async isAvailable(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true }
  }

  /** Never called by `runScan`; present to satisfy the interface. */
  async listModels() {
    return []
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (this.finished) {
      return Promise.reject(new LlmError('Session is closed.', 'cancelled'))
    }
    if (this.pending) {
      // The pipeline is strictly sequential — one outstanding call at a time.
      // If that ever stops being true this must grow a queue, so fail loudly
      // rather than silently dropping the earlier prompt.
      return Promise.reject(
        new LlmError('A prompt is already awaiting an answer.', 'unknown'),
      )
    }

    return new Promise<LlmResponse>((resolve, reject) => {
      const id = `req-${++this.seq}`
      this.pending = { id, request, resolve, reject }

      // Cancelling the scan must also free anyone blocked in `nextRequest`.
      request.signal?.addEventListener('abort', () => {
        if (this.pending?.id === id) {
          this.pending = null
          reject(new LlmError('Scan cancelled.', 'cancelled'))
        }
      }, { once: true })

      for (const w of this.waiters.splice(0)) w({ id, request })
    })
  }

  /**
   * The prompt currently awaiting an answer.
   *
   * Resolves immediately when one is already parked, and otherwise waits for
   * the scan to reach its next model call — so the agent's `scan_next` does not
   * have to poll through ingest and detection.
   */
  nextRequest(timeoutMs: number): Promise<PendingRequest | null> {
    if (this.pending) {
      return Promise.resolve({ id: this.pending.id, request: this.pending.request })
    }
    if (this.finished) return Promise.resolve(null)

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onReady)
        resolve(null)
      }, timeoutMs)

      const onReady = (p: PendingRequest | null) => {
        clearTimeout(timer)
        resolve(p)
      }
      this.waiters.push(onReady)
    })
  }

  /**
   * Answer the parked prompt and let the scan continue.
   *
   * The id must match. Without that check a retried or duplicated `scan_submit`
   * would resolve whatever call happened to be parked at that moment, which in
   * the authoring loop means one site's write-up being accepted as another's.
   */
  submit(id: string, text: string): { ok: true } | { ok: false; reason: string } {
    const pending = this.pending
    if (!pending) return { ok: false, reason: 'No prompt is awaiting an answer.' }
    if (pending.id !== id) {
      return {
        ok: false,
        reason: `Stale request id: ${id} was submitted but ${pending.id} is awaiting an answer.`,
      }
    }

    this.pending = null
    pending.resolve({
      text,
      promptTokens: estimateTokens(`${pending.request.system}\n${pending.request.user}`),
      completionTokens: estimateTokens(text),
    })
    return { ok: true }
  }

  /** Reject anything still parked. Called when a session ends or is reaped. */
  close(reason = 'Session closed.'): void {
    this.finished = true
    const pending = this.pending
    this.pending = null
    pending?.reject(new LlmError(reason, 'cancelled'))
    for (const w of this.waiters.splice(0)) w(null)
  }
}
