#!/usr/bin/env node
/**
 * Reconciliation and scoring for the five-repo benchmark.
 *
 * A fix is only real if it moves a number. This computes the numbers, writes
 * `bench/results/<date>.md`, and exits non-zero when a gate in `repos.json`
 * fails — so a regression shows up in a diff rather than in a conversation.
 *
 *   node bench/score.mjs                       score every pinned repo
 *   node bench/score.mjs --repo mt-test-studio  one repo
 *   node bench/score.mjs --no-llm               detection-only metrics
 *
 * Inputs, per repo and SHA:
 *   bench/runs/<id>/<sha>/report.json   a speeDB ScanReport (exported as JSON)
 *   bench/truth/<id>/<sha>.json         the Claude audit, human-adjudicated
 *
 * Matching is by (file, line ± LINE_TOLERANCE). An unmatched speeDB finding is
 * a false positive; an unmatched truth entry at `high` or above is a miss.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '..')
const BENCH = resolve(ROOT, 'bench')

/** Models are routinely off by one or two lines; three is generous, not lax. */
const LINE_TOLERANCE = 3

const argv = process.argv.slice(2)
const only = flag('--repo')
const noLlm = argv.includes('--no-llm')

function flag(name) {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}

/*
 * The direction and data-access checks are the *shipped* readers, loaded through
 * Vite's SSR pipeline rather than reimplemented here. A benchmark that scores
 * itself with a second, looser copy of the logic is measuring the copy.
 */
const server = await createServer({
  root: ROOT,
  configFile: false,
  resolve: { alias: { '@': resolve(ROOT, 'src') } },
  logLevel: 'silent',
  // Only SSR module loading is wanted here. Left to itself Vite discovers every
  // HTML entry in the project — including the store mockups, whose assets do
  // not resolve — and prints a dependency-scan error on every bench run. An
  // error you are trained to ignore is worse than no error.
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
})
const { readOrmShape } = await server.ssrLoadModule('/src/core/analyze/orm-shape.ts')
const { readSqlShape } = await server.ssrLoadModule('/src/core/analyze/sql-shape.ts')

const config = JSON.parse(readFileSync(resolve(BENCH, 'repos.json'), 'utf8'))
const targets = config.repos.filter((r) => (only ? r.id === only : true))

if (targets.length === 0) {
  console.error(`No repo matches --repo ${only}. Known: ${config.repos.map((r) => r.id).join(', ')}`)
  process.exit(2)
}

const ROUND_TRIP = new Set(['round-trip', 'n-plus-one', 'batching'])

/**
 * Precision from a finding-level adjudication, when one covers this run.
 *
 * `real-cold` counts as real: a genuine N+1 in a test is a correct observation
 * about the code, and the tool already rates it `info`. `marginal` does not
 * count — a finding the adjudicator could not defend is not one to claim.
 */
function adjudicatedPrecision(adjudication, runPath, report) {
  if (!adjudication) return null
  // Only for the run it was written against; a verdict list does not transfer.
  if (adjudication.run && !runPath.includes(adjudication.run)) return null
  const total = report.findings?.length ?? 0
  if (total === 0) return null
  const real = adjudication.verdicts.filter((v) => v.verdict === 'real' || v.verdict === 'real-cold').length
  return ratio(real, total)
}

const rows = []
const problems = []

for (const repo of targets) {
  if (!repo.sha) {
    problems.push(`${repo.id}: not pinned. A benchmark you cannot reproduce cannot show a regression — run \`node bench/pin.mjs\` and commit the SHA.`)
    continue
  }

  const runDir = resolve(BENCH, 'runs', repo.id, repo.sha)
  const truthPath = resolve(BENCH, 'truth', repo.id, `${repo.sha}.json`)
  const runPaths = collectRuns(runDir)

  if (runPaths.length === 0) {
    problems.push(`${repo.id}: no run under bench/runs/${repo.id}/${repo.sha}/ — run \`npm run bench:scan -- --repo ${repo.id}\` first.`)
    continue
  }
  if (!repo.control && !existsSync(truthPath)) {
    problems.push(`${repo.id}: no truth file at bench/truth/${repo.id}/${repo.sha}.json — run the audit in bench/AUDIT_PROMPT.md.`)
    continue
  }

  const truth = repo.control ? [] : JSON.parse(readFileSync(truthPath, 'utf8'))

  /*
   * A defect truth file measures recall. It cannot measure precision, because
   * it says nothing about the findings it does not list — and against a file of
   * three major defects, 25 of 31 findings scored as false positives when they
   * were merely unlisted. Precision needs a verdict on every published finding,
   * which is what an adjudication file carries.
   */
  const adjPath = resolve(BENCH, 'truth', repo.id, `${repo.sha}-adjudication.json`)
  const adjudication = existsSync(adjPath) ? JSON.parse(readFileSync(adjPath, 'utf8')) : null

  // Runs are grouped by configuration, never pooled across configurations: two
  // different settings are two different experiments, and averaging them
  // produces a number that describes neither. Within a group the spread is
  // reported and the gate is applied to the WORST run — meeting a threshold in
  // one run of three is not meeting it.
  const groups = new Map()
  for (const f of runPaths) {
    const label = configLabel(f)
    const scored = score(JSON.parse(readFileSync(f, 'utf8')), truth, repo, adjudication, f)
    groups.set(label, [...(groups.get(label) ?? []), scored])
  }

  for (const [label, scored] of groups) {
    rows.push({ repo, label, runs: scored.length, ...aggregate(scored) })
  }
}

