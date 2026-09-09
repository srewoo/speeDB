import { modelSupportsTemperature, type ModelSpec } from '@/config/models'
import type { LlmProvider, LlmRequest, LlmResponse } from './types'
import { LlmError } from './types'

const API = 'https://api.openai.com/v1/chat/completions'
const MODELS_API = 'https://api.openai.com/v1/models'

/**
 * The models endpoint returns everything the key can touch — embeddings, TTS,
 * transcription, image models, moderation. None of those can run this task, so
 * they are filtered out rather than offered and left to fail at scan time.
 */
const NOT_CHAT = /(embedding|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|search|rerank|codex-mini)/i

export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const

  constructor(readonly model: string, private readonly apiKey: string) {}

  async isAvailable() {
    if (!this.apiKey) return { ok: false, reason: 'No OpenAI API key set.' }
    return { ok: true }
  }

  async listModels(): Promise<ModelSpec[]> {
    const res = await fetch(MODELS_API, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    }).catch(() => null)

    if (!res) throw new LlmError('Could not reach OpenAI.', 'network')
    if (res.status === 401) throw new LlmError('OpenAI rejected the API key.', 'auth')
    if (!res.ok) throw new LlmError(`OpenAI returned ${res.status}.`, 'unknown')

    const body = (await res.json()) as { data?: { id: string }[] }
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(?:gpt|o\d|chatgpt)/i.test(id) && !NOT_CHAT.test(id))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((id) => ({
        id,
        label: id,
        contextWindow: id.startsWith('gpt-5') ? 400_000 : 128_000,
        maxOutputTokens: 16_000,
        tier: (id.includes('nano') ? 'fast' : id.includes('mini') ? 'balanced' : 'flagship') as ModelSpec['tier'],
        supportsTemperature: modelSupportsTemperature('openai', id),
      }))
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Reasoning models fix their own temperature and reject the parameter
    // outright. Send it only where it is honoured.
    const useTemperature = modelSupportsTemperature('openai', this.model)
    let res = await this.post(req, useTemperature)

    // Belt and braces: the id heuristic cannot know about a model released
    // after this build, so recover from an explicit rejection once rather than
    // failing the pass. Cheap — it only ever costs one extra round trip, and
    // only for a model we misclassified.
    if (!res.ok && res.status === 400) {
      const detail = await res.clone().text().catch(() => '')
      if (/temperature/i.test(detail) && useTemperature) {
        res = await this.post(req, false)
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 401) throw new LlmError('OpenAI rejected the API key.', 'auth')
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') ?? '0') * 1000
        throw new LlmError('Rate limited by OpenAI.', 'rate-limit', retry || undefined)
      }
      if (/context_length|maximum context/i.test(detail)) {
        throw new LlmError('Chunk exceeded the model context window.', 'context-length')
      }
      throw new LlmError(`OpenAI error ${res.status}: ${detail.slice(0, 300)}`, 'unknown')
    }

    const body = (await res.json()) as OpenAiBody
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    }
  }

  private async post(req: LlmRequest, withTemperature: boolean): Promise<Response> {
    try {
      return await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        signal: req.signal ?? null,
        body: JSON.stringify({
          model: this.model,
          ...(withTemperature ? { temperature: req.temperature } : {}),
          max_completion_tokens: req.maxOutputTokens,
          // `json_object` only promises *valid JSON*, not the right JSON: the
          // model could return `{}` and satisfy it. `json_schema` promises the
          // shape, and in strict mode the provider guarantees it rather than
          // being asked. Falls back to `json_object` when no schema is supplied
          // so a caller without one is no worse off than before.
          response_format: req.schema
            ? {
                type: 'json_schema',
                json_schema: {
                  name: req.schema.name,
                  strict: req.schema.strict,
                  schema: req.schema.schema,
                },
              }
            : { type: 'json_object' },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      })
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError('Scan cancelled.', 'cancelled')
      throw new LlmError(`Network error calling OpenAI: ${String(e)}`, 'network')
    }
  }
}

interface OpenAiBody {
  choices?: { message?: { content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}
