import type { ProviderId } from '@/config/models'
import type { LlmProvider } from './types'
import { AnthropicProvider } from './anthropic'
import { OpenAiProvider } from './openai'
import { GeminiProvider } from './gemini'
import { ChromeAiProvider } from './chrome-ai'
import { OpenRouterProvider } from './openrouter'

export * from './types'

export interface ProviderConfig {
  provider: ProviderId
  model: string
  apiKey?: string
}

export function createProvider(cfg: ProviderConfig): LlmProvider {
  switch (cfg.provider) {
    case 'chrome':
      return new ChromeAiProvider()
    case 'anthropic':
      return new AnthropicProvider(cfg.model, cfg.apiKey ?? '')
    case 'openai':
      return new OpenAiProvider(cfg.model, cfg.apiKey ?? '')
    case 'gemini':
      return new GeminiProvider(cfg.model, cfg.apiKey ?? '')
    case 'openrouter':
      return new OpenRouterProvider(cfg.model, cfg.apiKey ?? '')
  }
}
