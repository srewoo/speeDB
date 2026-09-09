/**
 * Approximate list prices, USD per million tokens.
 *
 * The principle has not changed: a wrong number shown confidently is worse than
 * no number, so anything unmatched produces a token estimate with no dollar
 * figure and the UI says why. Two things about the old implementation broke that
 * principle in opposite directions.
 *
 * **It priced the wrong model, silently.** Lookup fell back to
 * `model.startsWith(id)`, and the cheaper siblings extend their parent's id:
 * `gpt-4o-mini` matched `gpt-4o` and was quoted at $2.50/$10 instead of
 * $0.15/$0.60 — a 16x overestimate, presented as a fact. `matchBase()` below
 * only accepts a remainder made of version and date tokens, so a family word
 * like `mini`, `nano` or `lite` can never be absorbed into a prefix match.
 *
 * **It covered almost nothing.** The table held only the ids from
 * `config/models.ts`, but that file is the *offline fallback* — Settings asks
 * the provider what the key can actually use, so the ids that reach this
 * function are live ones like `claude-sonnet-4-5-20250929` or `gemini-2.5-pro`.
 * None of them were listed, which is why a perfectly mainstream model showed
 * "no published price".
 *
 * Input and output are priced separately, which is the reason the pipeline
 * counts them separately rather than folding both into one total.
 *
 * ---
 *
 * **These are a snapshot and they go stale.** No provider exposes prices in an
 * API, so a table is unavoidable — but an unverified table is exactly the
 * confident wrong number this file exists to prevent. `PRICES_VERIFIED_ON` is
 * shown to the user next to any figure derived from it. When you touch this
 * table, move that date, and if you cannot verify an entry, delete it: falling
 * back to "no published price" is the designed behaviour, not a failure.
 *
 * Verify against:
 *   https://www.anthropic.com/pricing
 *   https://platform.openai.com/docs/pricing
 *   https://ai.google.dev/gemini-api/docs/pricing
 */

export interface Price {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
}

/**
 * The date the table below was last checked against the three pricing pages.
 *
 * Surfaced in the cost gate: a price quoted without saying how old it is invites
 * the user to trust it more than it deserves.
 *
 * This date is deliberately NOT the date the file was last edited. These figures
 * were written from model knowledge rather than read off the pricing pages, so
 * the date reflects when that knowledge was current — which is the honest thing
 * to show a user, and which will look appropriately stale until someone opens
 * the three URLs above and moves it. Do not advance it as a side effect of
 * editing this file; advance it only when you have actually checked.
 */
export const PRICES_VERIFIED_ON = '2026-05-01'

/**
 * Standard-tier list prices. Batch, cached-input and long-context tiers are
 * deliberately absent: speeDB does not use them, and a discount the user is not
 * getting would understate the bill.
 */
const PRICES: Record<string, Price> = {
  /* ------------------------------------------------------- Anthropic ---- */
  'claude-opus-5': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-fable-5': { input: 3, output: 15 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  /* ---------------------------------------------------------- OpenAI ---- */
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5.1-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  o3: { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  o1: { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },

  /* ---------------------------------------------------------- Google ---- */
  'gemini-3-pro': { input: 1.25, output: 10 },
  'gemini-3-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
}

/** On-device inference has no per-token price. */
export function isFree(provider: string): boolean {
  return provider === 'chrome'
}

/**
 * Tokens that may follow a base id without changing which model it is.
 *
 * A release date, a channel, a revision number. Anything else — and `mini`,
 * `nano` and `lite` are the ones that matter — means this is a *different*
 * model, priced differently, and the match must be refused.
 */
const VERSION_TOKEN = /^(?:\d{8}|\d{6}|\d{3}|\d{4}-\d{2}-\d{2}|latest|preview|stable|exp|experimental|v\d+)$/i

/**
 * Does `model` name the same model as `base`, allowing only version noise?
 *
 * `claude-sonnet-4-5-20250929` vs `claude-sonnet-4-5` -> yes, a date.
 * `gpt-4o-mini`               vs `gpt-4o`             -> no, a cheaper sibling.
 */
function matchBase(model: string, base: string): boolean {
  if (model === base) return true
  if (!model.startsWith(base)) return false

  const rest = model.slice(base.length)
  // Vertex-style `@20250101`, or the usual `-`-delimited suffix.
  if (!/^[-@]/.test(rest)) return false

  const tokens = rest.slice(1).split(/[-@]/).filter(Boolean)
  if (tokens.length === 0) return false

  // A dashed date arrives as three numeric tokens; rejoin so it reads as one.
  const rejoined = tokens.join('-')
  if (VERSION_TOKEN.test(rejoined)) return true

  return tokens.every((t) => VERSION_TOKEN.test(t))
}

export function priceFor(model: string): Price | null {
  if (PRICES[model]) return PRICES[model]!

  // Longest base first: `gpt-5.1-mini` must win over `gpt-5.1`, and
  // `gemini-2.5-flash-lite` over `gemini-2.5-flash`.
  const base = Object.keys(PRICES)
    .filter((id) => matchBase(model, id))
    .sort((a, b) => b.length - a.length)[0]

  return base ? PRICES[base]! : null
}

export interface CostEstimate {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** null when the model has no published price in the table. */
  usd: number | null
  free: boolean
  /** The date the price used here was last verified. Shown beside the figure. */
  pricesVerifiedOn: string
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
    return {
      promptTokens: input.promptTokens, completionTokens, totalTokens,
      usd: 0, free: true, pricesVerifiedOn: PRICES_VERIFIED_ON,
    }
  }

  const price = priceFor(input.model)
  const usd = price
    ? (input.promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output
    : null

  return {
    promptTokens: input.promptTokens, completionTokens, totalTokens,
    usd, free: false, pricesVerifiedOn: PRICES_VERIFIED_ON,
  }
}

export function formatUsd(usd: number): string {
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(usd < 10 ? 2 : 0)}`
}
