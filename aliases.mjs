/**
 * One alias table, shared by every build and the test runner.
 *
 * `@/core/*` and `@/config/*` resolve into `@speedb/core`; everything else
 * under `@/` is extension code. Keeping the alias shape identical to the
 * pre-split layout is deliberate — it meant the monorepo move changed no import
 * statement in any of the ~120 source files, so the 779 tests were a real check
 * on the move rather than a check on a rewrite of every import.
 *
 * Order matters: these are tried in sequence, so the two specific prefixes must
 * come before the catch-all. An array is used rather than an object because
 * object key order is not part of the alias contract in every consumer.
 *
 * The extension resolves core from source, not from `dist`. It bundles through
 * Vite, so there is nothing to gain from a second build step and something to
 * lose: a stale `dist` that silently diverges from what the tests just ran.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export const CORE_SRC = resolve(root, 'packages/core/src')
export const EXTENSION_SRC = resolve(root, 'packages/extension/src')

export const aliases = [
  { find: /^@\/core\//, replacement: `${CORE_SRC}/core/` },
  { find: /^@\/config\//, replacement: `${CORE_SRC}/config/` },
  { find: /^@\//, replacement: `${EXTENSION_SRC}/` },
]
