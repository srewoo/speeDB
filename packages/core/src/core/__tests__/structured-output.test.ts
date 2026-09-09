import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../providers/anthropic'
import { OpenAiProvider } from '../providers/openai'
import { GeminiProvider } from '../providers/gemini'
import { AUTHOR_SCHEMA, SINGLE_SHOT_SCHEMA, TRIAGE_SCHEMA } from '../analyze/schemas'
import type { LlmRequest } from '../providers'

/**
 * Structured output, asserted at the wire.
 *
 * The failure this file exists for was not a wrong schema — it was a schema
 * nobody sent. `LlmRequest.jsonSchema` was declared, documented as "adapters
 * that support structured output enforce this schema", threaded through the
 * Gemini adapter, and had **zero callers** anywhere in the product. Every
 * response from every provider was free text, and `analyze/parse.ts` repaired
 * what it could.
 *
 * Nothing caught it because every existing provider test asserts on the parsed
 * response, and a free-text response parses fine when the model happens to
 * behave. So these tests assert on the *request body* instead: what was
 * actually put on the wire is the only thing that distinguishes "enforced" from
 * "hoped for".
 */

const REQ: LlmRequest = {
  system: 'sys',
  user: 'usr',
  temperature: 0.1,
  maxOutputTokens: 1000,
  schema: TRIAGE_SCHEMA,
}

let sent: { url: string; body: Record<string, any> }[] = []

/** The one request the adapter made. Fails loudly if it made none. */
function onlyRequest(): Record<string, any> {
  expect(sent).toHaveLength(1)
  return sent[0]!.body
}

function stubFetch(response: unknown) {
  sent = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('every cloud adapter puts the schema on the wire', () => {
  it('OpenAI sends json_schema, not the weaker json_object', async () => {
    stubFetch({
      choices: [{ message: { content: '{"verdicts":[]}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    await new OpenAiProvider('sk-test', 'gpt-5.4-mini').complete(REQ)

    const rf = onlyRequest().response_format
    // `json_object` only promises valid JSON. `{}` satisfies it, and `{}` is
    // exactly what a lost triage pass looks like.
    expect(rf.type).toBe('json_schema')
    expect(rf.json_schema.name).toBe(TRIAGE_SCHEMA.name)
    expect(rf.json_schema.strict).toBe(true)
    expect(rf.json_schema.schema).toEqual(TRIAGE_SCHEMA.schema)
  })

  it('OpenAI falls back to json_object when no schema is supplied', async () => {
    stubFetch({ choices: [{ message: { content: '{}' } }], usage: {} })
    await new OpenAiProvider('sk-test', 'gpt-5.4-mini').complete({ ...REQ, schema: undefined })
    expect(onlyRequest().response_format).toEqual({ type: 'json_object' })
  })

  it('Anthropic forces a tool call, which is how a shape is enforced there', async () => {
    // This adapter previously sent no schema of any kind — it was the only one
    // with no structured-output path at all.
    stubFetch({
      content: [{ type: 'tool_use', name: 'triage_verdicts', input: { verdicts: [] } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await new AnthropicProvider('sk-ant-test', 'claude-sonnet-5').complete(REQ)

    const body = onlyRequest()
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].input_schema).toEqual(TRIAGE_SCHEMA.schema)
    // Without tool_choice the model may answer in prose and skip the tool
    // entirely, which would leave exactly the free-text path this replaces.
    expect(body.tool_choice).toEqual({ type: 'tool', name: TRIAGE_SCHEMA.name })
  })

  it('Anthropic returns the tool input as the response text', async () => {
    const input = { verdicts: [{ id: 'a', verdict: 'clean', category: 'other', why: 'x' }] }
    stubFetch({
      content: [{ type: 'tool_use', name: 'triage_verdicts', input }],
      usage: { input_tokens: 5, output_tokens: 7 },
    })
    const res = await new AnthropicProvider('sk-ant-test', 'claude-sonnet-5').complete(REQ)

    // Re-serialised so `analyze/parse.ts` sees the same thing from every
    // adapter — one parsing path, not one per provider.
    expect(JSON.parse(res.text)).toEqual(input)
    expect(res.promptTokens).toBe(5)
    expect(res.completionTokens).toBe(7)
  })

  it('Anthropic still surfaces text when the model did not call the tool', async () => {
    // A refusal, a max_tokens stop, or a model that ignored the forced choice
    // all arrive as text. Returning '' for those would turn a diagnosable
    // failure into an empty pass.
    stubFetch({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const res = await new AnthropicProvider('sk-ant-test', 'claude-sonnet-5').complete(REQ)
    expect(res.text).toBe('I cannot help with that.')
  })

  it('Anthropic sends no tools when no schema is supplied', async () => {
    stubFetch({ content: [{ type: 'text', text: '{}' }], usage: {} })
    await new AnthropicProvider('sk-ant-test', 'claude-sonnet-5')
      .complete({ ...REQ, schema: undefined })
    const body = onlyRequest()
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  it('Gemini sends a responseSchema stripped to the subset it accepts', async () => {
    stubFetch({
      candidates: [{ content: { parts: [{ text: '{"verdicts":[]}' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    })
    await new GeminiProvider('key', 'gemini-3-pro').complete(REQ)

    const schema = onlyRequest().generationConfig.responseSchema
    expect(schema).toBeDefined()
    expect(schema.properties.verdicts.items.properties.verdict.enum)
      .toEqual(['problem', 'clean', 'unsure'])

    // `responseSchema` is an OpenAPI 3.0 subset, not JSON Schema. It rejects
    // the whole request on an unknown keyword, and the strict triage schema
    // carries `additionalProperties` because OpenAI requires it. One schema
    // document, translated at the boundary — two documents would drift.
    expect(JSON.stringify(schema)).not.toContain('additionalProperties')
  })
})

describe('the schemas themselves', () => {
  it('triage is closed and fully required, so it can be enforced strictly', () => {
    // OpenAI strict mode rejects a schema with an open object or an optional
    // property. If this drifts, `strict: true` starts returning a 400 for every
    // triage pass — and with sampling that is three failed calls, not one.
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false)
        expect(new Set(node.required)).toEqual(new Set(Object.keys(node.properties)))
      }
      Object.values(node).forEach(walk)
    }
    expect(TRIAGE_SCHEMA.strict).toBe(true)
    walk(TRIAGE_SCHEMA.schema)
  })

  it('the authoring envelope requires both arrays, empty or not', () => {
    /*
     * "No findings" and "the model forgot the key" are different answers, and
     * an absent key cannot tell them apart. The accounting contract that
     * two-stage analysis exists to enforce lives in this envelope: a site that
     * appears in neither array is a silently dropped site.
     *
     * The finding *body* is deliberately left open. Its optional parts are
     * genuinely optional, and strict mode would force the model to emit empty
     * strings for fields it has nothing to say about — which grounding would
     * then have to strip.
     */
    const props = AUTHOR_SCHEMA.schema.properties as any
    expect(AUTHOR_SCHEMA.schema.required).toEqual(['findings', 'declined'])
    expect(props.findings.items.required).toContain('siteId')
    expect(props.declined.items.required).toEqual(['siteId', 'why'])
    expect(AUTHOR_SCHEMA.strict).toBe(false)
  })

  it('every schema names itself, because providers key on the name', () => {
    for (const s of [TRIAGE_SCHEMA, AUTHOR_SCHEMA, SINGLE_SHOT_SCHEMA]) {
      expect(s.name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
