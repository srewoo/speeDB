import { useCallback, useEffect, useState } from 'react'
import { modelSupportsTemperature, PROVIDERS, type ModelSpec, type ProviderId } from '@/config/models'
import { useApp } from '@/store/app-store'
import { createProvider, LlmError } from '@/core/providers'
import { GitHubClient } from '@/core/repo/github'
import { GitLabClient } from '@/core/repo/gitlab'
import type { TokenCheck } from '@/core/repo/client'
import { keyForProvider } from '@/core/settings'
import { cacheSummary, clearCache, CACHE_TTL_MS } from '@/core/report/cache'
import { Callout, Field, SecretInput, Section, Toggle } from './primitives'
import { IconAlert, IconCheck, IconInfo, IconShield } from './icons'

type Tab = 'ai' | 'forges' | 'appearance'

export function SettingsScreen({ initialTab = 'ai' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab)
  return (
    <div className="page stack-6">
      <h1 className="t-title">Settings</h1>
      <div className="tabs" role="tablist">
        {([['ai', 'AI provider'], ['forges', 'GitHub & GitLab'], ['appearance', 'Appearance']] as const).map(
          ([key, label]) => (
            <button
              key={key} role="tab" className="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ),
        )}
      </div>
      {tab === 'ai' ? <AiTab /> : tab === 'forges' ? <ForgeTab /> : <AppearanceTab />}
    </div>
  )
}

type ModelListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'live'; models: ModelSpec[] }
  | { status: 'fallback'; reason: string }

