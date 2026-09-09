import { create } from 'zustand'
import type { Finding, ScanReport } from '@/core/types'
import type { ScanProgress } from '@/core/pipeline'
import { runScan, type ScanEstimate } from '@/core/pipeline'
import { parseRepoUrl } from '@/core/repo/parse-url'
import { detectFromActiveTab, type DetectedRepo } from '@/core/repo/detect-tab'
import {
  DEFAULT_SETTINGS, keyForProvider, loadSecrets, loadSettings,
  saveSecrets, saveSettings, type Secrets, type Settings,
} from '@/core/settings'

export type View = 'connect' | 'scanning' | 'report' | 'settings'

export interface GroupBy { by: 'severity' | 'file' | 'engine' | 'category' }

export interface Filters {
  query: string
  severities: Set<Finding['severity']>
  kinds: Set<Finding['kind']>
  onlyVerified: boolean
  groupBy: GroupBy['by']
}

interface AppState {
  view: View
  repoUrl: string
  branch: string
  branches: string[]
  recentRepos: { url: string; label: string; at: string }[]
  /** Repository inferred from the tab the user is looking at. */
  detected: DetectedRepo | null

  settings: Settings
  secrets: Secrets
  persistSecrets: boolean

  progress: ScanProgress | null
  /** Set while a scan is paused waiting for the user to approve the cost. */
  pendingEstimate: (ScanEstimate & { resolve: (go: boolean) => void }) | null
  report: ScanReport | null
  selectedFindingId: string | null
  error: { title: string; detail: string; hint?: string } | null

  filters: Filters

  hydrate: () => Promise<void>
  /** Re-read the active tab. Safe to call on any tab or focus change. */
  refreshDetected: () => Promise<void>
  /** Copy the detected repo into the form. */
  useDetected: () => void
  /** Persist the live view so the full-screen tab resumes where the panel was. */
  handoff: () => Promise<void>
  setView: (v: View) => void
  /** Return to the start screen without discarding the current report. */
  goHome: () => void
  setRepoUrl: (url: string) => void
  setBranch: (b: string) => void
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  updateSecrets: (patch: Partial<Secrets>) => Promise<void>
  setPersistSecrets: (persist: boolean) => Promise<void>
  startScan: (opts?: { noCache?: boolean; pullRequest?: number }) => Promise<void>
  cancelScan: () => void
  /** Answer the cost gate. */
  answerEstimate: (proceed: boolean) => void
  selectFinding: (id: string | null) => void
  setFilters: (patch: Partial<Filters>) => void
  dismissError: () => void
}

const ALL_SEVERITIES: Finding['severity'][] = ['critical', 'high', 'medium', 'low', 'info']

const HANDOFF_KEY = 'speedb.handoff'

interface Handoff {
  report: ScanReport | null
  repoUrl: string
  branch: string
  selectedFindingId: string | null
}

let controller: AbortController | null = null

