import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../providers/anthropic'
import { OpenAiProvider } from '../providers/openai'
import { GeminiProvider } from '../providers/gemini'
import { OpenRouterProvider } from '../providers/openrouter'
import { LlmError } from '../providers/types'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Capture what each adapter actually puts on the wire. */
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string, init: RequestInit) => handler(url, init))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const REQ = { system: 'sys', user: 'usr', temperature: 0.1, maxOutputTokens: 4096 }

/* ------------------------------------------------------------- Anthropic -- */

describe('AnthropicProvider', () => {
  // Shape recorded from the Messages API.
  const OK = {
    content: [{ type: 'text', text: '{"findings":[]}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1234, output_tokens: 56 },
  }

  it('sends the browser-access header the API requires from an extension', async () => {
    const spy = mockFetch(() => json(OK))
    await new AnthropicProvider('claude-sonnet-5', 'sk-ant-x').complete(REQ)
    const headers = spy.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['x-api-key']).toBe('sk-ant-x')
  })

  it('returns text and both token counts', async () => {
    mockFetch(() => json(OK))
    const res = await new AnthropicProvider('claude-sonnet-5', 'sk-ant-x').complete(REQ)
    expect(res.text).toBe('{"findings":[]}')
    expect(res.promptTokens).toBe(1234)
    expect(res.completionTokens).toBe(56)
  })

  it('maps 401 to an auth error, not a generic failure', async () => {
    mockFetch(() => json({ error: 'x' }, 401))
    await expect(new AnthropicProvider('m', 'sk-ant-x').complete(REQ))
      .rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate-limit and carries retry-after', async () => {
    mockFetch(() => json({}, 429, { 'retry-after': '30' }))
    const err = await new AnthropicProvider('m', 'sk-ant-x').complete(REQ).catch((e) => e)
    expect((err as LlmError).kind).toBe('rate-limit')
    expect((err as LlmError).retryAfterMs).toBe(30_000)
  })

  it('surfaces a refusal distinctly', async () => {
    mockFetch(() => json({ ...OK, stop_reason: 'refusal' }))
    await expect(new AnthropicProvider('m', 'sk-ant-x').complete(REQ))
      .rejects.toMatchObject({ kind: 'refusal' })
  })

  it('rejects a key that is not an Anthropic key before spending a request', async () => {
    const spy = mockFetch(() => json(OK))
    const res = await new AnthropicProvider('m', 'sk-proj-openai').isAvailable()
    expect(res.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('lists models from the models endpoint', async () => {
    mockFetch(() => json({ data: [
      { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
    ] }))
    const models = await new AnthropicProvider('m', 'sk-ant-x').listModels()
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001'])
    expect(models[0]!.tier).toBe('flagship')
    expect(models[1]!.tier).toBe('fast')
  })
})

/* ---------------------------------------------------------------- OpenAI -- */

describe('OpenAiProvider', () => {
  const OK = {
    choices: [{ message: { content: '{"findings":[]}' } }],
    usage: { prompt_tokens: 900, completion_tokens: 100 },
  }

  it('omits temperature for a reasoning model', async () => {
    const spy = mockFetch(() => json(OK))
    await new OpenAiProvider('gpt-5.1', 'sk-x').complete(REQ)
    const body = JSON.parse(spy.mock.calls[0]![1].body as string)
    expect(body).not.toHaveProperty('temperature')
    expect(body.max_completion_tokens).toBe(4096)
  })

  it('sends temperature for a conventional model', async () => {
    const spy = mockFetch(() => json(OK))
    await new OpenAiProvider('gpt-4o', 'sk-x').complete(REQ)
    expect(JSON.parse(spy.mock.calls[0]![1].body as string).temperature).toBe(0.1)
  })

  it('retries without temperature when the API rejects it', async () => {
    // Covers a model released after this build that the id heuristic misses.
    let call = 0
    const spy = mockFetch(() => {
      call++
      return call === 1
        ? json({ error: { message: "Unsupported value: 'temperature' is not supported" } }, 400)
        : json(OK)
    })
    // A model the id heuristic classifies as temperature-capable, so the
    // recovery path is the thing under test rather than the heuristic.
    const res = await new OpenAiProvider('gpt-6-reasoning', 'sk-x').complete(REQ)
    expect(res.text).toBe('{"findings":[]}')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(JSON.parse(spy.mock.calls[1]![1].body as string)).not.toHaveProperty('temperature')
  })

  it('does not retry a 400 that has nothing to do with temperature', async () => {
    const spy = mockFetch(() => json({ error: { message: 'invalid model' } }, 400))
    await expect(new OpenAiProvider('gpt-4o', 'sk-x').complete(REQ)).rejects.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('filters non-chat models out of the live list', async () => {
    mockFetch(() => json({ data: [
      { id: 'gpt-4o' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' },
      { id: 'dall-e-3' }, { id: 'gpt-5.1' }, { id: 'omni-moderation-latest' },
    ] }))
    const ids = (await new OpenAiProvider('m', 'sk-x').listModels()).map((m) => m.id)
    expect(ids).toContain('gpt-4o')
    expect(ids).toContain('gpt-5.1')
    expect(ids).not.toContain('text-embedding-3-large')
    expect(ids).not.toContain('whisper-1')
    expect(ids).not.toContain('dall-e-3')
    expect(ids).not.toContain('omni-moderation-latest')
  })

  it('marks reasoning models as fixed-temperature in the live list', async () => {
    mockFetch(() => json({ data: [{ id: 'gpt-5.1' }, { id: 'gpt-4o' }] }))
    const models = await new OpenAiProvider('m', 'sk-x').listModels()
    expect(models.find((m) => m.id === 'gpt-5.1')!.supportsTemperature).toBe(false)
    expect(models.find((m) => m.id === 'gpt-4o')!.supportsTemperature).toBe(true)
  })
})

/* ---------------------------------------------------------------- Gemini -- */

describe('GeminiProvider', () => {
  const OK = {
    candidates: [{ content: { parts: [{ text: '{"findings":[]}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 40 },
  }

  it('passes the key in a header, not the query string', async () => {
    const spy = mockFetch(() => json(OK))
    await new GeminiProvider('gemini-3-pro', 'AIza-x').complete(REQ)
    const [url, init] = spy.mock.calls[0]!
    expect(url).not.toContain('AIza-x')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-x')
  })

  it('asks for JSON output', async () => {
    const spy = mockFetch(() => json(OK))
    await new GeminiProvider('gemini-3-pro', 'AIza-x').complete(REQ)
    const body = JSON.parse(spy.mock.calls[0]![1].body as string)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.temperature).toBe(0.1)
  })

  it('reports a safety block as a refusal', async () => {
    mockFetch(() => json({ candidates: [{ finishReason: 'SAFETY' }] }))
    await expect(new GeminiProvider('m', 'AIza-x').complete(REQ))
      .rejects.toMatchObject({ kind: 'refusal' })
  })

  it('keeps only models that support generateContent', async () => {
    mockFetch(() => json({ models: [
      { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro',
        supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_000_000, outputTokenLimit: 65_536 },
      { name: 'models/text-embedding-004', displayName: 'Embedding',
        supportedGenerationMethods: ['embedContent'] },
    ] }))
    const models = await new GeminiProvider('m', 'AIza-x').listModels()
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('gemini-3-pro')
    // The provider's own reported limit is trusted, but capped for our use.
    expect(models[0]!.contextWindow).toBe(1_000_000)
    expect(models[0]!.maxOutputTokens).toBe(16_000)
  })
})

/* ------------------------------------------------------------ OpenRouter -- */

describe('OpenRouterProvider', () => {
  const OK = {
    choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 100 },
  }

  it('sends the bearer key and an attribution header', async () => {
    const spy = mockFetch(() => json(OK))
    await new OpenRouterProvider('openai/gpt-5.1', 'sk-or-x').complete(REQ)
    const headers = spy.mock.calls[0]![1].headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-or-x')
    expect(headers['x-title']).toBe('speeDB')
  })

  it('asks for json_object rather than claiming schema enforcement', async () => {
    const spy = mockFetch(() => json(OK))
    await new OpenRouterProvider('openai/gpt-5.1', 'sk-or-x').complete({
      ...REQ,
      schema: { name: 'findings', strict: true, schema: { type: 'object' } },
    })
    const body = JSON.parse(spy.mock.calls[0]![1].body as string)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('always sends temperature — no per-vendor reasoning-model heuristic', async () => {
    const spy = mockFetch(() => json(OK))
    await new OpenRouterProvider('openai/o3', 'sk-or-x').complete(REQ)
    expect(JSON.parse(spy.mock.calls[0]![1].body as string).temperature).toBe(0.1)
  })

  it('returns text and both token counts', async () => {
    mockFetch(() => json(OK))
    const res = await new OpenRouterProvider('openai/gpt-5.1', 'sk-or-x').complete(REQ)
    expect(res.text).toBe('{"findings":[]}')
    expect(res.promptTokens).toBe(900)
    expect(res.completionTokens).toBe(100)
  })

  it('maps 401 to an auth error', async () => {
    mockFetch(() => json({ error: { message: 'no auth' } }, 401))
    await expect(new OpenRouterProvider('m', 'sk-or-x').complete(REQ))
      .rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate-limit and carries retry-after', async () => {
    mockFetch(() => json({}, 429, { 'retry-after': '12' }))
    const err = await new OpenRouterProvider('m', 'sk-or-x').complete(REQ).catch((e) => e)
    expect((err as LlmError).kind).toBe('rate-limit')
    expect((err as LlmError).retryAfterMs).toBe(12_000)
  })

  it('reports a content-filter refusal distinctly', async () => {
    mockFetch(() => json({ ...OK, choices: [{ message: {}, finish_reason: 'content_filter' }] }))
    await expect(new OpenRouterProvider('m', 'sk-or-x').complete(REQ))
      .rejects.toMatchObject({ kind: 'refusal' })
  })

  it('lists models from the live catalog', async () => {
    mockFetch(() => json({ data: [
      { id: 'openai/gpt-5.1', name: 'GPT-5.1', context_length: 400_000 },
      { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', context_length: 200_000 },
    ] }))
    const models = await new OpenRouterProvider('m', 'sk-or-x').listModels()
    expect(models.map((m) => m.id)).toContain('openai/gpt-5.1')
    expect(models.find((m) => m.id === 'anthropic/claude-haiku-4-5')!.tier).toBe('fast')
  })

  it('reports unreachable rather than throwing when there is no key', async () => {
    const res = await new OpenRouterProvider('m', '').isAvailable()
    expect(res.ok).toBe(false)
  })
})
