import type { ModelSpec, ProviderId } from '@/config/models'

export interface LlmRequest {
  system: string
  user: string
  temperature: number
  maxOutputTokens: number
  /** Adapters that support structured output enforce this schema. */
  jsonSchema?: Record<string, unknown>
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