function AiTab() {
  const { settings, secrets, persistSecrets } = useApp()
  const { updateSettings, updateSecrets, setPersistSecrets } = useApp()
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [models, setModels] = useState<ModelListState>({ status: 'idle' })

  const provider = PROVIDERS.find((p) => p.id === settings.provider)!
  const apiKey = keyForProvider(settings.provider, secrets)

  /**
   * Ask the provider what this key can actually use. Model line-ups change
   * constantly and access varies by account tier, so a hardcoded list is
   * wrong the moment it ships. The curated list in config/models.ts stays as
   * the offline fallback, never as the source of truth.
   */
  const loadModels = useCallback(async () => {
    if (provider.requiresApiKey && !apiKey) {
      setModels({ status: 'fallback', reason: 'Add a key to load the live model list.' })
      return
    }
    setModels({ status: 'loading' })
    try {
      const live = await createProvider({
        provider: settings.provider, model: settings.model, apiKey,
      }).listModels()

      if (live.length === 0) {
        setModels({ status: 'fallback', reason: 'The provider returned no usable models.' })
        return
      }
      setModels({ status: 'live', models: live })

      // If the saved model is not in the account's list, fall back to the
      // first live one rather than letting the scan fail on a 404.
      if (!live.some((m) => m.id === settings.model)) {
        void updateSettings({ model: live[0]!.id })
      }
    } catch (e) {
      const reason = e instanceof LlmError ? e.message : String(e)
      setModels({ status: 'fallback', reason })
    }
  }, [provider.requiresApiKey, apiKey, settings.provider, settings.model, updateSettings])

  // Refresh whenever the provider or its key changes. Debounced so typing a
  // key character by character does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { void loadModels() }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider, apiKey])

  async function selectProvider(id: ProviderId) {
    const next = PROVIDERS.find((p) => p.id === id)!
    setCheck(null)
    setModels({ status: 'idle' })
    // Cloud hosts are optional permissions — ask only when the user picks one.
    if (!next.onDevice) {
      const origin = ORIGINS[id]
      if (origin) {
        const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false)
        if (!granted) {
          setCheck({ ok: false, message: `Permission to contact ${next.label} was declined.` })
          return
        }
      }
    }
    await updateSettings({ provider: id, model: next.models[0]!.id })
  }

  async function testConnection() {
    setChecking(true)
    setCheck(null)
    try {
      const res = await createProvider({
        provider: settings.provider, model: settings.model, apiKey,
      }).isAvailable()
      setCheck({ ok: res.ok, message: res.ok ? 'Ready to use.' : res.reason ?? 'Not available.' })
      if (res.ok) void loadModels()
    } finally {
      setChecking(false)
    }
  }

  const options = models.status === 'live' ? models.models : provider.models
  const selected = options.find((m) => m.id === settings.model)
  const tempSupported = modelSupportsTemperature(settings.provider, settings.model, selected)

  return (
    <div className="stack-6">
      <Section title="Provider">
        <div className="stack-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              className="finding-row"
              aria-selected={settings.provider === p.id}
              style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}
              onClick={() => void selectProvider(p.id)}
            >
              <div className="row">
                <span className="t-subheading">{p.label}</span>
                <span className="spacer" />
                {settings.provider === p.id ? (
                  <span style={{ color: 'var(--accent-600)' }}><IconCheck size={15} /></span>
                ) : null}
              </div>
              <p className="t-caption dim" style={{ marginTop: 2 }}>
                {p.onDevice
                  ? 'Runs on this device. No code is sent anywhere.'
                  : `Sends repository source to ${p.label}. Needs an API key.`}
              </p>
            </button>
          ))}
        </div>
      </Section>

      {provider.requiresApiKey ? (
        <Section title="API key">
          <div className="stack">
            <Field
              label={`${provider.label} API key`} id="api-key"
              hint={persistSecrets
                ? 'Stored on disk in extension storage.'
                : 'Held in memory only — cleared when Chrome closes.'}
            >
              <SecretInput
                id="api-key"
                placeholder={provider.keyPlaceholder}
                value={apiKey ?? ''}
                onChange={(v) => void updateSecrets(keyPatch(settings.provider, v))}
              />
            </Field>

            <div className="row-3" style={{ alignItems: 'flex-start' }}>
              <Toggle
                checked={persistSecrets}
                onChange={(v) => void setPersistSecrets(v)}
                label="Remember keys between browser sessions"
              />
              <div className="stack-2" style={{ minWidth: 0 }}>
                <span className="t-body-sm">Remember keys after Chrome closes</span>
                <span className="t-caption dim2">
                  An extension cannot meaningfully encrypt this. Leaving it off means
                  re-pasting once per browser session, and nothing is written to disk.
                </span>
              </div>
            </div>

            <div className="row">
              <button className="btn" onClick={() => void testConnection()} disabled={checking}>
                {checking ? 'Checking…' : 'Test connection'}
              </button>
            </div>

            {check ? (
              <Callout
                tone={check.ok ? 'info' : 'err'}
                icon={check.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
              >
                {check.message}
              </Callout>
            ) : null}
          </div>
        </Section>
      ) : (
        <Callout icon={<IconShield size={15} />} title="Fully private">
          Chrome&rsquo;s built-in model runs locally. Its context window is much smaller, so
          large files are split into more passes and scans take longer.
        </Callout>
      )}

      <Section
        title="Model"
        action={
          provider.requiresApiKey ? (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => void loadModels()}
              disabled={models.status === 'loading'}
            >
              {models.status === 'loading' ? 'Loading…' : 'Refresh list'}
            </button>
          ) : null
        }
      >
        <div className="stack">
          <Field
            label="Model"
            id="model"
            hint={
              models.status === 'live'
                ? `${models.models.length} models available to this key.`
                : models.status === 'loading'
                  ? 'Asking the provider what this key can use…'
                  : undefined
            }
          >
            <select
              id="model" className="select" value={settings.model}
              onChange={(e) => void updateSettings({ model: e.target.value })}
            >
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.tier ? ` — ${m.tier}` : ''}
                </option>
              ))}
            </select>
          </Field>

          {models.status === 'fallback' ? (
            <Callout tone="warn" icon={<IconInfo size={15} />}>
              Showing the built-in list. {models.reason}
            </Callout>
          ) : null}

          {selected ? (
            <p className="t-caption dim2 nums">
              Context {selected.contextWindow.toLocaleString()} tokens · max output{' '}
              {selected.maxOutputTokens.toLocaleString()}
              {tempSupported ? '' : ' · fixed temperature'}
              {selected.notes ? ` · ${selected.notes}` : ''}
            </p>
          ) : null}

          <Field
            label="Thoroughness" id="triage-samples"
            hint={
              settings.triageSamples <= 1
                ? 'Fast runs triage once. Measured at 16% precision against 52% for Standard — the same repository, model and prompt. Use it only to sanity-check a change cheaply.'
                : 'Triage runs this many times and the union is analysed. Run-to-run variance was the largest error term in the benchmark, and sampling is the direct answer to it. Triage is ~30 tokens per site, so three samples cost less than one write-up.'
            }
          >
            <select
              id="triage-samples" className="input"
              value={settings.triageSamples}
              onChange={(e) => void updateSettings({ triageSamples: Number(e.target.value) })}
            >
              <option value={1}>Fast — triage once</option>
              <option value={3}>Standard — triage 3×, union (recommended)</option>
              <option value={5}>Deep — triage 5×, union</option>
            </select>
          </Field>

          <Field
            label={
              tempSupported
                ? `Temperature — ${settings.temperature.toFixed(2)}`
                : 'Temperature — fixed by this model'
            }
            id="temperature"
            hint={
              tempSupported
                ? 'Low values keep the analysis literal. This is an extraction task, not a creative one.'
                : 'Reasoning models set their own sampling temperature and reject a custom one, so speeDB omits it for this model. Your saved value is kept for other models.'
            }
          >
            <input
              id="temperature" className="range" type="range"
              min={0} max={1} step={0.05} value={settings.temperature}
              disabled={!tempSupported}
              onChange={(e) => void updateSettings({ temperature: Number(e.target.value) })}
            />
          </Field>

          <Field
            label="Max output tokens per pass" id="max-tokens"
            hint="Too low truncates findings mid-report; speeDB repairs what it can."
          >
            <input
              id="max-tokens" className="input nums" type="number"
              min={1024} max={64_000} step={512} value={settings.maxOutputTokens}
              onChange={(e) => void updateSettings({ maxOutputTokens: Number(e.target.value) })}
            />
          </Field>

          <Field
            label="Token budget per scan" id="budget"
            hint="A hard ceiling. The scan stops and reports what it has rather than running on."
          >
            <input
              id="budget" className="input nums" type="number"
              min={10_000} max={5_000_000} step={10_000} value={settings.scanTokenBudget}
              onChange={(e) => void updateSettings({ scanTokenBudget: Number(e.target.value) })}
            />
          </Field>
        </div>
      </Section>
    </div>
  )
}

