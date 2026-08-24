import type { RepoFile, RepoRef } from '@/core/types'
import type { ParsedRepoUrl } from './parse-url'
import { readTarGz } from './tar'
import {
  ARCHIVE_TIMEOUT_MS, LIST_TIMEOUT_MS, RepoError, fetchWithRetry, isOversized, isScannable,
  type ArchiveCtx, type ArchiveResult, type RepoClient, type RequestCtx, type TokenCheck,
} from './client'

export class GitHubClient implements RepoClient {
  constructor(private readonly token?: string) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }
    if (this.token) h.authorization = `Bearer ${this.token}`
    return h
  }

  async validateToken(apiOrigin = 'https://api.github.com'): Promise<TokenCheck> {
    // /rate_limit works with or without a token, so it doubles as the
    // anonymous-quota check when no token is set.
    const rate = await fetch(`${apiOrigin}/rate_limit`, { headers: this.headers() }).catch(() => null)
    const core = rate?.ok
      ? ((await rate.json()) as { resources?: { core?: { remaining: number; limit: number } } }).resources?.core
      : undefined

    if (!this.token) {
      return {
        ok: true,
        remaining: core?.remaining,
        limit: core?.limit,
        message: `No token set — anonymous access, ${core?.remaining ?? 60} of ${core?.limit ?? 60} requests left this hour.`,
      }
    }

    const res = await fetch(`${apiOrigin}/user`, { headers: this.headers() }).catch(() => null)
    if (!res) return { ok: false, message: 'Could not reach GitHub.' }
    if (res.status === 401) return { ok: false, message: 'GitHub rejected this token. It may be expired or revoked.' }
    if (res.status === 403) return { ok: false, message: 'Token is valid but forbidden here — check its scopes.' }
    if (!res.ok) return { ok: false, message: `GitHub returned ${res.status}.` }

    const user = (await res.json()) as { login?: string }
    // A fine-grained token with no Contents:read permission authenticates
    // fine and then fails on the first file read, so say what it can reach.
    const scopes = res.headers.get('x-oauth-scopes')
    return {
      ok: true,
      account: user.login,
      remaining: core?.remaining,
      limit: core?.limit,
      message:
        `Authenticated as ${user.login}. ` +
        `${core?.remaining?.toLocaleString() ?? '?'} of ${core?.limit?.toLocaleString() ?? '?'} requests left this hour.` +
        (scopes ? ` Scopes: ${scopes || 'fine-grained'}.` : ''),
    }
  }

  async listChangedFiles(repo: RepoRef, pr: number, ctx?: RequestCtx): Promise<string[] | null> {
    const paths: string[] = []
    for (let page = 1; page <= 10; page++) {
      const url =
        `${repo.apiOrigin}/repos/${repo.owner}/${repo.name}/pulls/${pr}/files` +
        `?per_page=100&page=${page}`
      const res = await fetchWithRetry(url, { headers: this.headers(), signal: ctx?.signal })
      if (!res.ok) return paths.length ? paths : null

      const batch = (await res.json()) as { filename: string; status: string }[]
      // A deleted file has nothing left to optimise.
      for (const f of batch) if (f.status !== 'removed') paths.push(f.filename)
      if (batch.length < 100) break
    }
    return paths
  }

  async fetchArchive(repo: RepoRef, ctx?: ArchiveCtx): Promise<ArchiveResult | null> {
    const url = `${repo.apiOrigin}/repos/${repo.owner}/${repo.name}/tarball/${repo.commitSha}`

    // Not fetchWithRetry: a partially consumed stream cannot be retried, and
    // the archive has its own much longer deadline.
    const res = await fetch(url, {
      headers: this.headers(),
      signal: ctx?.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)])
        : AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      redirect: 'follow',
    }).catch(() => null)

    if (!res?.ok || !res.body) return null

    let bytes = 0
    const files = await readTarGz(res.body, {
      accept: ctx?.accept ?? (() => true),
      signal: ctx?.signal,
      onProgress: (b, n) => { bytes = b; ctx?.onProgress?.(b, n) },
    })

    return { files: files.map((f) => ({ path: f.path, size: f.size, content: f.text })), bytes }
  }

  async resolve(parsed: ParsedRepoUrl, ref?: string, ctx?: RequestCtx): Promise<RepoRef> {
    const base = `${parsed.apiOrigin}/repos/${parsed.owner}/${parsed.name}`
    const repoRes = await fetchWithRetry(base, { headers: this.headers(), signal: ctx?.signal })
    if (repoRes.status === 404) {
      throw new RepoError(
        this.token
          ? 'Repository not found, or your token cannot see it.'
          : 'Repository not found. Private? Add a GitHub token in Settings.',
        'not-found',
      )
    }
    if (repoRes.status === 401) throw new RepoError('GitHub rejected your token.', 'auth')
    if (!repoRes.ok) throw new RepoError(`GitHub error ${repoRes.status}.`, 'unknown')

    const repo = (await repoRes.json()) as { default_branch: string }
    const wanted = ref ?? parsed.ref ?? repo.default_branch

    const commitRes = await fetchWithRetry(
      `${base}/commits/${encodeURIComponent(wanted)}`,
      { headers: this.headers(), signal: ctx?.signal },
    )
    if (!commitRes.ok) throw new RepoError(`No such branch, tag or commit: ${wanted}`, 'not-found')
    const commit = (await commitRes.json()) as { sha: string }

    return {
      forge: 'github',
      apiOrigin: parsed.apiOrigin,
      owner: parsed.owner,
      name: parsed.name,
      ref: wanted,
      commitSha: commit.sha,
    }
  }

  async listFiles(repo: RepoRef, ctx?: RequestCtx): Promise<RepoFile[]> {
    // One call for the whole tree. `truncated` means the repo exceeds GitHub's
    // 100k-entry cap — we tell the user rather than scanning a partial tree.
    const url = `${repo.apiOrigin}/repos/${repo.owner}/${repo.name}/git/trees/${repo.commitSha}?recursive=1`
    const res = await fetchWithRetry(
      url, { headers: this.headers(), signal: ctx?.signal }, 3, LIST_TIMEOUT_MS,
    )
    if (!res.ok) throw new RepoError(`Could not list files (${res.status}).`, 'unknown')

    const body = (await res.json()) as {
      truncated?: boolean
      tree: { path: string; type: string; size?: number }[]
    }
    if (body.truncated) {
      throw new RepoError(
        'This repository is too large for a full tree listing. Scan a subdirectory or a smaller branch.',
        'too-large',
      )
    }

    return body.tree
      .filter((n) => n.type === 'blob')
      .map((n) => ({ path: n.path, size: n.size ?? 0 }))
      .filter((f) => isScannable(f.path, f.size))
  }

  async readFile(repo: RepoRef, path: string, ctx?: RequestCtx): Promise<string> {
    // The raw endpoint avoids base64 round-tripping and is cheaper to parse.
    const url = `${repo.apiOrigin}/repos/${repo.owner}/${repo.name}/contents/${encodeURI(path)}?ref=${repo.commitSha}`
    const res = await fetchWithRetry(url, {
      headers: { ...this.headers(), accept: 'application/vnd.github.raw+json' },
      signal: ctx?.signal,
    })
    if (!res.ok) throw new RepoError(`Could not read ${path} (${res.status}).`, 'unknown')
    if (isOversized(res)) throw new RepoError(`Skipped oversized file: ${path}`, 'too-large')
    return res.text()
  }

  async listBranches(parsed: ParsedRepoUrl, ctx?: RequestCtx): Promise<string[]> {
    const url = `${parsed.apiOrigin}/repos/${parsed.owner}/${parsed.name}/branches?per_page=100`
    const res = await fetchWithRetry(url, { headers: this.headers(), signal: ctx?.signal })
    if (!res.ok) return []
    const body = (await res.json()) as { name: string }[]
    return body.map((b) => b.name)
  }
}