export const useApp = create<AppState>((set, get) => ({
  view: 'connect',
  repoUrl: '',
  branch: '',
  branches: [],
  recentRepos: [],
  detected: null,

  settings: DEFAULT_SETTINGS,
  secrets: {},
  persistSecrets: false,

  progress: null,
  pendingEstimate: null,
  report: null,
  selectedFindingId: null,
  error: null,

  filters: {
    query: '',
    severities: new Set(ALL_SEVERITIES),
    kinds: new Set<Finding['kind']>(['equivalent', 'behavioural']),
    onlyVerified: false,
    groupBy: 'severity',
  },

  async hydrate() {
    const [settings, secrets, stored, handoff] = await Promise.all([
      loadSettings(),
      loadSecrets(),
      chrome.storage.local.get(['speedb.recent', 'speedb.persistSecrets']),
      chrome.storage.session.get(HANDOFF_KEY),
    ])

    set({
      settings,
      secrets,
      recentRepos: (stored['speedb.recent'] as AppState['recentRepos']) ?? [],
      persistSecrets: Boolean(stored['speedb.persistSecrets']),
    })

    void get().refreshDetected()

    // A report handed over from the side panel. Consumed once and cleared, so
    // reopening the tab later starts clean rather than resurrecting a stale scan.
    const pending = handoff[HANDOFF_KEY] as Handoff | undefined
    if (pending) {
      await chrome.storage.session.remove(HANDOFF_KEY)
      set({
        report: pending.report,
        repoUrl: pending.repoUrl,
        branch: pending.branch,
        selectedFindingId: pending.selectedFindingId,
        view: pending.report ? 'report' : 'connect',
      })
    }
  },

  async refreshDetected() {
    const detected = await detectFromActiveTab()
    const { repoUrl, detected: previous } = get()

    set({ detected })
    if (!detected) return

    // Pre-fill only when there is nothing to lose: an empty field, or a value
    // this same mechanism put there. Never overwrite something typed or pasted.
    const fieldIsOurs = repoUrl === '' || (previous !== null && repoUrl === previous.url)
    if (fieldIsOurs) {
      set({ repoUrl: detected.url, branch: detected.ref ?? '' })
    }
  },

  useDetected() {
    const { detected } = get()
    if (!detected) return
    set({ repoUrl: detected.url, branch: detected.ref ?? '', error: null })
  },

  async handoff() {
    const { report, repoUrl, branch, selectedFindingId } = get()
    // Nothing worth carrying, and session storage has a quota worth respecting.
    if (!report) return
    try {
      await chrome.storage.session.set({
        [HANDOFF_KEY]: { report, repoUrl, branch, selectedFindingId } satisfies Handoff,
      })
    } catch {
      // Over quota on a very large report. Losing the handoff is survivable —
      // the tab just opens on the connect screen — so never block the open.
    }
  },

  setView: (view) => set({ view }),

  goHome: () => set({ view: 'connect', selectedFindingId: null, error: null }),
  setRepoUrl: (repoUrl) => set({ repoUrl, error: null }),
  setBranch: (branch) => set({ branch }),

  async updateSettings(patch) {
    set({ settings: await saveSettings(patch) })
  },

  async updateSecrets(patch) {
    set({ secrets: await saveSecrets(patch, get().persistSecrets) })
  },

  async setPersistSecrets(persist) {
    await chrome.storage.local.set({ 'speedb.persistSecrets': persist })
    // Re-save so the keys move to the correct storage area immediately.
    set({ persistSecrets: persist, secrets: await saveSecrets(get().secrets, persist) })
  },

  async startScan(scanOpts) {
    const { repoUrl, branch, settings, secrets } = get()
    const parsed = parseRepoUrl(repoUrl)

    if ('error' in parsed) {
      set({ error: { title: 'That repository URL did not parse', detail: parsed.error } })
      return
    }

    const apiKey = keyForProvider(settings.provider, secrets)
    if (settings.provider !== 'chrome' && !apiKey) {
      set({
        error: {
          title: `No ${settings.provider} API key`,
          detail: 'This provider needs a key before it can analyse anything.',
          hint: 'Add one in Settings, or switch to Chrome built-in AI to keep everything on-device.',
        },
        view: 'settings',
      })
      return
    }

    controller = new AbortController()
    set({ view: 'scanning', error: null, report: null, progress: null, selectedFindingId: null })

    try {
      const report = await runScan(parsed, {
        provider: settings.provider,
        model: settings.model,
        apiKey,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        tokenBudget: settings.scanTokenBudget,
        // Small on purpose. Measured: 290 sites in one pass found 0 of 3 known
        // N+1s; 20 found 2 of 3. See DEFAULTS.sitesPerPass.
        maxCandidatesPerChunk: settings.sitesPerPass ?? DEFAULT_SETTINGS.sitesPerPass,
        // Sampled triage is the default, not an opt-in. It is the largest
        // measured precision effect available and costs less than one
        // authoring request. See DEFAULTS.triageSamples.
        triageSamples: settings.triageSamples ?? DEFAULT_SETTINGS.triageSamples,
        githubToken: secrets.githubToken,
        gitlabToken: secrets.gitlabToken,
        ref: branch || undefined,
        pullRequest: scanOpts?.pullRequest,
        signal: controller.signal,
        noCache: scanOpts?.noCache ?? false,
        onProgress: (progress) => set({ progress }),
        // Only gate when there is something to decide: free on-device runs and
        // scans that are entirely cache hits should not interrupt anyone.
        onEstimate: (estimate) => {
          if (estimate.cost.free) return true
          if (estimate.passes - estimate.cachedPasses === 0) return true
          return new Promise<boolean>((resolve) => set({ pendingEstimate: { ...estimate, resolve } }))
        },
      })

      const recent = [
        { url: repoUrl, label: `${report.repo.owner}/${report.repo.name}`, at: new Date().toISOString() },
        ...get().recentRepos.filter((r) => r.url !== repoUrl),
      ].slice(0, 8)
      await chrome.storage.local.set({ 'speedb.recent': recent })

      set({ report, recentRepos: recent, view: 'report' })
    } catch (e) {
      const err = e as { message?: string; kind?: string }
      if (err.kind === 'cancelled') {
        set({ view: 'connect', progress: null })
        return
      }
      set({
        view: 'connect',
        progress: null,
        error: {
          title: titleForError(err.kind),
          detail: err.message ?? String(e),
          hint: hintForError(err.kind),
        },
      })
    } finally {
      controller = null
    }
  },

  cancelScan() {
    controller?.abort()
    // A scan paused at the cost gate is not inside a fetch, so aborting alone
    // would leave it waiting forever.
    get().pendingEstimate?.resolve(false)
    set({ pendingEstimate: null })
  },

  answerEstimate(proceed) {
    get().pendingEstimate?.resolve(proceed)
    set({ pendingEstimate: null })
  },

  selectFinding: (selectedFindingId) => set({ selectedFindingId }),

  setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),

  dismissError: () => set({ error: null }),
}))

