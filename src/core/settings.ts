import { DEFAULTS, type ProviderId } from '@/config/models'

export interface Settings {
  provider: ProviderId
  model: string
  temperature: number
  maxOutputTokens: number
  scanTokenBudget: number
  theme: 'system' | 'light' | 'dark'
}

export interface Secrets {
  openaiKey?: string
  geminiKey?: string
  anthropicKey?: string
  githubToken?: string
  gitlabToken?: string
}

export const DEFAULT_SETTINGS: Settings = {
  provider: DEFAULTS.provider,
  model: DEFAULTS.model,
  temperature: DEFAULTS.temperature,
  maxOutputTokens: DEFAULTS.maxOutputTokens,
  scanTokenBudget: DEFAULTS.scanTokenBudget,
  theme: 'system',
}

const SETTINGS_KEY = 'speedb.settings'
const SECRETS_KEY = 'speedb.secrets'

/**
 * Non-secret settings live in `chrome.storage.local` so they survive a restart.
 */
export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

/**
 * Secrets go in `chrome.storage.session`, which is memory-backed and cleared
 * when the browser closes. That means keys are never written to disk — the
 * trade-off is the user re-enters them each browser session, which is the
 * right default for a tool that holds four separate credentials.
 *
 * `setPersistSecrets(true)` opts into `storage.local` instead. It is off by
 * default and the UI states plainly what it changes.
 */
export async function loadSecrets(): Promise<Secrets> {
  const [session, local] = await Promise.all([
    chrome.storage.session.get(SECRETS_KEY),
    chrome.storage.local.get(SECRETS_KEY),
  ])
  return {
    ...((local[SECRETS_KEY] as Secrets | undefined) ?? {}),
    ...((session[SECRETS_KEY] as Secrets | undefined) ?? {}),
  }
}

export async function saveSecrets(patch: Partial<Secrets>, persist: boolean): Promise<Secrets> {
  const next = { ...(await loadSecrets()), ...patch }
  // Strip empties so a cleared field actually disappears rather than storing "".
  for (const k of Object.keys(next) as (keyof Secrets)[]) {
    if (!next[k]) delete next[k]
  }
  const area = persist ? chrome.storage.local : chrome.storage.session
  await area.set({ [SECRETS_KEY]: next })
  if (!persist) await chrome.storage.local.remove(SECRETS_KEY)
  return next
}

export async function clearSecrets(): Promise<void> {
  await Promise.all([
    chrome.storage.session.remove(SECRETS_KEY),
    chrome.storage.local.remove(SECRETS_KEY),
  ])
}

/** Never log or export a raw key — this is what the UI renders. */
export function maskKey(key: string | undefined): string {
  if (!key) return ''
  if (key.length <= 10) return '•'.repeat(key.length)
  return `${key.slice(0, 6)}${'•'.repeat(12)}${key.slice(-4)}`
}

export function keyForProvider(provider: ProviderId, secrets: Secrets): string | undefined {
  switch (provider) {
    case 'openai': return secrets.openaiKey
    case 'gemini': return secrets.geminiKey
    case 'anthropic': return secrets.anthropicKey
    case 'chrome': return undefined
  }
}
