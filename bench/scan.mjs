#!/usr/bin/env node
/**
 * Drive a full speeDB scan headlessly and write it into `bench/runs/`.
 *
 * Getting a scan into the benchmark used to mean opening the extension,
 * scanning, and exporting JSON by hand — which is fine once and hopeless as a
 * repeatable measurement. This runs the same `runScan()` the extension runs,
 * against the pinned commit, and writes both the report and the markdown.
 *
 *   ANTHROPIC_API_KEY=... node bench/scan.mjs --repo spring-petclinic
 *   node bench/scan.mjs --repo spring-petclinic --stub
 *
 * `--stub` needs no key. It injects a provider that returns `{"findings":[]}`
 * and exercises everything else for real: the forge archive request, the tar
 * reader, the engine profile, detection, chunking, grounding, the value gate
 * and the exporters. That is the whole pipeline bar one HTTP call, which makes
 * it the cheapest useful end-to-end check there is.
 *
 * Temperature is pinned to 0 and the cache is bypassed, because two scans that
 * are not comparable are worse than one.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { execSync } from 'node:child_process'
import { createServer } from 'vite'

/**
 * Read `.env` before anything looks at `process.env`.
 *
 * Hand-rolled rather than a dependency: this needs to handle `KEY=value`,
 * comments and blank lines, and nothing else. `.env` is gitignored.
 */
function loadDotenv(dir) {
  const file = resolve(dir, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    // A real environment variable always wins over the file.
    if (!(key in process.env) && value) process.env[key] = value
  }
}

const BENCH = import.meta.dirname
const ROOT = resolve(BENCH, '..')

loadDotenv(ROOT)

const argv = process.argv.slice(2)
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)
const has = (n) => argv.includes(n)

const id = flag('--repo')
const stub = has('--stub')
/**
 * Scan a local checkout instead of fetching from the forge.
 *
 * This is what makes a private repository scannable without handing the harness
 * a forge token: the files are already on disk. It is also faster and kinder to
 * rate limits on the public ones. The checkout must be at the pinned SHA — that
 * is asserted below rather than assumed, because a benchmark run against the
 * wrong tree is worse than no run.
 */
const localPath = flag('--path')

if (!id) {
  console.error('usage: node bench/scan.mjs --repo <id> [--path <checkout>] [--provider p] [--model m] [--stub]')
  process.exit(2)
}

const config = JSON.parse(readFileSync(resolve(BENCH, 'repos.json'), 'utf8'))
const repo = config.repos.find((r) => r.id === id)
if (!repo) {
  console.error(`Unknown repo id: ${id}. Known: ${config.repos.map((r) => r.id).join(', ')}`)
  process.exit(2)
}
if (!repo.sha) {
  console.error(`${id} is not pinned. Run \`node bench/pin.mjs --repo ${id}\` first.`)
  process.exit(2)
}

const KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
}
const DEFAULT_MODEL = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.1-mini',
  gemini: 'gemini-3-pro',
}

/**
 * Provider is chosen explicitly, or inferred from whichever key is present —
 * there is no point defaulting to Anthropic when the only key in `.env` is
 * OpenAI's.
 */
const provider = flag('--provider')
  ?? (Object.keys(KEYS).find((k) => KEYS[k]) ?? 'anthropic')

/**
 * Model id, in order: the flag, then `<PROVIDER>_MODEL` from the environment,
 * then the registry default. Ids are lower-cased because every provider's are:
 * `GPT-5.4-mini` is a 404, `gpt-5.4-mini` is a model.
 */
const model = (
  flag('--model')
  ?? process.env[`${provider.toUpperCase()}_MODEL`]
  ?? DEFAULT_MODEL[provider]
  ?? 'claude-sonnet-5'
).toLowerCase()

/**
 * Output ceiling per pass. The registry default is 8k, which is tight when one
 * pass covers several hundred query sites — the response gets truncated and
 * `repairTruncated` salvages only the findings that had already closed. Raised
 * here so a benchmark measures the model's judgement rather than its budget.
 */
const maxOutputTokens = Number(flag('--max-output') ?? 16_000)

