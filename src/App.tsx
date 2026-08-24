import { useEffect, useState } from 'react'
import { useApp } from '@/store/app-store'
import { ConnectScreen } from '@/components/ConnectScreen'
import { ScanningScreen } from '@/components/ScanningScreen'
import { ReportScreen } from '@/components/ReportScreen'
import { FindingDetail } from '@/components/FindingDetail'
import { SettingsScreen } from '@/components/SettingsScreen'
import { ExportSheet } from '@/components/ExportSheet'
import { Footer } from '@/components/Footer'
import { CostGate } from '@/components/CostGate'
import { IconBack, IconExpand, IconHome, IconSettings } from '@/components/icons'
import '@/styles/app.css'

/**
 * Move to the full-screen tab and dismiss the panel.
 *
 * Order matters: stash the report, then wait for the service worker to confirm
 * the tab exists, and only then close. Closing first tears down the message
 * port before the worker can act on it.
 */
async function expandToTab(handoff: () => Promise<void>): Promise<void> {
  try {
    await handoff()
    await chrome.runtime.sendMessage({ type: 'open-fullscreen' })
  } catch {
    // The tab may still have opened; closing the panel regardless is the
    // behaviour the button promises.
  }
  window.close()
}

export function App({ surface }: { surface: 'panel' | 'fullscreen' }) {
  const { view, report, selectedFindingId, settings } = useApp()
  const { goHome, handoff, hydrate, refreshDetected, setView, selectFinding } = useApp()
  const [exporting, setExporting] = useState(false)
  const [wide, setWide] = useState(() => window.innerWidth >= 900)

  useEffect(() => { void hydrate() }, [hydrate])

  // Theme is applied to the document root so the token blocks resolve.
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', settings.theme)
  }, [settings.theme])

  /**
   * The side panel outlives the page beneath it, so detection has to follow the
   * user as they browse rather than being read once at open. Only the panel
   * subscribes: in the full-screen tab the active tab is this page itself.
   */
  useEffect(() => {
    if (surface !== 'panel' || !chrome.tabs?.onActivated) return

    const onChange = () => { void refreshDetected() }
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo) => {
      // Only when the address actually changed — not on every load-state tick.
      if (change.url) onChange()
    }

    chrome.tabs.onActivated.addListener(onChange)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.windows?.onFocusChanged?.addListener(onChange)
    return () => {
      chrome.tabs.onActivated.removeListener(onChange)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.windows?.onFocusChanged?.removeListener(onChange)
    }
  }, [surface, refreshDetected])

  // The layout is driven by measured width, not by which surface we are in —
  // the side panel is resizable and full screen can be a narrow window.
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const finding = report?.findings.find((f) => f.id === selectedFindingId) ?? null

  return (
    <div className={`app ${surface === 'fullscreen' ? 'fullscreen' : 'density-panel'}`}>
      <header className="app-bar">
        {view === 'settings' ? (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setView(report ? 'report' : 'connect')}
          >
            <IconBack size={14} /> Back
          </button>
        ) : (
          <span className="app-bar__brand">
            <span className="wordmark"><b>spee</b><i>DB</i></span>
          </span>
        )}

        <span className="app-bar__spacer" />

        {/* Disabled mid-scan: Stop is the right control there, and silently
            abandoning a scan that is spending money would be worse than a
            greyed-out button. */}
        <button
          className="btn btn--ghost btn--icon"
          aria-label="Start screen"
          title="Start screen"
          disabled={view === 'scanning' || (view === 'connect' && !report)}
          onClick={goHome}
        >
          <IconHome size={16} />
        </button>

        {view !== 'settings' ? (
          <button
            className="btn btn--ghost btn--icon"
            aria-label="Settings and API keys"
            title="Settings and API keys"
            onClick={() => setView('settings')}
          >
            <IconSettings size={16} />
          </button>
        ) : null}

        {surface === 'panel' ? (
          <button
            className="btn btn--ghost btn--icon"
            aria-label="Open in a full tab"
            title="Open in a full tab"
            onClick={() => { void expandToTab(handoff) }}
          >
            <IconExpand size={16} />
          </button>
        ) : null}
      </header>

      <main className="scroll">
        {view === 'settings' ? <SettingsScreen />
          : view === 'scanning' ? <ScanningScreen />
          : view === 'report' && finding ? (
            <FindingDetail finding={finding} wide={wide} onBack={() => selectFinding(null)} />
          )
          : view === 'report' ? <ReportScreen onOpenExport={() => setExporting(true)} />
          : <ConnectScreen />}
      </main>

      <Footer />

      <CostGate />

      {exporting ? <ExportSheet onClose={() => setExporting(false)} /> : null}
    </div>
  )
}
