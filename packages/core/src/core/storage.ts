/**
 * The one place core talks to a key-value store.
 *
 * Core used to call `chrome.storage.*` directly from three modules, which made
 * the whole analysis pipeline unreachable outside an extension — the pipeline
 * imports the scan cache, the scan cache imported `chrome`, and that was that.
 * `bench/scan.mjs` worked around it by assigning a fake onto `globalThis.chrome`
 * before loading any module, which is fine for a script the repo controls and
 * not fine for a published library.
 *
 * So the dependency is named and injected instead. The default backend still
 * detects a real `chrome.storage` and uses it, so the extension keeps its exact
 * behaviour with no call-site changes; Node falls back to memory.
 *
 * The two areas are deliberately distinct and must stay that way:
 *
 *   `session` — memory-backed, gone when the process or browser exits. Secrets,
 *               cached scans and captured evidence live here, and the guarantee
 *               that they are never written to disk is the reason they may hold
 *               API keys and production row values at all.
 *   `local`   — survives a restart. Non-secret settings, and secrets only when
 *               the user has explicitly opted in.
 *
 * `bench/scan.mjs`'s shim collapsed both areas onto one object. Nothing there
 * depended on the difference, but a backend that ships must not repeat it:
 * `saveSecrets(patch, persist)` selects an area by that flag, so collapsing them
 * would silently persist a secret the user asked to keep in memory.
 */

/** The subset of `chrome.storage.StorageArea` that core actually uses. */
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

export interface StorageBackend {
  readonly session: StorageArea
  readonly local: StorageArea
}

/** An in-process area. The default outside a browser. */
export function memoryArea(): StorageArea {
  const store = new Map<string, unknown>()
  return {
    async get(key) {
      return store.has(key) ? { [key]: store.get(key) } : {}
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v)
    },
    async remove(key) {
      store.delete(key)
    },
  }
}

/**
 * Two independent areas, both in memory.
 *
 * `local` is not durable here — a Node caller that wants durability supplies a
 * filesystem-backed area instead. What matters is that the two are separate, so
 * the persist-vs-session distinction behaves the same as it does in a browser.
 */
export function memoryBackend(): StorageBackend {
  return { session: memoryArea(), local: memoryArea() }
}

interface ChromeLike {
  storage?: {
    session?: StorageArea
    local?: StorageArea
  }
}

/**
 * Fallback areas, created once so data written through them persists.
 *
 * Resolved per area rather than per backend: a caller — in practice a test —
 * may install a `chrome.storage` that defines only the area it exercises, and
 * the sensible reading of that is "use it for `session`, and give me something
 * working for `local`", not "ignore the whole thing".
 */
const fallback = memoryBackend()

/**
 * Explicit override. Beats detection in both directions once set.
 *
 * Process-global on purpose: a scan cache shared between concurrent scans is
 * the behaviour the extension already has, and the keys carry the commit SHA,
 * provider, model and prompt version, so two scans cannot collide.
 */
let override: StorageBackend | null = null

export function setStorageBackend(next: StorageBackend): void {
  override = next
}

/** Drop the override and go back to detection. Mainly for tests. */
export function resetStorageBackend(): void {
  override = null
}

/**
 * Resolved on every access rather than memoised.
 *
 * Memoising looked free and was not: the extension's service worker and the
 * tests both install `chrome` at a point the first caller cannot predict, so a
 * backend captured on first use pinned whichever happened to be there and
 * silently ignored the real one. A property lookup per storage call is not
 * worth reasoning about; a cache that can hold the wrong answer is.
 */
function area(name: 'session' | 'local'): StorageArea {
  if (override) return override[name]
  return (globalThis as { chrome?: ChromeLike }).chrome?.storage?.[name] ?? fallback[name]
}

export function storage(): StorageBackend {
  return {
    get session() { return area('session') },
    get local() { return area('local') },
  }
}
