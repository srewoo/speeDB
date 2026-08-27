#!/usr/bin/env node
/**
 * What the benchmark result was measured against.
 *
 * Shared by `bench/score.mjs`, which records it alongside a run, and
 * `bench/gate.mjs`, which refuses to package a build whose analysis code the
 * recorded run never saw. Kept in its own module so importing it has no side
 * effects — `gate.mjs` is a CLI that exits non-zero, and importing a CLI to
 * borrow one function from it is how a scoring run starts failing releases.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Everything that can change what a finding says.
 *
 * Directories are walked, so a new rule file is covered the day it is added
 * rather than the day someone remembers to list it here. Deliberately excluded:
 * `src/components` and `src/pages` (presentation cannot change a finding),
 * `src/core/repo` (ingestion changes which files are read, and that is caught
 * by candidate coverage in the run itself rather than by a hash).
 */
const WATCHED = [
  'src/core/analyze',
  'src/core/detect',
  'src/config/engines.ts',
  'src/config/explain.ts',
  'src/config/verify',
  'src/core/pipeline.ts',
  'src/core/types.ts',
]

function walk(path) {
  const abs = resolve(ROOT, path)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return [path]
  return readdirSync(abs)
    .flatMap((entry) => walk(join(path, entry)))
    .filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes('__tests__'))
    .sort()
}

/** SHA-256 over the watched sources, path included so a rename counts. */
export function analysisFingerprint() {
  const hash = createHash('sha256')
  const files = WATCHED.flatMap(walk).sort()
  for (const file of files) {
    hash.update(file)
    hash.update(readFileSync(resolve(ROOT, file)))
  }
  return { digest: hash.digest('hex').slice(0, 16), files }
}