/**
 * Token ceiling for the whole scan.
 *
 * Defaults high so a benchmark run is not silently truncated. Pass the
 * extension's own default (`--budget 400000`) to see what a user actually gets
 * on a large repository — on Discourse that is the difference between 11,046
 * queued sites and the few thousand the budget reaches.
 */
const tokenBudget = Number(flag('--budget') ?? 2_000_000)

/** Analyse only the top-N candidates by priority. */
const maxCandidates = flag('--top') ? Number(flag('--top')) : undefined
/** Analysis strategy: `two-stage` (default) or `single-shot`, for A/B. */
const analysis = flag('--analysis') ?? undefined
const triageSitesPerPass = flag('--triage-per-pass') ? Number(flag('--triage-per-pass')) : undefined
const authorSitesPerRequest = flag('--author-per-request') ? Number(flag('--author-per-request')) : undefined
const triageSamples = flag('--triage-samples') ? Number(flag('--triage-samples')) : undefined

/** Priority floor, the counterpart to the confidence floor. */
const minPriority = flag('--min-priority') ? Number(flag('--min-priority')) : undefined
const keepAtLeast = flag('--keep-at-least') ? Number(flag('--keep-at-least')) : 25
/**
 * Cap sites per analysis pass.
 *
 * Defaults to whatever the extension ships, not to "unbounded" — the harness
 * exists to measure the product, and a `--top 120` run silently packed all 120
 * into one pass because this was left undefined, which is not what a user gets.
 * Resolved from the registry below, after the modules load.
 */
const chunkFlag = flag('--chunk') ? Number(flag('--chunk')) : undefined

const apiKey = KEYS[provider]

if (!stub && !apiKey) {
  console.error(
    `No key for ${provider}. Set ${provider.toUpperCase()}_API_KEY, or pass --stub to exercise ` +
    'every stage except the model call.',
  )
  process.exit(2)
}

/*
 * The extension stores the scan cache and session secrets in `chrome.storage`.
 * There is no such thing in Node, so it is stubbed in memory — and `--no-cache`
 * is set anyway, so nothing here is load-bearing beyond not throwing.
 */
const memory = {}
const area = () => ({
  get: async (k) => ({ [k]: memory[k] }),
  set: async (o) => { Object.assign(memory, o) },
  remove: async (k) => { delete memory[k] },
})
globalThis.chrome = { storage: { session: area(), local: area() } }

const server = await createServer({
  root: ROOT,
  configFile: false,
  resolve: { alias: { '@': resolve(ROOT, 'src') } },
  logLevel: 'warn',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
})

const { runScan } = await server.ssrLoadModule('/src/core/pipeline.ts')
const { exportReport } = await server.ssrLoadModule('/src/core/report/export.ts')
const { DEFAULTS } = await server.ssrLoadModule('/src/config/models.ts')

const maxCandidatesPerChunk = chunkFlag ?? DEFAULTS.sitesPerPass

const parsed = repo.forge === 'gitlab'
  ? { forge: 'gitlab', apiOrigin: 'https://gitlab.com/api', owner: dirOf(repo.repo), name: baseOf(repo.repo) }
  : { forge: 'github', apiOrigin: 'https://api.github.com', owner: dirOf(repo.repo), name: baseOf(repo.repo) }

function dirOf(slug) { return slug.slice(0, slug.lastIndexOf('/')) }
function baseOf(slug) { return slug.slice(slug.lastIndexOf('/') + 1) }

/**
 * A RepoClient backed by a directory on disk.
 *
 * Implements the same four methods the real clients do, so `runScan` cannot
 * tell the difference — which is the point: the pipeline under test is the
 * shipped one, and only the source of the bytes changes.
 */
