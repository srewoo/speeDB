import type { ModelSpec } from '@/config/models'
import type { LlmProvider, LlmRequest, LlmResponse } from './types'
import { LlmError } from './types'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const

  constructor(readonly model: string, private readonly apiKey: string) {}

  async isAvailable() {
    if (!this.apiKey) return { ok: false, reason: 'No Gemini API key set.' }
    return { ok: true }
  }

  async listModels(): Promise<ModelSpec[]> {
    const res = await fetch(`${BASE}?pageSize=200`, {
      headers: { 'x-goog-api-key': this.apiKey },
    }).catch(() => null)

    if (!res) throw new LlmError('Could not reach Gemini.', 'network')
    if (res.status === 400 || res.status === 403) {
      throw new LlmError('Gemini rejected the API key.', 'auth')
    }
    if (!res.ok) throw new LlmError(`Gemini returned ${res.status}.`, 'unknown')

    const body = (await res.json()) as {
      models?: {
        name: string
        displayName?: string
        inputTokenLimit?: number
        outputTokenLimit?: number
        supportedGenerationMethods?: string[]
      }[]
    }

    return (body.models ?? [])
      // Gemini reports capability per model — trust it rather than guessing
      // from the name, so embedding and vision-only models drop out cleanly.
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => {
        const id = m.name.replace(/^models\//, '')
        return {
          id,
          label: m.displayName ?? id,
          contextWindow: m.inputTokenLimit ?? 1_000_000,
          maxOutputTokens: Math.min(m.outputTokenLimit ?? 16_000, 16_000),
          tier: (id.includes('lite') ? 'fast' : id.includes('flash') ? 'balanced' : 'flagship') as ModelSpec['tier'],
        }
      })
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `${BASE}/${encodeURIComponent(this.model)}:generateContent`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        // Key in a header, not the query string — query strings leak into logs.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        signal: req.signal ?? null,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            temperature: req.temperature,
            maxOutputTokens: req.maxOutputTokens,
            responseMimeType: 'application/json',
            ...(req.jsonSchema ? { responseSchema: req.jsonSchema } : {}),
          },
        }),
      })
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError('Scan cancelled.', 'cancelled')
      throw new LlmError(`Network error calling Gemini: ${String(e)}`, 'network')
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 400 && /API key/i.test(detail)) {
        throw new LlmError('Gemini rejected the API key.', 'auth')
      }
      if (res.status === 429) throw new LlmError('Rate limited by Gemini.', 'rate-limit')
      throw new LlmError(`Gemini error ${res.status}: ${detail.slice(0, 300)}`, 'unknown')
    }

    const body = (await res.json()) as GeminiBody
    const cand = body.candidates?.[0]
    if (cand?.finishReason === 'SAFETY') {
      throw new LlmError('Gemini blocked this content.', 'refusal')
    }
    return {
      text: (cand?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
      promptTokens: body.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    }
  }
}

interface GeminiBody {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}
