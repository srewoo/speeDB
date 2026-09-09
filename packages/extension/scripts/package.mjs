#!/usr/bin/env node
/**
 * Package dist/ into a Chrome Web Store upload zip.
 *
 * Uses the system `zip` binary rather than a dependency: adding an archiver
 * package to ship one zip is not worth the supply-chain surface on a tool that
 * handles API keys.
 *
 * Source maps are excluded — they roughly quadruple the upload and the Web
 * Store does not use them. Run with --with-maps to keep them for debugging a
 * packaged build.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')
const outDir = resolve(root, 'release')

const withMaps = process.argv.includes('--with-maps')

if (!existsSync(dist)) {
  console.error('dist/ not found. Run `npm run build` first.')
  process.exit(1)
}

const manifestPath = resolve(dist, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error('dist/manifest.json not found — the build looks incomplete.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const { name, version } = manifest

// The Web Store rejects a manifest whose version is not dot-separated integers.
if (!/^\d+(\.\d+){0,3}$/.test(version ?? '')) {
  console.error(`manifest version "${version}" is not a valid Web Store version.`)
  process.exit(1)
}

// A stray key here would be published to the world.
for (const forbidden of ['key', 'update_url']) {
  if (forbidden in manifest) {
    console.error(`manifest.json contains "${forbidden}" — remove it before publishing.`)
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })
const zipPath = resolve(outDir, `speedb-${version}.zip`)
rmSync(zipPath, { force: true })

const excludes = withMaps ? [] : ['*.map', '*.ts', '*.tsx']

try {
  execFileSync(
    'zip',
    ['-r', '-9', '-q', '-X', zipPath, '.', ...(excludes.length ? ['-x', ...excludes] : [])],
    { cwd: dist, stdio: 'inherit' },
  )
} catch (e) {
  console.error('zip failed. Is the `zip` binary available on PATH?')
  console.error(String(e))
  process.exit(1)
}

const bytes = statSync(zipPath).size
const mb = bytes / 1024 / 1024

console.log(`\n  ${name} ${version}`)
console.log(`  ${zipPath.replace(root + '/', '')}  ${mb.toFixed(2)} MB${withMaps ? '  (with source maps)' : ''}`)

// The Web Store hard limit is 2 GB, but anything approaching a few hundred MB
// signals something unintended got bundled.
if (mb > 100) {
  console.warn('\n  Warning: that is unusually large for an extension. Check what got bundled.')
}
console.log('\n  Upload at https://chrome.google.com/webstore/devconsole\n')
