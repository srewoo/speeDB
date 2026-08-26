import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'speeDB — grounded DB query optimiser',
  short_name: 'speeDB',
  version: pkg.version,
  description:
    'Scan any GitHub or GitLab repo for database queries and get grounded, output-identical optimisations.',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: 'Open speeDB',
    default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
  },
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  options_page: 'src/fullscreen/index.html',
  // `storage`  — persist settings, cached scans, and (session-scoped) API keys.
  // `sidePanel`— the primary surface.
  // `tabs`     — open the full-screen view and read the active tab URL to prefill the repo field.
  permissions: ['storage', 'sidePanel', 'tabs'],
  // Forge APIs are required — the product does nothing without them.
  // `codeload.github.com` is not optional and not cosmetic: the tarball endpoint
  // on `api.github.com` answers with a 302 to codeload, and a redirect to an
  // ungranted host is a CORS failure. Without it every GitHub scan fell back to
  // one request per file — the 2,000-call path the single-archive design exists
  // to avoid — and the fallback was silent, so the fast path had never actually
  // run in the extension.
  host_permissions: [
    'https://api.github.com/*',
    'https://codeload.github.com/*',
    'https://gitlab.com/api/*',
  ],
  // Cloud LLM hosts are OPTIONAL and requested only when the user selects that
  // provider. Sending source code off-device is therefore an explicit, revocable
  // grant rather than something the install silently authorises — and the
  // Chrome built-in AI path never triggers a prompt at all.
  // Self-hosted GitLab is here for the same reason: the user names the host.
  optional_host_permissions: [
    'https://api.openai.com/*',
    'https://generativelanguage.googleapis.com/*',
    'https://api.anthropic.com/*',
    'https://*/*',
  ],
  // Help and the privacy policy ship inside the extension so they work offline
  // and cannot be swapped for different content after review. They are opened
  // as extension pages, which needs no web_accessible_resources grant — adding
  // one would expose them to every website for no benefit.
  minimum_chrome_version: '124',
})
