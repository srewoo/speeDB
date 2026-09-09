/**
 * Standalone preview harness. Renders the real components against a fixture so
 * the UI can be reviewed (and screenshotted) without loading the extension.
 * The chrome.* surface the store touches is stubbed in memory.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/App'
import { useApp } from '@/store/app-store'
import { DEFAULT_SETTINGS } from '@/core/settings'
import { MOCK_REPORT } from './mock'

const memory: Record<string, unknown> = {}
const area = {
  get: async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    return Object.fromEntries(keys.map((key) => [key, memory[key]]))
  },
  set: async (obj: Record<string, unknown>) => { Object.assign(memory, obj) },
  remove: async (k: string) => { delete memory[k] },
}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area, session: area },
  runtime: { sendMessage: async () => undefined, getURL: (p: string) => p },
  permissions: { request: async () => true },
  tabs: {
    query: async () => [{ url: params.get('tab') ?? '' }],
    create: () => undefined,
    onActivated: { addListener: () => undefined, removeListener: () => undefined },
    onUpdated: { addListener: () => undefined, removeListener: () => undefined },
  },
  windows: {
    update: () => undefined,
    onFocusChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
}

const params = new URLSearchParams(location.search)
const screen = params.get('screen') ?? 'report'

// Seeded into the stubbed storage rather than pushed into the store, because
// App re-hydrates on mount and would otherwise clobber a direct setState.
memory['speedb.settings'] = {
  ...DEFAULT_SETTINGS,
  theme: (params.get('theme') as 'light' | 'dark' | null) ?? 'system',
  provider: (params.get('provider') as typeof DEFAULT_SETTINGS.provider) ?? DEFAULT_SETTINGS.provider,
  model: params.get('model') ?? DEFAULT_SETTINGS.model,
}

void useApp.getState().hydrate().then(() => {
  useApp.setState({
    report: params.get('cached')
      ? { ...MOCK_REPORT, cache: { storedAt: Date.now() - 7 * 60_000, expiresInMs: 53 * 60_000 } }
      : MOCK_REPORT,
    repoUrl: params.get('screen') === 'connect' ? '' : 'https://gitlab.com/mindtickle/migrated-call-ai/access-control',
    view: screen === 'connect' ? 'connect' : screen === 'settings' ? 'settings' : 'report',
    selectedFindingId: screen === 'detail' ? 'f1' : null,
    recentRepos: [
      { url: 'https://github.com/vercel/next.js', label: 'vercel/next.js', at: new Date(Date.now() - 3.6e6).toISOString() },
      { url: 'https://gitlab.com/mindtickle/migrated-call-ai/access-control', label: 'mindtickle/access-control', at: new Date(Date.now() - 8.6e7).toISOString() },
    ],
  })
  if (screen === 'scanning') {
    useApp.setState({
      view: 'scanning',
      progress: {
        phase: 'analysing', message: 'Analysed pass 4 of 6…', fraction: 4 / 6,
        filesFetched: 268, filesSkipped: 3, candidatesFound: 47, chunksAnalysed: 4, chunksTotal: 6,
        tokensUsed: 121_480,
      },
    })
  }
})

// Exposed so a browser-driven test can run a real scan against the *bundled*
// code. Module-initialisation problems only appear after bundling, so testing
// the source in Node is not the same thing as testing what ships.
;(window as unknown as { __speedb: unknown }).__speedb = useApp

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App surface={params.get('surface') === 'panel' ? 'panel' : 'fullscreen'} />
  </StrictMode>,
)
