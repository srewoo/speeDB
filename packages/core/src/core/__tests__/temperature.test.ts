import { describe, expect, it } from 'vitest'
import { modelSupportsTemperature, PROVIDERS } from '@/config/models'

describe('modelSupportsTemperature', () => {
  it('omits temperature for OpenAI reasoning models', () => {
    for (const id of ['o1', 'o3-mini', 'o4-mini', 'gpt-5.1', 'gpt-5-nano', 'chatgpt-4o-latest']) {
      expect(modelSupportsTemperature('openai', id)).toBe(false)
    }
  })

  it('keeps temperature for conventional OpenAI models', () => {
    for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-4-turbo']) {
      expect(modelSupportsTemperature('openai', id)).toBe(true)
    }
  })

  it('does not apply the OpenAI heuristic to other providers', () => {
    // Gemini's thinking variants accept temperature; a shared name-based rule
    // would wrongly disable the control for them.
    expect(modelSupportsTemperature('gemini', 'gemini-2.0-flash-thinking-exp')).toBe(true)
    expect(modelSupportsTemperature('gemini', 'gemini-3-pro')).toBe(true)
    // Anthropic only fixes temperature when extended thinking is requested,
    // which speeDB never does.
    expect(modelSupportsTemperature('anthropic', 'claude-opus-5')).toBe(true)
    expect(modelSupportsTemperature('chrome', 'gemini-nano')).toBe(true)
  })

  it('lets an explicit flag override the heuristic in both directions', () => {
    const spec = { id: 'gpt-5.1', label: '', contextWindow: 1, maxOutputTokens: 1, tier: 'flagship' } as const
    expect(modelSupportsTemperature('openai', 'gpt-5.1', { ...spec, supportsTemperature: true })).toBe(true)
    expect(modelSupportsTemperature('openai', 'gpt-4o', { ...spec, supportsTemperature: false })).toBe(false)
  })

  it('marks the bundled GPT-5 entries as fixed-temperature', () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai')!
    for (const m of openai.models) {
      expect(modelSupportsTemperature('openai', m.id, m)).toBe(false)
    }
  })

  it('leaves every non-OpenAI bundled model temperature-capable', () => {
    for (const p of PROVIDERS.filter((x) => x.id !== 'openai')) {
      for (const m of p.models) {
        expect(modelSupportsTemperature(p.id, m.id, m)).toBe(true)
      }
    }
  })
})
