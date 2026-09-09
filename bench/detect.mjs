#!/usr/bin/env node
/**
 * The `--no-llm` half of the benchmark: detection metrics, for free.
 *
 * Candidate coverage, engine accuracy and cold-path share are all decided
 * *before* the model runs, so they cost nothing and can be wired into CI on
 * every push. Candidate coverage is the one to watch first: if a real N+1 never
 * becomes a candidate, no prompt change can recover it, and every other metric
 * is downstream of it.
 *
 *   node bench/detect.mjs --repo mt-test-studio --path ~/src/mt-test-studio
 *
 * Writes `bench/runs/<id>/<sha>/report.json` carrying `candidates`,
 * `engineProfile` and `stats` — the same shape `score.mjs` reads from a real
 * scan, minus the findings, so one scorer serves both.
 *
 * The TypeScript modules are loaded through Vite's SSR pipeline rather than
 * compiled first, so this measures exactly the code the extension ships.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { createServer } from 'vite'
import { aliases } from '../aliases.mjs'

const BENCH = import.meta.dirname
const ROOT = resolve(BENCH, '..')

const argv = process.argv.slice(2)
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)

const id = flag('--repo')
const path = flag('--path')

if (!id || !path) {
  console.error('usage: node bench/detect.mjs --repo <id> --path <local checkout>')
  process.exit(2)
}

const config = JSON.parse(readFileSync(resolve(BENCH, 'repos.json'), 'utf8'))
const repo = config.repos.find((r) => r.id === id)
if (!repo) {
  console.error(`Unknown repo id: ${id}. Known: ${config.repos.map((r) => r.id).join(', ')}`)
  process.exit(2)
}
if (!repo.sha) {
  console.error(`${id} is not pinned. Run \`node bench/pin.mjs --repo ${id}\` first — an unpinned run is not reproducible.`)
  process.exit(2)
}

/* ---- load the shipped modules, not a copy of them ---------------------- */

const server = await createServer({
  root: ROOT,
  configFile: false,
  resolve: { alias: aliases },
  logLevel: 'warn',
  // Only SSR module loading is wanted here. Left to itself Vite discovers every
  // HTML entry in the project — including the store mockups, whose assets do
  // not resolve — and prints a dependency-scan error on every bench run. An
  // error you are trained to ignore is worse than no error.
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
})

const { detectInFileVerbose } = await server.ssrLoadModule('/packages/core/src/core/detect/scan.ts')
const { inferEngines } = await server.ssrLoadModule('/packages/core/src/core/detect/engine-profile.ts')
const { isScannable } = await server.ssrLoadModule('/packages/core/src/core/repo/client.ts')

/* ---- read the checkout, applying the same filter the extension does ---- */

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.venv', '__pycache__'])
const files = []
let unreadable = 0

;(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)

    // `lstat`, not `stat`: a working tree can hold a dangling symlink (a locale
    // alias pointing at a directory that was never checked out is the common
    // case), and following it throws ENOENT and kills the walk. Symlinks are
    // skipped outright — the extension reads a tarball, which has no link to
    // follow, so following one here would measure files the extension never sees.
    let st
    try {
      st = lstatSync(full)
    } catch {
      unreadable++
      continue
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) { walk(full); continue }
    if (!st.isFile()) continue

    const rel = relative(path, full)
    if (!isScannable(rel, st.size)) continue
    try {
      files.push({ path: rel, size: st.size, content: readFileSync(full, 'utf8') })
    } catch {
      unreadable++
    }
  }
})(resolve(path))

console.log(`${files.length} scannable file(s) in ${id}${unreadable ? ` (${unreadable} unreadable, skipped)` : ''}`)

const engineProfile = inferEngines(files)
console.log(`engines: ${engineProfile.declared.map((d) => `${d.engine} (${d.source})`).join(', ') || 'none declared'}`)

let sitesMatched = 0
let belowConfidence = 0
let lowPriority = 0
const truncatedFiles = []
const candidates = []

for (const file of files) {
  const result = detectInFileVerbose(file.path, file.content, { profile: engineProfile })
  sitesMatched += result.matched
  belowConfidence += result.belowConfidence
  lowPriority += result.lowPriority
  if (result.truncation) truncatedFiles.push(result.truncation)
  candidates.push(...result.candidates)
}

await server.close()

const report = {
  _comment: 'Detection-only run (bench/detect.mjs). No model was called, so there are no findings.',
  id: `${repo.sha.slice(0, 8)}-detect`,
  repo: { forge: repo.forge, owner: repo.repo, name: repo.id, ref: repo.sha, commitSha: repo.sha },
  createdAt: new Date().toISOString(),
  provider: 'none',
  model: 'none',
  findings: [],
  rejected: [],
  suppressed: [],
  engineProfile,
  candidates: candidates.map((c) => ({
    file: c.file, startLine: c.startLine, endLine: c.endLine,
    engine: c.engine, accessStyle: c.accessStyle, detector: c.detector,
    confidence: c.confidence, priority: c.priority,
    loopDepth: c.scope?.loopDepth ?? 0, trigger: c.scope?.trigger ?? 'unknown',
  })),
  stats: {
    filesInTree: files.length,
    filesFetched: files.length,
    filesSkipped: unreadable,
    ingest: 'per-file',
    apiCalls: 0,
    candidatesFound: candidates.length,
    sitesMatched,
    sitesAnalysed: candidates.length,
    sitesFiltered: { belowConfidence, lowPriority },
    truncatedFiles,
    chunksAnalysed: 0,
    promptTokens: 0,
    completionTokens: 0,
    chunksReused: 0,
    elapsedMs: 0,
  },
}

const dir = resolve(BENCH, 'runs', id, repo.sha)
mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

const inLoop = candidates.filter((c) => (c.scope?.loopDepth ?? 0) > 0).length
const cold = candidates.filter((c) => c.scope?.trigger === 'migration' || c.scope?.trigger === 'test').length

console.log([
  '',
  `sites matched   ${sitesMatched}`,
  `analysed        ${candidates.length}`,
  `filtered        ${belowConfidence + lowPriority} (confidence ${belowConfidence}, priority ${lowPriority})`,
  `files capped    ${truncatedFiles.length}`,
  `inside a loop   ${inLoop}`,
  `cold path       ${cold}`,
  '',
  `Written to bench/runs/${id}/${repo.sha}/report.json`,
  'Score it with: node bench/score.mjs --repo ' + id + ' --no-llm',
].join('\n'))