/** A short, stable description of the settings a run used. */
function configLabel(reportPath) {
  const cfg = reportPath.replace(/report\.json$/, 'config.json')
  if (!existsSync(cfg)) return 'unrecorded'
  const c = JSON.parse(readFileSync(cfg, 'utf8'))
  const parts = [c.model ?? '?']
  // The analysis strategy belongs in the label. Leaving it out pooled a
  // two-stage run with a single-shot one under "25/pass" — the exact
  // configuration-mixing this grouping exists to prevent.
  if (c.analysis) parts.push(c.analysis)
  if (c.analysis === 'two-stage') {
    parts.push(`triage ${c.triageSitesPerPass ?? 60}/pass`)
    if ((c.triageSamples ?? 1) > 1) parts.push(`×${c.triageSamples} samples`)
    parts.push(`author ${c.authorSitesPerRequest ?? 3}/req`)
  } else {
    parts.push(`${c.maxCandidatesPerChunk ?? 'ctx-fill'}/pass`)
  }
  if (c.minPriority) parts.push(`floor ${c.minPriority}`)
  if (c.maxCandidates) parts.push(`top ${c.maxCandidates}`)
  if (c.stub) parts.push('stub')
  return parts.join(' · ')
}

/** Numbered run directories, plus a bare report.json from the older layout. */
function collectRuns(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const legacy = resolve(dir, 'report.json')
  if (existsSync(legacy)) out.push(legacy)
  for (const entry of readdirSync(dir)) {
    const f = resolve(dir, entry, 'report.json')
    if (entry.startsWith('run-') && existsSync(f)) out.push(f)
  }
  return out
}

/**
 * Mean, min and max per metric across runs.
 *
 * `null` means "could not be computed", which is not zero and must not be
 * averaged in — a metric absent from every run stays absent.
 */
function aggregate(scored) {
  const keys = Object.keys(scored[0].metrics)
  const metrics = {}
  const spread = {}
  for (const k of keys) {
    const vals = scored.map((s) => s.metrics[k]).filter((v) => v !== null && v !== undefined)
    if (vals.length === 0) { metrics[k] = null; spread[k] = null; continue }
    metrics[k] = Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4))
    spread[k] = { min: Math.min(...vals), max: Math.max(...vals), n: vals.length }
  }
  const last = scored[scored.length - 1]
  return {
    ...last,
    metrics,
    spread,
    published: Math.round(scored.reduce((a, s) => a + s.published, 0) / scored.length),
    suppressed: Math.round(scored.reduce((a, s) => a + s.suppressed, 0) / scored.length),
  }
}

/* ------------------------------------------------------------------ scoring */

/**
 * Every line a truth entry can legitimately be reported at.
 *
 * fix.md's ground truth names line *sets* per defect — `1030/1048/1081` is one
 * import routine issuing a query at three nesting levels. Treating each line as
 * an independent entry counted one defect as three misses, and scored a correct
 * finding at one of its lines as a false positive.
 */
function linesOf(t) {
  return Array.isArray(t.lines) && t.lines.length ? t.lines : [t.startLine ?? 0]
}

function matchesTruth(f, t) {
  if (t.file !== f.primaryOccurrence?.file) return false
  const at = f.primaryOccurrence?.startLine ?? 0
  return linesOf(t).some((line) => Math.abs(line - at) <= LINE_TOLERANCE)
}

