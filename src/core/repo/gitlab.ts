import { ArchiveUnavailable } from './client'
import type { RepoFile, RepoRef } from '@/core/types'
import type { ParsedRepoUrl } from './parse-url'
import { readTarGz } from './tar'
import {
  ARCHIVE_TIMEOUT_MS, LIST_TIMEOUT_MS, RepoError, fetchWithRetry, isOversized, isScannable,
  type ArchiveCtx, type ArchiveResult, type RepoClient, type RequestCtx, type TokenCheck,
} from './client'

export class GitLabClient implements RepoClient {
  constructor(private readonly token?: string) {}

  private headers(): HeadersInit {
    return this.token ? { 'private-token': this.token } : {}
  }

  /** GitLab wants the full namespaced path URL-encoded as a single segment. */
  private projectId(repo: { owner: string; name: string }): string {
    return encodeURIComponent(`${repo.owner}/${repo.name}`)
  }

  async validateToken(apiOrigin = 'https://gitlab.com/api'): Promise<TokenCheck> {
    if (!this.token) {
      return {
        ok: true,
        message: 'No token set — only public projects are reachable, at a low anonymous rate limit.',
      }
    }

    const res = await fetch(`${apiOrigin}/v4/user`, { headers: this.headers() }).catch(() => null)
    if (!res) return { ok: false, message: 'Could not reach GitLab.' }
    if (res.status === 401) return { ok: false, message: 'GitLab rejected this token. It may be expired or revoked.' }
    if (res.status === 403) return { ok: false, message: 'Token is valid but forbidden — check its scopes.' }
    if (!res.ok) return { ok: false, message: `GitLab returned ${res.status}.` }

    const user = (await res.json()) as { username?: string; name?: string }

    // GitLab reports its rate limit per-endpoint rather than globally.
    const remaining = Number(res.headers.get('ratelimit-remaining') ?? NaN)
    const limit = Number(res.headers.get('ratelimit-limit') ?? NaN)

    // read_api is the scope that actually matters; the token endpoint exposes
    // it on self-managed instances but not always on gitlab.com.
    const scopeRes = await fetch(`${apiOrigin}/v4/personal_access_tokens/self`, {
      headers: this.headers(),
    }).catch(() => null)
    const scopes = scopeRes?.ok
      ? ((await scopeRes.json()) as { scopes?: string[] }).scopes
      : undefined

    const lacksRead = scopes && !scopes.some((s) => s === 'read_api' || s === 'api')
    if (lacksRead) {
      return {
        ok: false,
        account: user.username,
        message: `Authenticated as ${user.username}, but this token has no read_api scope (${scopes?.join(', ')}). File reads will fail.`,
      }
    }

    return {
      ok: true,
      account: user.username,
      remaining: Number.isFinite(remaining) ? remaining : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      message:
        `Authenticated as ${user.username}${user.name ? ` (${user.name})` : ''}.` +
        (scopes ? ` Scopes: ${scopes.join(', ')}.` : '') +
        (Number.isFinite(remaining) ? ` ${remaining} of ${limit} requests left in this window.` : ''),
    }
  }

  async listChangedFiles(repo: RepoRef, pr: number, ctx?: RequestCtx): Promise<string[] | null> {
    const url =
      `${repo.apiOrigin}/v4/projects/${this.projectId(repo)}` +
      `/merge_requests/${pr}/changes`
    const res = await fetchWithRetry(url, { headers: this.headers(), signal: ctx?.signal })
    if (!res.ok) return null

    const body = (await res.json()) as {
      changes?: { new_path: string; deleted_file?: boolean }[]
    }
    return (body.changes ?? [])
      .filter((c) => !c.deleted_file)
      .map((c) => c.new_path)
  }

