import { parseRepoUrl } from './parse-url'

export interface DetectedRepo {
  /**
   * Pull request / merge request number, when the tab is on one.
   *
   * This is the moment that matters: a finding on a PR can still change the
   * code, while a repo-wide report is a one-time ritual whose value decays.
   */
  pullRequest?: number
  /** Canonical repo URL, stripped of the file path the user happened to be on. */
  url: string
  /** `owner/name`, for display. */
  label: string
  /** Branch or tag, when the page URL named one. */
  ref?: string
  forge: 'github' | 'gitlab'
}

/**
 * Read the active tab and, if it is a repository page, offer it.
 *
 * Deliberately conservative. A tab URL is a guess about intent, so anything
 * ambiguous is discarded rather than pre-filled with something wrong:
 *  - only http(s) pages (never the extension's own full-screen tab)
 *  - never a forge page that is not a repository (dashboards, settings,
 *    marketplace, explore, a user profile)
 *  - the URL is normalised back to the repository root, so opening a deep file
 *    link does not scan "a file"
 */
export function detectedFromUrl(rawUrl: string | undefined): DetectedRepo | null {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null

  let host: string
  let segments: string[]
  try {
    const u = new URL(rawUrl)
    host = u.hostname
    segments = u.pathname.split('/').filter(Boolean)
  } catch {
    return null
  }

  // Reserved first-segments that are never a repository owner.
  const RESERVED = new Set([
    'settings', 'notifications', 'explore', 'marketplace', 'pulls', 'issues',
    'dashboard', 'search', 'topics', 'sponsors', 'features', 'pricing', 'about',
    'login', 'signup', 'new', 'orgs', 'organizations', 'users', 'codespaces',
    'help', 'admin', '-', 'api', 'groups', 'projects', 'apps',
  ])
  if (segments.length > 0 && RESERVED.has(segments[0]!.toLowerCase())) return null

  // A single segment is an owner or group page, not a repository.
  if (segments.length < 2) return null

  const parsed = parseRepoUrl(rawUrl)
  if ('error' in parsed) return null

  // A GitLab group landing page parses as owner/name but is not a project.
  // Requiring a known repo sub-path, or exactly two segments, filters those.
  const isKnownHost = /(^|\.)github\.com$/i.test(host) || /(^|\.)gitlab\.com$/i.test(host)
  if (!isKnownHost && segments.length < 2) return null

  const base = parsed.forge === 'github'
    ? `https://${host}/${parsed.owner}/${parsed.name}`
    : `https://${host}/${parsed.owner}/${parsed.name}`

  return {
    url: base,
    label: `${parsed.owner}/${parsed.name}`,
    ref: parsed.ref,
    forge: parsed.forge,
    pullRequest: readPullRequestNumber(parsed.forge, segments),
  }
}

/**
 * `/owner/repo/pull/123` on GitHub, `/group/proj/-/merge_requests/45` on GitLab.
 * Only the number matters; any sub-tab (files, commits) still refers to it.
 */
function readPullRequestNumber(forge: 'github' | 'gitlab', segments: string[]): number | undefined {
  const marker = forge === 'github' ? 'pull' : 'merge_requests'
  const at = segments.indexOf(marker)
  if (at === -1) return undefined
  const n = Number(segments[at + 1])
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Queries the active tab. Returns null when nothing usable is open. */
export async function detectFromActiveTab(): Promise<DetectedRepo | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return detectedFromUrl(tabs[0]?.url)
  } catch {
    // No tabs permission, or nothing active. Detection is a convenience.
    return null
  }
}