function score(report, truth, repo, adjudication, runPath) {
  const published = report.findings ?? []
  const suppressed = report.suppressed ?? []
  const stats = report.stats ?? {}

  const matched = new Set()
  let truePositives = 0

  for (const f of published) {
    // A defect may be reported at any of its lines; several findings may
    // legitimately describe the same defect, so `matched` is not consumed here —
    // precision asks "is this finding real", not "is it the first one".
    if (truth.some((t) => matchesTruth(f, t))) truePositives++
    truth.forEach((t, i) => { if (matchesTruth(f, t)) matched.add(i) })
  }

  const highTruth = truth.filter((t) => t.severity === 'critical' || t.severity === 'high')
  const highFound = highTruth.filter((t) => published.some((f) => matchesTruth(f, t)))

  // Candidate coverage isolates Fixes 1–2 from the model entirely: if a real
  // N+1 never becomes a candidate, no prompt change can recover it and every
  // other metric is downstream of it. `candidates` is written by the --no-llm
  // detection run; without it this metric is reported as unavailable, never as
  // passing.
  const candidates = report.candidates ?? null
  const highCovered = candidates === null ? null : highTruth.filter((t) =>
    candidates.some((c) =>
      c.file === t.file && linesOf(t).some((line) => Math.abs(c.startLine - line) <= LINE_TOLERANCE)))

  const total = published.length

  // Rates are measured against what was PUBLISHED. A suppressed no-op is the
  // gate working; a published one is the failure the gate exists to prevent.
  const noOps = published.filter((f) => collapse(f.original) === collapse(f.suggestion?.proposed ?? '')).length
  const coldPath = published.filter((f) =>
    f.scope?.trigger === 'migration' || f.scope?.trigger === 'test').length
  const withCounted = published.filter((f) => (f.performance?.counted?.length ?? 0) > 0).length

  const declared = new Set((report.engineProfile?.declared ?? []).map((d) => d.engine))
  const engineOk = candidates === null ? null : ratio(
    candidates.filter((c) => c.engine === 'unknown' || declared.size === 0 || declared.has(c.engine)).length,
    candidates.length)

  return {
    published: total,
    suppressed: suppressed.length,
    truthEntries: truth.length,
    metrics: {
      // When an adjudication exists for *this* run, it is the precision figure:
      // it has a verdict for every published finding. The defect-truth fallback
      // is a floor, and a low one — it can only credit findings that happen to
      // land on a listed defect.
      precision: adjudicatedPrecision(adjudication, runPath, report)
        ?? (total === 0 ? (repo.control ? 1 : null) : ratio(truePositives, total)),
      recallAtHigh: highTruth.length === 0 ? null : ratio(highFound.length, highTruth.length),
      noOpRate: ratio(noOps, total),
      // Measured on what was PUBLISHED. A suppressed no-op or wrong-direction
      // finding is the gate working; a published one is the failure the gate
      // exists to prevent, and only the second belongs in a rate.
      wrongDirectionRate: ratio(published.filter(goesWrongWay).length, total),
      nonDataAccessRate: ratio(published.filter((f) => !touchesData(f)).length, total),
      coldPathShare: ratio(coldPath, total),
      engineAccuracy: engineOk,
      countedFactCoverage: ratio(withCounted, total),
      candidateCoverage: highCovered === null ? null : ratio(highCovered.length, highTruth.length),
    },
    coverage: {
      sitesMatched: stats.sitesMatched ?? null,
      sitesAnalysed: stats.sitesAnalysed ?? null,
      filtered: stats.sitesFiltered
        ? stats.sitesFiltered.belowConfidence + stats.sitesFiltered.lowPriority
        : null,
      truncatedFiles: (stats.truncatedFiles ?? []).length,
    },
    control: !!repo.control,
    controlClean: repo.control ? total === 0 : null,
  }
}

/** A round-trip claim whose proposal does not actually reduce the round trips. */
function goesWrongWay(f) {
  if (!ROUND_TRIP.has(f.category)) return false
  const a = readOrmShape(f.original ?? '', f.scope ?? null)
  const b = readOrmShape(f.suggestion?.proposed ?? '', f.scope ?? null)
  if (!a || !b) return false
  const escapesLoop = a.perIteration && !b.perIteration
  return b.queryCount >= a.queryCount && !escapesLoop
}

/** Neither version is a statement or ORM data access — so it is not our finding. */
function touchesData(f) {
  const sides = [f.original ?? '', f.suggestion?.proposed ?? '']
  return sides.some((code) => {
    const sql = readSqlShape(code)
    if (sql && sql.kind !== 'other') return true
    return readOrmShape(code, f.scope ?? null) !== null
  })
}

function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function ratio(n, d) {
  return d === 0 ? null : Number((n / d).toFixed(4))
}

/* ------------------------------------------------------------------ gating */

const GATES = [
  ['candidateCoverage', 'gte', 'Candidate coverage'],
  ['precision', 'gte', 'Precision'],
  ['recallAtHigh', 'gte', 'Recall @ high'],
  ['noOpRate', 'lte', 'No-op rate'],
  ['wrongDirectionRate', 'lte', 'Wrong-direction rate'],
  ['nonDataAccessRate', 'lte', 'Non-data-access rate'],
  ['engineAccuracy', 'gte', 'Engine accuracy'],
  ['countedFactCoverage', 'gte', 'Counted-fact coverage'],
]

const failures = []
const DETECTION_ONLY = new Set(['candidateCoverage', 'engineAccuracy', 'coldPathShare'])