  async fetchArchive(repo: RepoRef, ctx?: ArchiveCtx): Promise<ArchiveResult | null> {
    const url =
      `${repo.apiOrigin}/v4/projects/${this.projectId(repo)}` +
      `/repository/archive.tar.gz?sha=${encodeURIComponent(repo.commitSha)}`

    // Not fetchWithRetry: a partially consumed stream cannot be retried, and
    // the archive has its own much longer deadline.
    // The reason is preserved rather than collapsed to `null`. A CORS block on
    // the codeload redirect, a 403 from an exhausted rate limit and a genuine
    // "this endpoint cannot serve an archive" all used to look identical to the
    // caller, so the fallback to one-request-per-file was silent — and on GitHub
    // it was happening every single time.
    const res = await fetch(url, {
      headers: this.headers(),
      signal: ctx?.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)])
        : AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      redirect: 'follow',
    }).catch((e: unknown) => {
      // A CORS block surfaces here as an opaque TypeError, so the message is
      // annotated with the one cause the user can act on.
      const detail = e instanceof Error ? e.message : String(e)
      throw new ArchiveUnavailable(
        `${detail} — if this is a CORS error, the archive redirect host may not be granted in host_permissions.`,
      )
    })

    if (!res.ok) throw new ArchiveUnavailable(`the forge answered ${res.status} ${res.statusText}`)
    if (!res.body) throw new ArchiveUnavailable('the response had no body to stream')

    let bytes = 0
    const files = await readTarGz(res.body, {
      accept: ctx?.accept ?? (() => true),
      signal: ctx?.signal,
      onProgress: (b, n) => { bytes = b; ctx?.onProgress?.(b, n) },
    })

    return { files: files.map((f) => ({ path: f.path, size: f.size, content: f.text })), bytes }
  }

  async resolve(parsed: ParsedRepoUrl, ref?: string, ctx?: RequestCtx): Promise<RepoRef> {
    const base = `${parsed.apiOrigin}/v4/projects/${this.projectId(parsed)}`
    const res = await fetchWithRetry(base, { headers: this.headers(), signal: ctx?.signal })
    if (res.status === 404) {
      throw new RepoError(
        this.token
          ? 'Project not found, or your token cannot see it.'
          : 'Project not found. Private? Add a GitLab token in Settings.',
        'not-found',
      )
    }
    if (res.status === 401) throw new RepoError('GitLab rejected your token.', 'auth')
    if (!res.ok) throw new RepoError(`GitLab error ${res.status}.`, 'unknown')

    const project = (await res.json()) as { default_branch: string }
    const wanted = ref ?? parsed.ref ?? project.default_branch

    const commitRes = await fetchWithRetry(
      `${base}/repository/commits/${encodeURIComponent(wanted)}`,
      { headers: this.headers(), signal: ctx?.signal },
    )
    if (!commitRes.ok) throw new RepoError(`No such branch, tag or commit: ${wanted}`, 'not-found')
    const commit = (await commitRes.json()) as { id: string }

    return {
      forge: 'gitlab',
      apiOrigin: parsed.apiOrigin,
      owner: parsed.owner,
      name: parsed.name,
      ref: wanted,
      commitSha: commit.id,
    }
  }

  async listFiles(repo: RepoRef, ctx?: RequestCtx): Promise<RepoFile[]> {
    // GitLab has no single recursive-tree call — it is keyset-paginated.
    const files: RepoFile[] = []
    const base = `${repo.apiOrigin}/v4/projects/${this.projectId(repo)}/repository/tree`
    let pageToken: string | null = null
    let guard = 0

    do {
      const params = new URLSearchParams({
        recursive: 'true',
        per_page: '100',
        ref: repo.commitSha,
        pagination: 'keyset',
      })
      if (pageToken) params.set('page_token', pageToken)

      const res: Response = await fetchWithRetry(
        `${base}?${params}`,
        { headers: this.headers(), signal: ctx?.signal },
        3,
        LIST_TIMEOUT_MS,
      )
      if (!res.ok) throw new RepoError(`Could not list files (${res.status}).`, 'unknown')

      const batch = (await res.json()) as { path: string; type: string }[]
      for (const n of batch) {
        // The tree endpoint omits size; treat as 0 and let the fetch step cap it.
        if (n.type === 'blob' && isScannable(n.path, 0)) files.push({ path: n.path, size: 0 })
      }
      pageToken = nextPageToken(res)
      if (++guard > 200) {
        throw new RepoError('This project has too many files to scan in one pass.', 'too-large')
      }
    } while (pageToken)

    return files
  }

  async readFile(repo: RepoRef, path: string, ctx?: RequestCtx): Promise<string> {
    const url =
      `${repo.apiOrigin}/v4/projects/${this.projectId(repo)}` +
      `/repository/files/${encodeURIComponent(path)}/raw?ref=${repo.commitSha}`
    const res = await fetchWithRetry(url, { headers: this.headers(), signal: ctx?.signal })
    if (!res.ok) throw new RepoError(`Could not read ${path} (${res.status}).`, 'unknown')
    if (isOversized(res)) throw new RepoError(`Skipped oversized file: ${path}`, 'too-large')
    return res.text()
  }

  async listBranches(parsed: ParsedRepoUrl, ctx?: RequestCtx): Promise<string[]> {
    const url = `${parsed.apiOrigin}/v4/projects/${this.projectId(parsed)}/repository/branches?per_page=100`
    const res = await fetchWithRetry(url, { headers: this.headers(), signal: ctx?.signal })
    if (!res.ok) return []
    const body = (await res.json()) as { name: string }[]
    return body.map((b) => b.name)
  }
}

function nextPageToken(res: Response): string | null {
  const link = res.headers.get('link')
  if (!link) return null
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)
  if (!next?.[1]) return null
  try {
    return new URL(next[1]).searchParams.get('page_token')
  } catch {
    return null
  }
}
