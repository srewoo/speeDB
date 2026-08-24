/**
 * MV3 service worker.
 *
 * Deliberately thin. The scan itself runs in the side panel / full-screen page,
 * not here: a service worker is killed after ~30s of inactivity, and a repo
 * scan is a minutes-long job with an AbortController the UI owns. Putting the
 * pipeline here would mean losing scans mid-flight.
 *
 * What lives here: the toolbar click behaviour, the full-screen tab opener,
 * and one-time install setup.
 */

chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the side panel rather than a popup.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e: unknown) => console.error('[speeDB] could not set panel behaviour', e))
})

type Message = { type: 'open-fullscreen'; reportId?: string }

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'open-fullscreen') {
    const url = chrome.runtime.getURL(
      `src/fullscreen/index.html${message.reportId ? `?report=${encodeURIComponent(message.reportId)}` : ''}`,
    )
    // Reuse an existing full-screen tab instead of stacking duplicates.
    chrome.tabs.query({ url: `${chrome.runtime.getURL('src/fullscreen/index.html')}*` }, (tabs) => {
      const existing = tabs[0]
      if (existing?.id !== undefined) {
        chrome.tabs.update(existing.id, { active: true, url })
        if (existing.windowId !== undefined) chrome.windows.update(existing.windowId, { focused: true })
      } else {
        chrome.tabs.create({ url })
      }
      sendResponse({ ok: true })
    })
    return true // keep the message channel open for the async response
  }
  return false
})
