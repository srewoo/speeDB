import { readFile, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, relative, sep } from 'node:path'
import type {
  ArchiveCtx, ArchiveResult, ParsedRepoUrl, RepoClient, RepoFile, RepoRef,
} from '@speedb/core'

const run = promisify(execFile)

/**
 * A `RepoClient` over a directory on disk.
 *
 * The forge clients exist because the extension had no other way to see a
 * repository. An agent does: it is usually already sitting in the checkout,
 * often on a branch that has never been pushed. Making it push first, so the
 * tool can download what is already on the same disk, would be absurd — and it
 * would make the tool useless for exactly the case it is best at, which is
 * reviewing a change before anyone else sees it.
 *
 * The interface is satisfied honestly rather than completely. `listChangedFiles`
 * asks git, `resolve` reads HEAD, and the two calls that only mean something
 * against a forge API — `validateToken`, `listBranches` — answer for a local
 * checkout instead of pretending to be a forge.
 */
export class LocalClient implements RepoClient {
  constructor(private readonly root: string) {}

  /**
   * No archive path.
   *
   * Returning null is the documented way to say "cannot serve an archive", and
   * the pipeline falls back to per-file reads. The cost argument that makes the
   * archive endpoint essential over the network — one request instead of two
   * thousand — does not apply to a local disk, where there is no rate limit and
   * no request at all.
   */
  async fetchArchive(_repo: RepoRef, _ctx?: ArchiveCtx): Promise<ArchiveResult | null> {
    return null
  }

  async resolve(parsed: ParsedRepoUrl, ref?: string): Promise<RepoRef> {
    return {
      ...parsed,
      ref: ref ?? (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD',
      commitSha: (await this.git(['rev-parse', 'HEAD'])) ?? `local-${Date.now()}`,
      defaultBranch: (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD',
    } as RepoRef
  }

  /**
   * Changed files, against a base ref.
   *
   * `pr` is reused as "how many commits back", because a local checkout has no
   * pull request number. `scan_local` passes 1, which is the last commit; the
   * uncommitted case is handled by `--staged`-style diffing below, folded in so
   * a dirty working tree is not silently reported as unchanged.
   */
  async listChangedFiles(_repo: RepoRef, pr: number): Promise<string[] | null> {
    const base = `HEAD~${Math.max(1, pr)}`
    const committed = await this.git(['diff', '--name-only', base, 'HEAD'])
    const dirty = await this.git(['diff', '--name-only', 'HEAD'])
    if (committed === null && dirty === null) return null
    const all = [...(committed ?? '').split('\n'), ...(dirty ?? '').split('\n')]
    const files = [...new Set(all.map((l) => l.trim()).filter(Boolean))]
    return files.length > 0 ? files : null
  }

  async listFiles(): Promise<RepoFile[]> {
    const out: RepoFile[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const info = await stat(full)
          out.push({
            path: relative(this.root, full).split(sep).join('/'),
            size: info.size,
          } as RepoFile)
        } catch {
          // A file that vanished between readdir and stat costs that file.
        }
      }
    }
    await walk(this.root)
    return out
  }

  async readFile(_repo: RepoRef, path: string): Promise<string> {
    return readFile(join(this.root, path), 'utf8')
  }

  async validateToken() {
    return { ok: true, message: `Local checkout at ${this.root}. No credentials are used.` }
  }

  async listBranches(): Promise<string[]> {
    const out = await this.git(['branch', '--format=%(refname:short)'])
    return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []
  }

  /** Resolves to null rather than throwing — not every directory is a git repo. */
  private async git(args: string[]): Promise<string | null> {
    try {
      const { stdout } = await run('git', args, { cwd: this.root, maxBuffer: 32 * 1024 * 1024 })
      return stdout.trim() || null
    } catch {
      return null
    }
  }
}

/**
 * Directories never worth walking.
 *
 * Deliberately shorter than the extension's ingest filter, because core already
 * applies `isScannable` to everything this returns. What is here is only what
 * makes the *walk itself* slow — a `node_modules` with 40,000 files costs real
 * seconds to stat before core ever gets the chance to reject it.
 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.idea',
  'coverage', '.turbo', '.cache', 'bower_components', 'Pods',
])
