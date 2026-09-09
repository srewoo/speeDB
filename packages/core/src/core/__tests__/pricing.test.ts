import { describe, expect, it } from 'vitest'
import { estimateCost, PRICES_VERIFIED_ON, priceFor } from '@/config/pricing'

/**
 * The cost gate is consent, and consent rests on the number being right or
 * absent. Two failures were live at once, in opposite directions.
 */

describe('a cheaper sibling is never priced as its parent', () => {
  // The bug: lookup fell back to `model.startsWith(base)`, and every cheap
  // variant extends its parent's id. `gpt-4o-mini` was quoted at gpt-4o's
  // $2.50/$10 instead of $0.15/$0.60 — 16x too high, stated as fact.
  const SIBLINGS: [string, string][] = [
    ['gpt-4o-mini', 'gpt-4o'],
    ['gpt-4.1-mini', 'gpt-4.1'],
    ['gpt-4.1-nano', 'gpt-4.1'],
    ['gpt-5-mini', 'gpt-5'],
    ['gpt-5-nano', 'gpt-5'],
    ['gpt-5.1-mini', 'gpt-5.1'],
    ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    ['gemini-2.0-flash-lite', 'gemini-2.0-flash'],
    ['o3-mini', 'o3'],
    ['o1-mini', 'o1'],
  ]

  it.each(SIBLINGS)('%s is cheaper than %s, not equal to it', (child, parent) => {
    const c = priceFor(child)
    const p = priceFor(parent)
    expect(c).not.toBeNull()
    expect(p).not.toBeNull()
    expect(c!.input).toBeLessThan(p!.input)
    expect(c!.output).toBeLessThan(p!.output)
  })

  it('refuses a prefix match when the remainder is a family word, not a version', () => {
    // If a sibling is ever removed from the table, the answer must become
    // "unknown" — never the parent's price.
    expect(priceFor('gpt-4o-supercharged')).toBeNull()
    expect(priceFor('claude-sonnet-4-5-turbo')).toBeNull()
    expect(priceFor('gemini-2.5-pro-ultra')).toBeNull()
  })
})

describe('the ids the live model list actually returns are priced', () => {
  // `config/models.ts` is the offline fallback, not the source of truth:
  // Settings asks the provider what the key can use. The table used to hold
  // only the fallback ids, so every real dated id showed "no published price".
  const LIVE = [
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-1-20250805',
    'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022',
    'claude-3-7-sonnet-20250219',
    'gpt-4o-2024-08-06',
    'gpt-4o-mini-2024-07-18',
    'gpt-4.1-2025-04-14',
    'o4-mini-2025-04-16',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash-001',
    'gemini-3-pro-preview',
  ]

  it.each(LIVE)('%s resolves to a price', (id) => {
    const p = priceFor(id)
    expect(p, `${id} has no price`).not.toBeNull()
    expect(p!.input).toBeGreaterThan(0)
    expect(p!.output).toBeGreaterThan(0)
  })

  it('accepts a Vertex-style @date suffix', () => {
    expect(priceFor('gemini-2.5-pro@20250601')).toEqual(priceFor('gemini-2.5-pro'))
  })

  it('accepts a `-latest` channel', () => {
    expect(priceFor('claude-sonnet-4-5-latest')).toEqual(priceFor('claude-sonnet-4-5'))
  })

  it('output is priced above input for every entry — a sanity check on the table', () => {
    for (const id of LIVE) {
      const p = priceFor(id)!
      expect(p.output, id).toBeGreaterThanOrEqual(p.input)
    }
  })
})

describe('an unknown model still yields no dollar figure', () => {
  it('returns null rather than guessing', () => {
    expect(priceFor('some-model-nobody-has-heard-of')).toBeNull()
    const e = estimateCost({
      provider: 'openai', model: 'some-model-nobody-has-heard-of',
      promptTokens: 95_000, passes: 2, maxOutputTokens: 8_192,
    })
    expect(e.usd).toBeNull()
    expect(e.totalTokens).toBeGreaterThan(95_000)
  })

  it('on-device inference is free, not unknown', () => {
    const e = estimateCost({
      provider: 'chrome', model: 'gemini-nano',
      promptTokens: 95_000, passes: 2, maxOutputTokens: 1_024,
    })
    expect(e.free).toBe(true)
    expect(e.usd).toBe(0)
  })
})

describe('a price is never presented without its age', () => {
  it('carries the verification date through the estimate', () => {
    const e = estimateCost({
      provider: 'anthropic', model: 'claude-sonnet-4-5-20250929',
      promptTokens: 95_000, passes: 2, maxOutputTokens: 8_192,
    })
    expect(e.usd).toBeGreaterThan(0)
    expect(e.pricesVerifiedOn).toBe(PRICES_VERIFIED_ON)
  })

  it('the verification date is a real ISO date', () => {
    expect(PRICES_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isNaN(Date.parse(PRICES_VERIFIED_ON))).toBe(false)
  })
})

describe('the scan in the screenshot', () => {
  it('now quotes a figure instead of a dash', () => {
    // 339 query sites, 2 analysis passes, ~95k tokens.
    const e = estimateCost({
      provider: 'anthropic', model: 'claude-sonnet-4-5-20250929',
      promptTokens: 95_000, passes: 2, maxOutputTokens: 8_192,
    })
    expect(e.usd).not.toBeNull()
    expect(e.usd!).toBeGreaterThan(0.2)
    expect(e.usd!).toBeLessThan(1)
  })
})

describe('sites per pass is small on purpose', () => {
  it('the default is a reading-sized prompt, not a context-filling one', async () => {
    const { DEFAULTS } = await import('@/config/models')
    // Measured on mt-test-studio, one model, temperature 0, identical prompt:
    //   290 sites/pass -> 0 of 3 known N+1s found
    //    20 sites/pass -> 2 of 3 found
    // Packing the context window minimises round trips and destroys recall.
    expect(DEFAULTS.sitesPerPass).toBeGreaterThan(0)
    expect(DEFAULTS.sitesPerPass).toBeLessThanOrEqual(40)
  })

  it('chunkCandidates honours the cap independently of the token fit', async () => {
    const { chunkCandidates } = await import('@/core/pipeline')
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`, file: 'a.py', startLine: i, endLine: i, excerpt: 'x = 1',
      engine: 'mysql', accessStyle: 'orm' as const, detector: 'd',
      confidence: 0.9, priority: 0.5, priorityReasons: [],
    }))
    const chunks = chunkCandidates(candidates, [], 1_000_000, 8_192, 25)
    expect(chunks).toHaveLength(4)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(25)
  })
})
