import { findProvider, type ModelSpec } from '@/config/models'
import type { LlmProvider, LlmRequest, LlmResponse } from './types'
import { LlmError, estimateTokens } from './types'

/**
 * Chrome's built-in Prompt API (Gemini Nano). Nothing leaves the device.
 *
 * Two things make this adapter different from the cloud ones:
 *  1. The context window is tiny (~6k). We fail fast with a `context-length`
 *     error so the chunker can split further and retry, rather than silently
 *     truncating the source — a truncated file produces ungrounded findings.
 *  2. There is no token accounting, so we report estimates and the UI labels
 *     them as such.
 */
export class ChromeAiProvider implements LlmProvider {
  readonly id = 'chrome' as const
  readonly model = 'gemini-nano'

  async isAvailable() {
    const api = getApi()
    if (!api) {
      return {
        ok: false,
        reason:
          'Chrome built-in AI is not available. Needs Chrome 138+ on desktop with the on-device model downloaded.',
      }
    }
    try {
      const status = await api.availability()
      if (status === 'unavailable') {
        return { ok: false, reason: 'This device does not support the on-device model.' }
      }
      if (status === 'downloadable' || status === 'downloading') {
        return { ok: false, reason: 'The on-device model is still downloading. Try again shortly.' }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: `Could not query Chrome AI: ${String(e)}` }
    }
  }

  /** One built-in model; the registry entry is already the truth. */
  async listModels(): Promise<ModelSpec[]> {
    return findProvider('chrome').models
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const api = getApi()
    if (!api) throw new LlmError('Chrome built-in AI unavailable.', 'unavailable')

    const promptTokens = estimateTokens(req.system + req.user)

    let session: LanguageModelSession
    try {
      session = await api.create({
        initialPrompts: [{ role: 'system', content: req.system }],
        temperature: req.temperature,
        topK: 3,
        signal: req.signal,
        // Declaring the languages is required for the model to attest output
        // safety; omitting it makes Chrome warn and degrades output quality.
        // Source code and our prompt are both English, and the response is
        // JSON, so 'en' is correct on both sides.
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      })
    } catch (e) {
      throw new LlmError(`Could not start an on-device session: ${String(e)}`, 'unavailable')
    }

    try {
      // No structured-output facility on this backend. `req.schema` is honoured
      // where it can be — as a `responseConstraint` on the builds that expose
      // one — and otherwise deliberately ignored rather than quietly dropped:
      // `analyze/parse.ts` repairs what arrives, which is the reason that
      // repair path exists at all. Enforcing nothing here is a real difference
      // between the on-device path and the cloud ones, and it belongs in the
      // code rather than in a reader's assumption.
      const constrained = req.schema && 'responseConstraint' in session
      const text = await session.prompt(
        req.user,
        constrained
          ? { signal: req.signal, responseConstraint: req.schema!.schema }
          : { signal: req.signal },
      )
      return { text, promptTokens, completionTokens: estimateTokens(text) }
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError('Scan cancelled.', 'cancelled')
      const msg = String(e)
      if (/too large|quota|token/i.test(msg)) {
        throw new LlmError('Chunk is too large for the on-device model.', 'context-length')
      }
      throw new LlmError(`On-device model failed: ${msg}`, 'unknown')
    } finally {
      session.destroy?.()
    }
  }
}

/* The Prompt API is not in @types/chrome yet — narrow local declarations. */
interface LanguageModelSession {
  /**
   * `responseConstraint` is present on the builds that shipped it and absent on
   * the rest, which is why the call site feature-detects rather than trusting
   * this declaration.
   */
  prompt(
    input: string,
    opts?: { signal?: AbortSignal; responseConstraint?: Record<string, unknown> },
  ): Promise<string>
  destroy?(): void
}
interface LanguageModelApi {
  availability(): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>
  create(opts: {
    initialPrompts?: { role: string; content: string }[]
    temperature?: number
    topK?: number
    signal?: AbortSignal
    expectedInputs?: { type: string; languages: string[] }[]
    expectedOutputs?: { type: string; languages: string[] }[]
  }): Promise<LanguageModelSession>
}

function getApi(): LanguageModelApi | undefined {
  return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel
}
