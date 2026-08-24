import { describe, expect, it } from 'vitest'
import { parseRepoUrl } from '../repo/parse-url'

describe('parseRepoUrl', () => {
  it('parses a plain GitHub URL', () => {
    expect(parseRepoUrl('https://github.com/facebook/react')).toEqual({
      forge: 'github', apiOrigin: 'https://api.github.com', owner: 'facebook', name: 'react', ref: undefined,
    })
  })

  it('picks up the branch from a GitHub tree URL', () => {
    const r = parseRepoUrl('https://github.com/facebook/react/tree/v18/packages')
    expect(r).toMatchObject({ forge: 'github', owner: 'facebook', name: 'react', ref: 'v18' })
  })

  it('strips a .git suffix and handles SSH remotes', () => {
    expect(parseRepoUrl('git@github.com:owner/repo.git')).toMatchObject({
      forge: 'github', owner: 'owner', name: 'repo',
    })
  })

  it('accepts bare owner/repo as GitHub', () => {
    expect(parseRepoUrl('vercel/next.js')).toMatchObject({ forge: 'github', name: 'next.js' })
  })

  it('keeps nested GitLab subgroups in the owner path', () => {
    expect(parseRepoUrl('https://gitlab.com/mindtickle/migrated-call-ai/access-control')).toMatchObject({
      forge: 'gitlab', owner: 'mindtickle/migrated-call-ai', name: 'access-control',
    })
  })

  it('reads the ref from a GitLab /-/tree/ URL without eating it into the path', () => {
    expect(parseRepoUrl('https://gitlab.com/group/sub/proj/-/tree/develop')).toMatchObject({
      forge: 'gitlab', owner: 'group/sub', name: 'proj', ref: 'develop',
    })
  })

  it('routes a self-hosted host to the GitLab client', () => {
    expect(parseRepoUrl('https://git.corp.internal/team/service')).toMatchObject({
      forge: 'gitlab', apiOrigin: 'https://git.corp.internal/api',
    })
  })

  it('rejects junk with a message rather than throwing', () => {
    expect(parseRepoUrl('not a url')).toHaveProperty('error')
    expect(parseRepoUrl('')).toHaveProperty('error')
  })
})
