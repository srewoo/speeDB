import type { Forge } from '@/core/types'

export interface ParsedRepoUrl {
  forge: Forge
  apiOrigin: string
  owner: string
  name: string
  ref?: string
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * Accepts the shapes people actually paste:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/some/dir
 *   https://gitlab.com/group/subgroup/repo/-/tree/develop
 *   git@github.com:owner/repo.git
 *   owner/repo
 *
 * GitLab subgroups are the awkward case: everything before the `/-/` marker
 * (minus the trailing repo name) is the group path, and it may nest arbitrarily.
 */
export function parseRepoUrl(input: string): ParsedRepoUrl | { error: string } {
  const raw = input.trim().replace(/\.git$/, '')
  if (!raw) return { error: 'Enter a repository URL.' }

  // Bare owner/repo defaults to GitHub.
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    const [owner, name] = raw.split('/') as [string, string]
    return { forge: 'github', apiOrigin: 'https://api.github.com', owner, name }
  }

  // scp-style SSH remote.
  const ssh = /^git@([\w.-]+):(.+)$/.exec(raw)
  const normalised = ssh ? `https://${ssh[1]}/${ssh[2]}` : raw

  let url: URL
  try {
    url = new URL(normalised)
  } catch {
    return { error: 'That is not a valid URL. Try https://github.com/owner/repo' }
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return { error: 'URL is missing the owner or repository name.' }

  if (GITHUB_HOSTS.has(url.hostname)) {
    const [owner, name, kind, ...rest] = segments as string[]
    const ref = (kind === 'tree' || kind === 'blob') && rest.length ? rest[0] : undefined
    return { forge: 'github', apiOrigin: 'https://api.github.com', owner: owner!, name: name!, ref }
  }

  // Anything else is treated as GitLab (gitlab.com or self-hosted).
  const dashAt = segments.indexOf('-')
  const pathParts = dashAt === -1 ? segments : segments.slice(0, dashAt)
  if (pathParts.length < 2) return { error: 'URL is missing the group or project name.' }

  const name = pathParts[pathParts.length - 1]!
  const owner = pathParts.slice(0, -1).join('/')
  let ref: string | undefined
  if (dashAt !== -1) {
    const after = segments.slice(dashAt + 1)
    if ((after[0] === 'tree' || after[0] === 'blob') && after[1]) ref = after[1]
  }

  return { forge: 'gitlab', apiOrigin: `${url.origin}/api`, owner, name, ref }
}
