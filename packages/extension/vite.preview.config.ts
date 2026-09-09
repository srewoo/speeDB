import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { aliases } from '../../aliases.mjs'

/** Preview-only build: the CRX plugin is omitted so this runs as a plain page. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: aliases },
  build: { outDir: 'dist-preview', sourcemap: true, rollupOptions: { input: resolve(__dirname, 'preview.html') } },
})