for (const row of rows) {
  if (row.control) {
    if (!row.controlClean) {
      failures.push(`${row.repo.id}: the negative control published ${row.published} finding(s). It must publish zero.`)
    }
    continue
  }
  for (const [key, dir, label] of GATES) {
    if (noLlm && !DETECTION_ONLY.has(key)) continue
    // The worst run in the group, not the mean: a gate met on average and missed
    // in one run of three is a gate that will be missed in production.
    const value = dir === 'gte'
      ? (row.spread[key]?.min ?? row.metrics[key])
      : (row.spread[key]?.max ?? row.metrics[key])
    const gate = config.gates[key]
    if (value === null || value === undefined) {
      failures.push(`${row.repo.id}: ${label} could not be computed. Not the same thing as passing.`)
      continue
    }
    const ok = dir === 'gte' ? value >= gate : value <= gate
    if (!ok) failures.push(`${row.repo.id}: ${label} ${pct(value)} vs gate ${pct(gate)}.`)
  }
}

/* ---------------------------------------------------------------- reporting */

function pct(v) {
  return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`
}

/** Mean, plus the range when more than one run measured it. */
function span(mean, sp) {
  if (mean === null || mean === undefined) return 'n/a'
  if (!sp || sp.n < 2 || sp.min === sp.max) return pct(mean)
  return `${pct(mean)} (${pct(sp.min)}–${pct(sp.max)})`
}

const stamp = new Date().toISOString().slice(0, 10)
const out = [
  `# Benchmark — ${stamp}`,
  '',
  noLlm
    ? 'Detection-only run (`--no-llm`). Candidate coverage, engine accuracy and cold-path share are decided before the model runs, so these cost nothing and are the ones wired into CI.'
    : 'Full run. Every metric below is computed by reconciling the published report against a human-adjudicated Claude audit of the same commit.',
  '',
]

if (rows.length > 0) {
  out.push(
    '| Repo | Config | Published | Suppressed | Precision | Recall @ high | Candidate cov. | Engine acc. | Counted facts | No-op | Wrong dir. | Non-data |',
    '| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |',
    ...rows.map((r) => [
      r.runs > 1 ? `${r.repo.id} (${r.runs} runs)` : r.repo.id, r.label ?? '—', r.published, r.suppressed,
      span(r.metrics.precision, r.spread.precision), span(r.metrics.recallAtHigh, r.spread.recallAtHigh), span(r.metrics.candidateCoverage, r.spread.candidateCoverage),
      span(r.metrics.engineAccuracy, r.spread.engineAccuracy), span(r.metrics.countedFactCoverage, r.spread.countedFactCoverage),
      span(r.metrics.noOpRate, r.spread.noOpRate), span(r.metrics.wrongDirectionRate, r.spread.wrongDirectionRate), span(r.metrics.nonDataAccessRate, r.spread.nonDataAccessRate),
    ].join(' | ')).map((line) => `| ${line} |`),
    '',
    '## Coverage, as reported',
    '',
    '| Repo | Sites matched | Analysed | Filtered | Files capped |',
    '| --- | --: | --: | --: | --: |',
    ...rows.map((r) => `| ${r.repo.id} | ${r.coverage.sitesMatched ?? 'n/a'} | ${r.coverage.sitesAnalysed ?? 'n/a'} | ${r.coverage.filtered ?? 'n/a'} | ${r.coverage.truncatedFiles} |`),
    '',
  )
}

if (problems.length > 0) {
  out.push('## Not scored', '', ...problems.map((p) => `- ${p}`), '')
}

out.push('## Gates', '')
if (failures.length === 0 && rows.length > 0) {
  out.push('All gates passed.', '')
} else if (rows.length === 0) {
  out.push('Nothing was scored, so nothing passed. An unscored benchmark is not a green one.', '')
} else {
  out.push(...failures.map((f) => `- FAIL — ${f}`), '')
}

out.push(
  '## Baseline (mt-test-studio, 2026-08-26, pre-fix)',
  '',
  '| Metric | Baseline | Gate |',
  '| --- | --: | --: |',
  ...Object.entries(config.baseline)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `| ${k} | ${pct(v)} | ${config.gates[k] === undefined ? '—' : pct(config.gates[k])} |`),
  '',
)

await server.close()

const resultPath = resolve(BENCH, 'results', `${stamp}.md`)
mkdirSync(dirname(resultPath), { recursive: true })
writeFileSync(resultPath, out.join('\n'))

console.log(out.join('\n'))
console.log(`\nWritten to bench/results/${stamp}.md`)

if (problems.length > 0 || failures.length > 0 || rows.length === 0) {
  console.error(`\n${failures.length} gate failure(s), ${problems.length} repo(s) not scored.`)
  process.exit(1)
}
