import type { RuntimeEvidence } from './types'

/**
 * Where runtime evidence lives, and why it is not `storage.local`.
 *
 * Session storage, memory-backed, gone when Chrome closes — the same rule as
 * API keys in `core/settings.ts`, applied more strictly. The reasoning there
 * was that an extension cannot meaningfully encrypt secrets at rest, so the
 * honest default is not to persist them. Evidence is a harder case in the same
 * direction:
 *
 *   - `EXPLAIN ANALYZE` output carries production row values inside `Filter:`
 *     and `Index Cond:` lines. A plan for `WHERE email = 'a@b.com'` contains
 *     that address.
 *   - A query log carries bound parameters, which is the same data in bulk.
 *   - `pg_stats` carries `most_common_vals` — literally a sample of the rows.
 *
 * And the asymmetry that settles the default: **a leaked API key is revocable;
 * a leaked customer row is not.** So there is no persist-to-disk toggle here at
 * all, which is a deliberate difference from secrets. Nobody needs a plan to
 * survive a browser restart badly enough to write production data to disk on a
 * laptop, and offering the option would mean most people take it.
 *
 * Statements are stored as normalised shapes rather than verbatim wherever the
 * consumer only needs the shape — see `normaliseShape`.
 */

const KEY = 'speedb.evidence'

/** Bounded so a session of pasting plans cannot exhaust the session quota. */
const MAX_ENTRIES = 40

export interface StoredEvidence {
  /** `findingId` this was captured for, or `null` for repo-wide catalogs. */
  findingId: string | null
  evidence: RuntimeEvidence
  storedAt: number
}

async function readAll(): Promise<StoredEvidence[]> {
  try {
    const got = await chrome.storage.session.get(KEY)
    const entries = got[KEY]
    return Array.isArray(entries) ? (entries as StoredEvidence[]) : []
  } catch {
    return []
  }
}

export async function saveEvidence(
  findingId: string | null,
  evidence: RuntimeEvidence,
  now: number,
): Promise<void> {
  const entries = await readAll()
  // Same finding, same kind, same side replaces rather than accumulates — a
  // second paste is a correction, not a second data point.
  const next = [
    { findingId, evidence, storedAt: now },
    ...entries.filter(
      (e) =>
        !(e.findingId === findingId &&
          e.evidence.kind === evidence.kind &&
          e.evidence.side === evidence.side),
    ),
  ].slice(0, MAX_ENTRIES)

  try {
    await chrome.storage.session.set({ [KEY]: next })
  } catch {
    // Over quota. Keep only this one; if even that fails, the import is lost
    // and the caller reports it — an evidence write must never fail a scan.
    try {
      await chrome.storage.session.set({ [KEY]: [{ findingId, evidence, storedAt: now }] })
    } catch {
      /* give up */
    }
  }
}

export async function evidenceFor(findingId: string): Promise<RuntimeEvidence[]> {
  const all = await readAll()
  return all
    // Repo-wide captures (an index catalog, a stats dump) apply to every
    // finding, so they come back for all of them.
    .filter((e) => e.findingId === findingId || e.findingId === null)
    .map((e) => e.evidence)
}

export async function allEvidence(): Promise<StoredEvidence[]> {
  return readAll()
}

export async function clearEvidence(): Promise<void> {
  try {
    await chrome.storage.session.remove(KEY)
  } catch {
    /* nothing to clear */
  }
}

/** For Settings: what is held, so it can be seen and dropped. */
export async function evidenceSummary(): Promise<{ count: number; kinds: string[] }> {
  const all = await readAll()
  return { count: all.length, kinds: [...new Set(all.map((e) => e.evidence.kind))] }
}