function localClient(root, repo) {
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.venv', '__pycache__', 'target'])
  const files = []
  let unreadable = 0

  ;(function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const full = join(dir, entry)
      let st
      try { st = lstatSync(full) } catch { unreadable++; continue }
      // Symlinks are skipped: a tarball has no link to follow, and a dangling
      // one (a locale alias never checked out) throws ENOENT on stat.
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(full); continue }
      if (!st.isFile()) continue
      files.push({ path: relative(root, full), size: st.size, full })
    }
  })(resolve(root))

  const ref = {
    forge: repo.forge,
    apiOrigin: 'file://',
    owner: dirOf(repo.repo),
    name: baseOf(repo.repo),
    ref: repo.sha,
    commitSha: repo.sha,
  }

  return {
    resolve: async () => ref,
    listBranches: async () => ['main'],
    listChangedFiles: async () => null,
    listFiles: async () => files.map((f) => ({ path: f.path, size: f.size })),
    readFile: async (_r, path) => {
      const hit = files.find((f) => f.path === path)
      if (!hit) throw new Error(`not in checkout: ${path}`)
      return readFileSync(hit.full, 'utf8')
    },
    fetchArchive: async (_r, ctx) => {
      const accept = ctx?.accept ?? (() => true)
      const out = []
      for (const f of files) {
        if (!accept(f.path, f.size)) continue
        try {
          out.push({ path: f.path, size: f.size, content: readFileSync(f.full, 'utf8') })
        } catch { unreadable++ }
      }
      ctx?.onProgress?.(0, out.length)
      return { files: out, truncated: false }
    },
    unreadable: () => unreadable,
  }
}

/** A provider that answers "nothing to report" — the honest empty response. */
const stubProvider = {
  isAvailable: async () => ({ ok: true }),
  // Answers whichever stage it is asked about: every site clean, no findings.
  // Exercises the full two-stage wiring without a key.
  complete: async ({ system, user }) => {
    if (/triaging query sites/.test(system)) {
      const ids = [...user.matchAll(/^## id: (.+)$/gm)].map((m) => m[1])
      return {
        text: JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: 'clean', category: 'other', why: 'stub' })) }),
        promptTokens: 0, completionTokens: 0,
      }
    }
    return { text: JSON.stringify({ findings: [] }), promptTokens: 0, completionTokens: 0 }
  },
}

let lastPhase = ''
let lastPass = -1
const started = Date.now()

/*
 * Candidate coverage is the metric that isolates detection from the model, and
 * it cannot be recovered from a finished report — the report holds only what the
 * model chose to say. So the candidate set is captured as it is handed over.
 */
let candidates = []

let client
if (localPath) {
  if (!existsSync(localPath)) {
    console.error(`No such checkout: ${localPath}`)
    process.exit(2)
  }
  // Assert the checkout is at the pinned commit. A run against the wrong tree
  // scores something real against a truth file that describes something else.
  try {
    const head = execSync('git rev-parse HEAD', { cwd: localPath, encoding: 'utf8' }).trim()
    if (head !== repo.sha) {
      console.error(
        `Checkout is at ${head.slice(0, 10)} but ${id} is pinned to ${repo.sha.slice(0, 10)}.\n` +
        `Run:  git -C ${localPath} checkout ${repo.sha}\n` +
        'or re-pin and re-audit. A run against the wrong tree is worse than no run.',
      )
      process.exit(2)
    }
  } catch (e) {
    if (e?.status === 2 || String(e?.message ?? '').includes('pinned to')) throw e
    console.warn(`! could not read HEAD in ${localPath} — proceeding, but this run is unverifiable.`)
  }
  client = localClient(localPath, repo)
  console.log(`reading ${id} from ${localPath} (no forge token needed)`)
}

