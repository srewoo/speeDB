import { describe, expect, it } from 'vitest'
import { detectedFromUrl } from '../repo/detect-tab'

describe('detectedFromUrl', () => {
  it('detects a plain GitHub repo page', () => {
    expect(detectedFromUrl('https://github.com/facebook/react')).toMatchObject({
      url: 'https://github.com/facebook/react', label: 'facebook/react', forge: 'github',
    })
  })

  it('normalises a deep file link back to the repository root', () => {
    // Opening a single file should scan the repo, not "a file".
    const d = detectedFromUrl('https://github.com/facebook/react/blob/main/packages/react/index.js')
    expect(d?.url).toBe('https://github.com/facebook/react')
    expect(d?.ref).toBe('main')
  })

  it('carries the branch from a tree URL', () => {
    expect(detectedFromUrl('https://github.com/vercel/next.js/tree/canary')?.ref).toBe('canary')
  })

  it('handles nested GitLab subgroups', () => {
    expect(detectedFromUrl('https://gitlab.com/mindtickle/supportops/hermes/-/tree/main')).toMatchObject({
      url: 'https://gitlab.com/mindtickle/supportops/hermes',
      label: 'mindtickle/supportops/hermes',
      ref: 'main',
      forge: 'gitlab',
    })
  })

  it('detects a self-hosted GitLab project', () => {
    expect(detectedFromUrl('https://git.corp.internal/team/service')).toMatchObject({
      label: 'team/service', forge: 'gitlab',
    })
  })

  it('ignores forge pages that are not repositories', () => {
    for (const url of [
      'https://github.com/settings/tokens',
      'https://github.com/notifications',
      'https://github.com/explore',
      'https://github.com/marketplace/actions/checkout',
      'https://gitlab.com/dashboard/projects',
      'https://gitlab.com/-/profile',
      'https://github.com/facebook',        // owner page, not a repo
      'https://gitlab.com/groups/mindtickle',
    ]) {
      expect(detectedFromUrl(url), url).toBeNull()
    }
  })

  it('ignores non-http pages, including our own extension tab', () => {
    expect(detectedFromUrl('chrome-extension://abcdef/src/fullscreen/index.html')).toBeNull()
    expect(detectedFromUrl('chrome://extensions')).toBeNull()
    expect(detectedFromUrl('about:blank')).toBeNull()
    expect(detectedFromUrl(undefined)).toBeNull()
    expect(detectedFromUrl('')).toBeNull()
  })

  it('ignores unparseable input rather than throwing', () => {
    expect(detectedFromUrl('https://')).toBeNull()
    expect(detectedFromUrl('not a url at all')).toBeNull()
  })
})
