#!/usr/bin/env node
/**
 * Release gate: refuse to package analysis code no green benchmark has seen.
 *
 * `npm run release` used to be `test && package`. Unit tests pin behaviour that
 * was specified; they cannot tell you whether precision went from 52% to 20%,
 * because precision is not a property of any one function. The benchmark
 * measures that, and it was not in the release path at all — so the numbers
 * that decide whether this product works were checked when someone remembered.
 *
 * `npm run bench` cannot simply be added to `release`: scoring needs real scan
 * artefacts, which need API keys, a network and several minutes. A release that
 * requires a paid LLM run is a release that gets bypassed.
 *
 * So this gate checks the weaker property that is actually checkable offline,
 * and it is the one that matters for a release:
 *
 *   1. A scored benchmark run exists.
 *   2. It passed its gates.
 *   3. It was produced against *this* analysis code.
 *
 * (3) is the point. A green result from before a prompt rewrite says nothing
 * about the build being packaged. The fingerprint below covers every file that
 * can change what a finding says; edit one, and the recorded result stops
 * applying and this gate says so by name.
 *
 *   node bench/gate.mjs           fail on stale, missing or red results
 *   node bench/gate.mjs --explain print the fingerprint inputs and exit 0
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { analysisFingerprint } from './fingerprint.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const LATEST = resolve(ROOT, 'bench/results/latest.json')

const { digest, files } = analysisFingerprint()

if (process.argv.includes('--explain')) {
  console.log(`Analysis fingerprint: ${digest}`)
  console.log(`${files.length} file(s):`)
  for (const f of files) console.log(`  ${f}`)
  process.exit(0)
}

const fail = (msg) => {
  console.error(`\n✗ Benchmark gate: ${msg}\n`)
  process.exit(1)
}

if (!existsSync(LATEST)) {
  fail(
    'no scored benchmark result found (bench/results/latest.json).\n' +
    '  An unscored benchmark is not a passing one. Run:\n' +
    '    npm run bench\n' +
    '  or, to package a build you accept is unmeasured:\n' +
    '    npm run package',
  )
}

let latest
try {
  latest = JSON.parse(readFileSync(LATEST, 'utf8'))
} catch (e) {
  fail(`bench/results/latest.json is unreadable: ${e.message}`)
}

if (latest.fingerprint !== digest) {
  fail(
    `the analysis code changed since the last scored run.\n` +
    `  scored against: ${latest.fingerprint}  (${latest.stamp})\n` +
    `  packaging:      ${digest}\n` +
    '  A green result from before this change says nothing about this build.\n' +
    '  Re-run `npm run bench`, or `npm run bench:gate -- --explain` to see what is covered.',
  )
}

if (latest.problems?.length) {
  fail(
    `${latest.problems.length} repo(s) were not scored in the last run:\n` +
    latest.problems.map((p) => `    ${p}`).join('\n') +
    '\n  Two things cannot be synthesised — a pinned commit and a human-adjudicated\n' +
    '  audit of it. A run missing either is not a passing run.',
  )
}

if (latest.failures?.length) {
  fail(
    `${latest.failures.length} gate failure(s) in the last scored run:\n` +
    latest.failures.map((f) => `    ${f}`).join('\n'),
  )
}

console.log(
  `✓ Benchmark gate: ${latest.repos ?? '?'} repo(s) scored green against this analysis code ` +
  `(${digest}, ${latest.stamp}).`,
)