function titleForError(kind?: string): string {
  switch (kind) {
    case 'auth': return 'Credentials were rejected'
    case 'rate-limit': return 'Rate limited'
    case 'not-found': return 'Repository not found'
    case 'too-large': return 'Repository is too large'
    case 'timeout': return 'The forge stopped responding'
    case 'unavailable': return 'That AI provider is not available'
    case 'refusal': return 'The model declined to analyse this'
    case 'network': return 'Could not reach the network'
    default: return 'The scan could not finish'
  }
}

function hintForError(kind?: string): string | undefined {
  switch (kind) {
    case 'auth': return 'Check the token in Settings — it may be expired or missing a scope.'
    case 'rate-limit': return 'Adding a personal access token in Settings raises the limit substantially.'
    case 'not-found': return 'Private repositories need a token with read access.'
    case 'too-large': return 'Try scanning a specific branch, or a smaller repository.'
    case 'timeout': return 'Requests are timing out after 30 seconds. Check your connection, then try again — cached progress is not kept, so the scan restarts.'
    case 'unavailable': return 'Chrome built-in AI needs Chrome 138+ with the on-device model downloaded.'
    default: return undefined
  }
}

/** Selector: findings after the current filters, ready to group. */
export function visibleFindings(state: AppState): Finding[] {
  const { report, filters } = state
  if (!report) return []
  const q = filters.query.trim().toLowerCase()

  return report.findings.filter((f) => {
    if (!filters.severities.has(f.severity)) return false
    if (!filters.kinds.has(f.kind)) return false
    if (filters.onlyVerified && f.grounding !== 'verified') return false
    if (!q) return true
    return (
      f.title.toLowerCase().includes(q) ||
      f.summary.toLowerCase().includes(q) ||
      f.primaryOccurrence.file.toLowerCase().includes(q) ||
      f.original.toLowerCase().includes(q)
    )
  })
}

export function groupFindings(findings: Finding[], by: Filters['groupBy']): [string, Finding[]][] {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    const key =
      by === 'file' ? f.primaryOccurrence.file
      : by === 'engine' ? f.engine
      : by === 'category' ? f.category
      : f.severity
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }
  if (by === 'severity') {
    const order = ALL_SEVERITIES
    return [...groups.entries()].sort(
      (a, b) => order.indexOf(a[0] as Finding['severity']) - order.indexOf(b[0] as Finding['severity']),
    )
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
}
