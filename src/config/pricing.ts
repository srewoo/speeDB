/**
 * Approximate list prices, USD per million tokens.
 *
 * Deliberately a small table with an explicit "unknown" path: a wrong number
 * shown confidently is worse than no number. Anything not listed produces a
 * token estimate with no dollar figure, and the UI says why.
 *
 * Input and output are priced separately, which is the reason the pipeline
 * counts them separately rather than folding both into one total.
 */

export interface Price {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
}

const PRICES: Record<string, Price> = {
  // Anthropic
  'claude-opus-5': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-fable-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // OpenAI
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5.1-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  // Google
  'gemini-3-pro': { input: 1.25, output: 10 },
  'gemini-3-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
}

/** On-device inference has no per-token price. */
export function isFree(provider: string): boolean {
  return provider === 'chrome'
}

export function priceFor(model: string): Price | null {
  if (PRICES[model]) return PRICES[model]!
  // Providers version model ids with dated suffixes; match the longest prefix.
  const prefix = Object.keys(PRICES)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0]
  return prefix ? PRICES[prefix]! : null
}

export interface CostEstimate {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** null when the model has no published price in the table. */
  usd: number | null
  free: boolean
}

export function estimateCost(input: {
  provider: string
  model: string
  promptTokens: number
  /** Output is bounded by maxOutputTokens per pass; assume a realistic fraction. */
  passes: number
  maxOutputTokens: number
}): CostEstimate {
  const free = isFree(input.provider)

  // Reports are usually far shorter than the ceiling. 35% is a deliberate
  // middle estimate, and the UI presents the result as an estimate.
  const completionTokens = Math.round(input.passes * input.maxOutputTokens * 0.35)
  const totalTokens = input.promptTokens + completionTokens

  if (free) {
    return { promptTokens: input.promptTokens, completionTokens, totalTokens, usd: 0, free: true }
  }

  const price = priceFor(input.model)
  const usd = price
    ? (input.promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output
    : null

  return { promptTokens: input.promptTokens, completionTokens, totalTokens, usd, free: false }
}

export function formatUsd(usd: number): string {
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(usd < 10 ? 2 : 0)}`
}
