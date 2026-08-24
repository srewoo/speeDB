/**
 * Single source of truth for selectable models.
 *
 * Deliberately a plain data file with no imports: when a provider ships a new
 * model, this is the only file that changes. Keep `contextWindow` honest — the
 * chunker uses it to decide how much source fits in one analysis request.
 */

export type ProviderId = 'chrome' | 'openai' | 'gemini' | 'anthropic'

export interface ModelSpec {
  id: string
  label: string
  contextWindow: number
  maxOutputTokens: number
  /** Rough guidance shown in the settings UI. */
  tier: 'flagship' | 'balanced' | 'fast'
  notes?: string
  /**
   * False when the model rejects or ignores a custom temperature.
   *
   * Reasoning models are the reason this exists. OpenAI's o-series and GPT-5
   * family return HTTP 400 for any temperature other than the default, so
   * sending our low-temperature setting would fail every request rather than
   * being quietly ignored. Undefined means "supported".
   */
  supportsTemperature?: boolean
}

export interface ProviderSpec {
  id: ProviderId
  label: string
  /** True when code never leaves the device. */
  onDevice: boolean
  requiresApiKey: boolean
  keyPlaceholder?: string
  docsUrl?: string
  models: ModelSpec[]
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'chrome',
    label: 'Chrome built-in AI',
    onDevice: true,
    requiresApiKey: false,
    docsUrl: 'https://developer.chrome.com/docs/ai/prompt-api',
    models: [
      {
        id: 'gemini-nano',
        label: 'Gemini Nano (on-device)',
        // The Prompt API session limit is small. The chunker must respect it;
        // this is the main reason on-device scans are slower, not worse.
        contextWindow: 6144,
        maxOutputTokens: 1024,
        tier: 'fast',
        notes: 'Nothing leaves your device. Small context — large files are split into more chunks.',
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    onDevice: false,
    requiresApiKey: true,
    keyPlaceholder: 'sk-ant-...',
    docsUrl: 'https://docs.anthropic.com/en/api/overview',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 200_000, maxOutputTokens: 16_000, tier: 'flagship' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 200_000, maxOutputTokens: 16_000, tier: 'balanced' },
      { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 200_000, maxOutputTokens: 16_000, tier: 'balanced' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutputTokens: 8_192, tier: 'fast' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    onDevice: false,
    requiresApiKey: true,
    keyPlaceholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/docs/models',
    models: [
      // The GPT-5 family are reasoning models: temperature is fixed.
      { id: 'gpt-5.1', label: 'GPT-5.1', contextWindow: 400_000, maxOutputTokens: 16_000, tier: 'flagship', supportsTemperature: false },
      { id: 'gpt-5.1-mini', label: 'GPT-5.1 mini', contextWindow: 400_000, maxOutputTokens: 16_000, tier: 'balanced', supportsTemperature: false },
      { id: 'gpt-5-nano', label: 'GPT-5 nano', contextWindow: 128_000, maxOutputTokens: 8_192, tier: 'fast', supportsTemperature: false },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    onDevice: false,
    requiresApiKey: true,
    keyPlaceholder: 'AIza...',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    models: [
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', contextWindow: 1_000_000, maxOutputTokens: 16_000, tier: 'flagship' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', contextWindow: 1_000_000, maxOutputTokens: 16_000, tier: 'balanced' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', contextWindow: 1_000_000, maxOutputTokens: 8_192, tier: 'fast' },
    ],
  },
]

export const DEFAULTS = {
  provider: 'anthropic' as ProviderId,
  model: 'claude-sonnet-5',
  /** Low by design. This is an extraction task, not a creative one. */
  temperature: 0.1,
  maxOutputTokens: 8_192,
  /** Hard ceiling per scan so a big repo can't silently cost a fortune. */
  scanTokenBudget: 400_000,
}

export function findProvider(id: ProviderId): ProviderSpec {
  const p = PROVIDERS.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown provider: ${id}`)
  return p
}

export function findModel(providerId: ProviderId, modelId: string): ModelSpec | undefined {
  return findProvider(providerId).models.find((m) => m.id === modelId)
}

/**
 * Model ids that fix their own temperature.
 *
 * Deliberately provider-scoped. Only OpenAI's reasoning models *reject* the
 * parameter (HTTP 400); Gemini's `-thinking` variants accept it happily, so a
 * shared name-based heuristic would wrongly disable the control there.
 *
 * Matched by id rather than a lookup because the model list is fetched live —
 * a model released after this build still has to be classified. The adapters
 * additionally recover from a temperature rejection at request time, so a miss
 * here costs one wasted round trip, not a failed scan.
 */
const FIXED_TEMPERATURE: Partial<Record<ProviderId, RegExp[]>> = {
  openai: [
    /^o\d/i,        // o1, o3, o4 …
    /^gpt-5/i,      // the GPT-5 family are reasoning models
    /^chatgpt-/i,
  ],
  // Anthropic accepts temperature unless extended thinking is enabled, which
  // speeDB does not request. Gemini and the Chrome built-in model both accept
  // it on every variant.
}

export function modelSupportsTemperature(
  providerId: ProviderId,
  modelId: string,
  model?: ModelSpec,
): boolean {
  // An explicit flag from the registry or a live listing always wins.
  if (model?.supportsTemperature !== undefined) return model.supportsTemperature
  return !(FIXED_TEMPERATURE[providerId] ?? []).some((re) => re.test(modelId))
}

