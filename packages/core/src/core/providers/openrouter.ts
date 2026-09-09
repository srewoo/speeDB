import type { ModelSpec } from '@/config/models'
import type { LlmProvider, LlmRequest, LlmResponse } from './types'
import { LlmError } from './types'

const API = 'https://openrouter.ai/api/v1/chat/completions'
const MODELS_API = 'https://openrouter.ai/api/v1/models'

/**
 * A single gateway in front of hundreds of models from dozens of vendors,
 * speaking an OpenAI-compatible chat completions API — so the request shape
 * mirrors `openai.ts`, but two things cannot be claimed the way that adapter
 * claims them.
 *
 * `response_format: json_schema` promises the provider *guarantees* the
 * shape. OpenRouter forwards that promise to whichever backend serves the
 * chosen model, and support for it is inconsistent across the catalog — a
 * guarantee this adapter cannot verify is a guarantee it should not make. It
 * asks for `json_object` instead, which is broadly supported, and leaves the
 * rest to the repair pass `analyze/parse.ts` already runs for every provider
 * that cannot enforce a schema.
 *
 * OpenAI's reasoning models reject a supplied `temperature` outright, and
 * `openai.ts` recovers from that by retrying without it. Recovering the same
 * way here would mean guessing which of an open-ended, vendor-prefixed
 * catalog (`openai/o3`, `x-ai/grok-4`, …) behaves like a reasoning model —
 * that heuristic does not generalise the way it does for OpenAI's own model
 * ids. Temperature is always sent; a model that rejects it surfaces as a
 * normal request error rather than being silently retried.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly id = 'openrouter' as const

  constructor(readonly model: string, private readonly apiKey: string) {}

  async isAvailable() {
    if (!this.apiKey) return { ok: false, reason: 'No OpenRouter API key set.' }
    return { ok: true }
  }

  async listModels(): Promise<ModelSpec[]> {
    const res = await fetch(MODELS_API, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    }).catch(() => null)

    if (!res) throw new LlmError('Could not reach OpenRouter.', 'network')
    if (res.status === 401) throw new LlmError('OpenRouter rejected the API key.', 'auth')
    if (!res.ok) throw new LlmError(`OpenRouter returned ${res.status}.`, 'unknown')

    const body = (await res.json()) as {
      data?: { id: string; name?: string; context_length?: number; top_provider?: { max_completion_tokens?: number } }[]
    }

    return (body.data ?? []).map((m) => ({
      id: m.id,
      label: m.name ?? m.id,
      contextWindow: m.context_length ?? 128_000,
      maxOutputTokens: Math.min(m.top_provider?.max_completion_tokens ?? 16_000, 16_000),
      tier: (/mini|nano|lite|small|haiku/i.test(m.id)
        ? 'fast'
        : /flash|balanced/i.test(m.id) ? 'balanced' : 'flagship') as ModelSpec['tier'],
    })).sort((a, b) => a.id.localeCompare(b.id))
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let res: Response
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          // Attribution only — shown on OpenRouter's own dashboards, not
          // required for the request to succeed.
          'x-title': 'speeDB',
        },
        signal: req.signal ?? null,
        body: JSON.stringify({
          model: this.model,
          temperature: req.temperature,
          max_tokens: req.maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      })
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError('Scan cancelled.', 'cancelled')
      throw new LlmError(`Network error calling OpenRouter: ${String(e)}`, 'network')
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 401) throw new LlmError('OpenRouter rejected the API key.', 'auth')
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') ?? '0') * 1000
        throw new LlmError('Rate limited by OpenRouter.', 'rate-limit', retry || undefined)
      }
      if (/context.?length|maximum context/i.test(detail)) {
        throw new LlmError('Chunk exceeded the model context window.', 'context-length')
      }
      throw new LlmError(`OpenRouter error ${res.status}: ${detail.slice(0, 300)}`, 'unknown')
    }

    const body = (await res.json()) as OpenRouterBody
    // A routed model can still refuse or run out of budget mid-response;
    // OpenRouter reports it the same way OpenAI does, in `finish_reason`.
    const choice = body.choices?.[0]
    if (choice?.finish_reason === 'content_filter') {
      throw new LlmError('The model refused this request.', 'refusal')
    }
    return {
      text: choice?.message?.content ?? '',
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    }
  }
}

interface OpenRouterBody {
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}
