import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/** Preview-only build: the CRX plugin is omitted so this runs as a plain page. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: { outDir: 'dist-preview', sourcemap: true, rollupOptions: { input: resolve(__dirname, 'preview.html') } },
})
