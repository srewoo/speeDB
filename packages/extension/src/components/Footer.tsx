import { useApp } from '@/store/app-store'
import { IconInfo, IconSettings, IconShield } from './icons'

/**
 * Persistent footer. Help and the privacy policy are extension pages rather
 * than external links, so they work offline and cannot be swapped out from
 * under the user.
 */
export function Footer() {
  const setView = useApp((s) => s.setView)

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
      <span className="app-footer__version">v0.1.0</span>
    </footer>
  )
}
