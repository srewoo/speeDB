#!/usr/bin/env node
/**
 * Fail the build on a circular *value* import.
 *
 * A cycle in ESM does not error at import time. It leaves a binding in its
 * temporal dead zone, and you find out at runtime with "Cannot access 'X'
 * before initialization" — minified, in whichever code path happened to reach
 * it first. That is a miserable way to learn about it, so it is checked here.
 *
 * `import type` is erased by the compiler and cannot cause it, so type-only
 * edges are ignored; flagging them would make the check useless noise.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { aliases, CORE_SRC, EXTENSION_SRC } from '../../../aliases.mjs'

/**
 * Both package sources are walked as one graph.
 *
 * A cycle does not respect a package boundary — `@/config` and `@/core` import
 * each other by design — so checking either package alone would miss exactly
 * the edges most worth catching.
 */
const roots = [CORE_SRC, EXTENSION_SRC]

const files = []
for (const root of roots) {
  ;(function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(path) && !path.includes('__tests__')) files.push(path)
    }
  })(root)
}

function resolveSpec(from, spec) {
  let base
  if (spec.startsWith('@/')) {
    const hit = aliases.find((a) => a.find.test(spec))
    if (!hit) return null
    base = spec.replace(hit.find, hit.replacement)
  }
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(base + ext)) return base + ext
  }
  return existsSync(base) && statSync(base).isFile() ? base : null
}

const graph = new Map()
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const deps = new Set()
  // `export … from` is a value edge too, and re-export barrels are a classic
  // way to create a cycle that only shows up at runtime.
  const re = /(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) {
    if (m[1]) continue // `import type { … }` / `export type { … }`
    const names = (m[2] ?? '').replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    // A clause whose every specifier is `type X` is also fully erased.
    if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue
    const target = resolveSpec(file, m[3])
    if (target) deps.add(target)
  }

  // Side-effect imports (`import './x'`) still execute the module.
  const bare = /import\s+['"]([^'"]+)['"]/g
  while ((m = bare.exec(src)) !== null) {
    const target = resolveSpec(file, m[1])
    if (target) deps.add(target)
  }
  graph.set(file, [...deps])
}

const cycles = []
const settled = new Set()
const stack = []
function visit(node) {
  const at = stack.indexOf(node)
  if (at !== -1) { cycles.push([...stack.slice(at), node]); return }
  if (settled.has(node)) return
  settled.add(node)
  stack.push(node)
  for (const dep of graph.get(node) ?? []) visit(dep)
  stack.pop()
}
for (const file of files) visit(file)

const rel = (p) => p.replace(projectRoot + '/', '')

if (cycles.length === 0) {
  console.log('  No circular value imports.')
  process.exit(0)
}
for (const c of cycles) console.error('  CYCLE:\n    ' + c.map(rel).join('\n    → '))
console.error(`\n  ${cycles.length} circular value import(s) — these become temporal dead zone errors at runtime.\n`)
process.exit(1)
