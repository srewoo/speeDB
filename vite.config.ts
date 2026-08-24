import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'node:path'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    target: 'esnext',
    sourcemap: true,
    // Extension pages cannot use crossorigin modulepreload links: Chrome
    // reports a "cross-world extension resource mismatch" and ignores them.
    modulePreload: false,
    rollupOptions: {
      // Static extension pages. Declared as inputs so Vite resolves and
      // processes their stylesheet rather than copying broken links.
      input: {
        help: resolve(__dirname, 'src/pages/help.html'),
        privacy: resolve(__dirname, 'src/pages/privacy.html'),
      },
    },
  },
})