const ORIGINS: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/*',
  gemini: 'https://generativelanguage.googleapis.com/*',
  anthropic: 'https://api.anthropic.com/*',
}

function keyPatch(provider: ProviderId, value: string) {
  switch (provider) {
    case 'openai': return { openaiKey: value }
    case 'gemini': return { geminiKey: value }
    case 'anthropic': return { anthropicKey: value }
    default: return {}
  }
}

function ForgeTab() {
  const { secrets, updateSecrets } = useApp()
  const [gh, setGh] = useState<TokenCheck | null>(null)
  const [gl, setGl] = useState<TokenCheck | null>(null)
  const [busy, setBusy] = useState<'gh' | 'gl' | null>(null)

  async function testGitHub() {
    setBusy('gh'); setGh(null)
    try {
      setGh(await new GitHubClient(secrets.githubToken).validateToken())
    } catch (e) {
      setGh({ ok: false, message: String(e) })
    } finally { setBusy(null) }
  }

  async function testGitLab() {
    setBusy('gl'); setGl(null)
    try {
      setGl(await new GitLabClient(secrets.gitlabToken).validateToken())
    } catch (e) {
      setGl({ ok: false, message: String(e) })
    } finally { setBusy(null) }
  }

  return (
    <div className="stack-6">
      <Callout title="Why a token helps">
        Without one, GitHub allows 60 requests an hour — enough for a small repo and
        not much else. A read-only token raises that to 5,000 and unlocks private repos.
      </Callout>

      <Section title="GitHub">
        <div className="stack">
          <Field
            label="Personal access token" id="gh-token"
            hint="Fine-grained token with Contents: read. Classic tokens need the repo scope."
          >
            <SecretInput
              id="gh-token" placeholder="github_pat_… or ghp_…"
              value={secrets.githubToken ?? ''}
              onChange={(v) => void updateSecrets({ githubToken: v })}
            />
          </Field>
          <div className="row">
            <button className="btn" onClick={() => void testGitHub()} disabled={busy === 'gh'}>
              {busy === 'gh' ? 'Checking…' : 'Test connection'}
            </button>
          </div>
          {gh ? <TokenResult check={gh} /> : null}
        </div>
      </Section>

      <Section title="GitLab">
        <div className="stack">
          <Field
            label="Personal access token" id="gl-token"
            hint="Needs the read_api scope. Works for gitlab.com and self-hosted instances."
          >
            <SecretInput
              id="gl-token" placeholder="glpat-…"
              value={secrets.gitlabToken ?? ''}
              onChange={(v) => void updateSecrets({ gitlabToken: v })}
            />
          </Field>
          <div className="row">
            <button className="btn" onClick={() => void testGitLab()} disabled={busy === 'gl'}>
              {busy === 'gl' ? 'Checking…' : 'Test connection'}
            </button>
          </div>
          {gl ? <TokenResult check={gl} /> : null}
        </div>
      </Section>
    </div>
  )
}

function TokenResult({ check }: { check: TokenCheck }) {
  // Quota is reported separately from validity: a token can be perfectly valid
  // and still have too little headroom left to finish a scan.
  const low = check.remaining !== undefined && check.remaining < 200
  return (
    <Callout
      tone={check.ok ? (low ? 'warn' : 'info') : 'err'}
      icon={check.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
    >
      <div className="stack-2">
        <span>{check.message}</span>
        {low ? (
          <span className="dim2">
            That is not much headroom — a medium repository can use several hundred requests.
          </span>
        ) : null}
      </div>
    </Callout>
  )
}

function AppearanceTab() {
  const { settings, updateSettings } = useApp()
  const [cache, setCache] = useState<{ count: number; oldestAgeMs: number | null } | null>(null)

  useEffect(() => { void cacheSummary().then(setCache) }, [])

  return (
    <div className="stack-6">
      <Section title="Theme">
        <div className="segmented" role="group" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              aria-pressed={settings.theme === t}
              onClick={() => void updateSettings({ theme: t })}
            >
              {t}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Cached scans">
        <div className="stack-2">
          <p className="t-body-sm dim">
            A scan result is reused for {Math.round(CACHE_TTL_MS / 60_000)} minutes when the
            commit, provider and model all match — so reopening a report costs nothing.
            Cached results are held in memory only and disappear when Chrome closes.
          </p>
          <p className="t-caption dim2 nums">
            {cache === null
              ? 'Checking…'
              : cache.count === 0
                ? 'Nothing cached.'
                : `${cache.count} cached scan${cache.count === 1 ? '' : 's'} held.`}
          </p>
          <div>
            <button
              className="btn btn--sm"
              disabled={!cache?.count}
              onClick={() => void clearCache().then(() => setCache({ count: 0, oldestAgeMs: null }))}
            >
              Clear cached scans
            </button>
          </div>
        </div>
      </Section>
    </div>
  )
}
