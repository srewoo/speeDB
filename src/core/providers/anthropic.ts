import type { ModelSpec } from '@/config/models'
import type { LlmProvider, LlmRequest, LlmResponse } from './types'
import { LlmError } from './types'

const API = 'https://api.anthropic.com/v1/messages'
const MODELS_API = 'https://api.anthropic.com/v1/models'
const VERSION = '2023-06-01'

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const

  constructor(readonly model: string, private readonly apiKey: string) {}

  async isAvailable() {
    if (!this.apiKey) return { ok: false, reason: 'No Anthropic API key set.' }
    if (!this.apiKey.startsWith('sk-ant-')) {
      return { ok: false, reason: 'That does not look like an Anthropic key (expected sk-ant-…).' }
    }
    return { ok: true }
  }

  async listModels(): Promise<ModelSpec[]> {
    const res = await fetch(`${MODELS_API}?limit=100`, {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    }).catch(() => null)

    if (!res) throw new LlmError('Could not reach Anthropic.', 'network')
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('Anthropic rejected the API key.', 'auth')
    }
    if (!res.ok) throw new LlmError(`Anthropic returned ${res.status}.`, 'unknown')

    const body = (await res.json()) as { data?: { id: string; display_name?: string }[] }
    return (body.data ?? []).map((m) => ({
      id: m.id,
      label: m.display_name ?? m.id,
      // The models endpoint does not report limits, so use the family default
      // and let the chunker's 20% headroom absorb the imprecision.
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
      tier: tierFor(m.id),
    }))
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let res: Response
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': VERSION,
          // Required for calls originating from a browser extension.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        signal: req.signal ?? null,
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxOutputTokens,
          temperature: req.temperature,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        }),
      })
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError('Scan cancelled.', 'cancelled')
      throw new LlmError(`Network error calling Anthropic: ${String(e)}`, 'network')
    }

    if (!res.ok) throw await mapError(res)

    const body = (await res.json()) as AnthropicBody
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')

    if (body.stop_reason === 'refusal') {
      throw new LlmError('The model declined to analyse this content.', 'refusal')
    }

    return {
      text,
      promptTokens: body.usage?.input_tokens ?? 0,
      completionTokens: body.usage?.output_tokens ?? 0,
    }
  }
}

interface AnthropicBody {
  content?: { type: string; text?: string }[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

async function mapError(res: Response): Promise<LlmError> {
  const detail = await res.text().catch(() => '')
  if (res.status === 401 || res.status === 403) {
    return new LlmError('Anthropic rejected the API key.', 'auth')
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? '0') * 1000
    return new LlmError('Rate limited by Anthropic.', 'rate-limit', retry || undefined)
  }
  if (res.status === 413 || /context|too long|max_tokens/i.test(detail)) {
    return new LlmError('Chunk exceeded the model context window.', 'context-length')
  }
  return new LlmError(`Anthropic error ${res.status}: ${detail.slice(0, 300)}`, 'unknown')
}

function tierFor(id: string): ModelSpec['tier'] {
  if (id.includes('opus')) return 'flagship'
  if (id.includes('haiku')) return 'fast'
  return 'balanced'
}
