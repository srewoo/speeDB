import type { ModelSpec, ProviderId } from '@/config/models'
import type { ResponseSchema } from '@/core/analyze/schemas'

export interface LlmRequest {
  system: string
  user: string
  temperature: number
  maxOutputTokens: number
  /**
   * Response schema, enforced by every adapter that can.
   *
   * Adapters differ in how, not whether: OpenAI takes a named `json_schema`
   * response format, Gemini a `responseSchema`, Anthropic a forced tool call
   * whose `input_schema` is the same document. Chrome's built-in AI has no
   * facility for it and says so rather than pretending.
   *
   * `analyze/parse.ts` still repairs what arrives. A schema removes most of
   * what it has to repair; it does not remove the need for it, because one
   * backend cannot enforce anything and a truncated response is malformed
   * whatever the provider promised.
   */
  schema?: ResponseSchema
  signal?: AbortSignal
}

export interface LlmResponse {
  text: string
  promptTokens: number
  completionTokens: number
}

/**
 * One adapter per backend. Every adapter returns raw text; JSON parsing and
 * repair happen once, centrally, in `analyze/parse.ts` — so a provider that
 * lacks native structured output degrades in exactly one place.
 */
export interface LlmProvider {
  readonly id: ProviderId
  readonly model: string
  /** Resolve to `false` (with a reason) rather than throwing on a missing key. */
  isAvailable(): Promise<{ ok: boolean; reason?: string }>
  complete(req: LlmRequest): Promise<LlmResponse>
  /**
   * Live model list for the supplied key. Providers ship new models constantly
   * and a key's access varies by account tier, so the settings dropdown asks
   * the provider rather than trusting a hardcoded array. Adapters must throw
   * `LlmError` on failure; the caller falls back to the curated list.
   */
  listModels(): Promise<ModelSpec[]>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'auth' | 'rate-limit' | 'context-length' | 'network'
      | 'refusal' | 'invalid-response' | 'unavailable' | 'cancelled' | 'unknown',
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/** Rough token estimate. Good enough for budgeting; never used for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6)
}
