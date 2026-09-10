import { useApp } from '@/store/app-store'
import { IconInfo, IconSettings, IconShield } from './icons'

/**
 * Persistent footer. Help and the privacy policy are extension pages rather
 * than external links, so they work offline and cannot be swapped out from
 * under the user.
 */
/**
 * The running build's version, read from the manifest.
 *
 * This used to be the literal `v0.1.0`, which stayed put while the package
 * moved to 1.2.0 — so the panel misreported itself, and the one number a user
 * needs in order to know whether their build contains a fix was wrong. The
 * manifest takes its version from package.json (see manifest.config.ts), so
 * reading it here means there is no second place to remember on a release.
 *
 * Undefined outside an extension context — the preview build renders these
 * components in a plain page — in which case no version is shown at all,
 * rather than a made-up one.
 */
function useVersion(): string | undefined {
  return chrome.runtime?.getManifest?.()?.version
}

export function Footer() {
  const setView = useApp((s) => s.setView)
  const version = useVersion()

  function open(page: 'help' | 'privacy') {
    const url = chrome.runtime?.getURL?.(`src/pages/${page}.html`) ?? `../pages/${page}.html`
    if (chrome.tabs?.create) chrome.tabs.create({ url })
    else window.open(url, '_blank', 'noopener')
  }

  return (
    <footer className="app-footer">
      <button className="link-btn" onClick={() => open('help')}>
        <IconInfo size={13} /> Help
      </button>
      <button className="link-btn" onClick={() => open('privacy')}>
        <IconShield size={13} /> Privacy
      </button>
      <button className="link-btn" onClick={() => setView('settings')}>
        <IconSettings size={13} /> Settings
      </button>
      <span className="spacer" />
      {version && <span className="app-footer__version">v{version}</span>}
    </footer>
  )
}