try {
  const report = await runScan(parsed, {
    provider: stub ? 'anthropic' : provider,
    model,
    apiKey: apiKey ?? 'stub',
    temperature: 0,
    maxOutputTokens,
    tokenBudget,
    ref: repo.sha,
    noCache: true,
    analysis,
    triageSitesPerPass,
    authorSitesPerRequest,
    triageSamples,
    maxCandidates,
    minPriority,
    keepAtLeast,
    maxCandidatesPerChunk,
    githubToken: process.env.GITHUB_TOKEN,
    gitlabToken: process.env.GITLAB_TOKEN,
    deps: {
      ...(stub ? { provider: stubProvider } : {}),
      ...(client ? { client } : {}),
    },
    onCandidates: (c) => {
      candidates = c.map((x) => ({
        file: x.file, startLine: x.startLine, endLine: x.endLine,
        engine: x.engine, accessStyle: x.accessStyle, detector: x.detector,
        confidence: x.confidence, priority: x.priority,
        loopDepth: x.scope?.loopDepth ?? 0, trigger: x.scope?.trigger ?? 'unknown',
      }))
    },
    onProgress: (p) => {
      const at = `[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s]`
      if (p.phase !== lastPhase) {
        lastPhase = p.phase
        console.log(`${at} ${p.phase}: ${p.message}`)
      } else if (p.phase === 'analysing' && p.chunksAnalysed !== lastPass) {
        // A 35-pass scan that prints one line on entry and nothing for twenty
        // minutes is indistinguishable from a hang.
        lastPass = p.chunksAnalysed
        console.log(`${at} pass ${p.chunksAnalysed} of ${p.chunksTotal} · ${p.tokensUsed.toLocaleString()} tokens`)
      }
    },
    onEstimate: (e) => {
      const usd = e.cost.usd === null ? 'no list price' : `$${e.cost.usd.toFixed(2)}`
      console.log(`\nestimate: ${e.candidates} sites, ${e.passes} passes (${e.cachedPasses} cached), ${usd}`)
      if (stub) console.log('(stub run — nothing is spent)')
      return true
    },
  })

  /*
   * Runs accumulate; they do not overwrite.
   *
   * A single run cannot distinguish a configuration effect from run-to-run
   * variance, and this harness spent a whole session overwriting `report.json`
   * and then reasoning about one sample as though it were the answer. Each run
   * lands in its own numbered directory and `score.mjs` reports the spread.
   */
  const base = resolve(BENCH, 'runs', id, repo.sha)
  mkdirSync(base, { recursive: true })
  let n = 1
  while (existsSync(resolve(base, `run-${n}`))) n++
  const dir = resolve(base, `run-${n}`)
  mkdirSync(dir, { recursive: true })

  writeFileSync(resolve(dir, 'report.json'), `${JSON.stringify({ ...report, candidates }, null, 2)}\n`)
  writeFileSync(resolve(dir, 'speedb.md'), exportReport(report, 'markdown').content)
  writeFileSync(resolve(dir, 'config.json'), `${JSON.stringify({
    provider, model, temperature: 0, maxOutputTokens, tokenBudget,
    analysis: analysis ?? 'two-stage',
    triageSitesPerPass: triageSitesPerPass ?? null,
    authorSitesPerRequest: authorSitesPerRequest ?? null,
    triageSamples: triageSamples ?? null,
    maxCandidates: maxCandidates ?? null,
    minPriority: minPriority ?? null,
    maxCandidatesPerChunk,
    stub,
  }, null, 2)}\n`)

  const s = report.stats
  console.log([
    '',
    `files read      ${s.filesFetched}${s.filesSkipped ? ` (${s.filesSkipped} skipped)` : ''}`,
    `sites matched   ${s.sitesMatched}`,
    `analysed        ${s.sitesAnalysed}`,
    `filtered        ${s.sitesFiltered.belowConfidence + s.sitesFiltered.lowPriority}`,
    `files capped    ${s.truncatedFiles.length}`,
    `engines         ${(report.engineProfile?.declared ?? []).map((d) => d.engine).join(', ') || 'none declared'}` +
      `${report.engineProfile?.ambiguous ? ' (ambiguous)' : ''}`,
    `passes          ${s.chunksAnalysed}`,
    `tokens          ${s.promptTokens} in / ${s.completionTokens} out`,
    `published       ${report.findings.length}`,
    `suppressed      ${report.suppressed.length}`,
    `rejected        ${report.rejected.length}`,
    '',
    `Written to bench/runs/${id}/${repo.sha}/run-${n}/{report.json,speedb.md,config.json}`,
    `Score it with: node bench/score.mjs --repo ${id}`,
  ].join('\n'))
} finally {
  await server.close()
}
