/**
 * @vitest-environment jsdom
 *
 * The footer must report the version it actually is.
 *
 * It carried the literal `v0.1.0` while the package was at 1.2.0, so the panel
 * misreported itself by five minor versions. That is not cosmetic: the version
 * in the corner is what tells you whether the build in front of you contains a
 * fix, and a screenshot showing v0.1.0 was ambiguous evidence for exactly that
 * question. The MCP server injects its version from package.json at build time
 * for this reason — see the note in packages/mcp/tsup.config.ts, where a
 * hardcoded literal had the same failure mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Footer } from '../Footer'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubChrome(version?: string) {
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (p: string) => `chrome-extension://x/${p}`,
      ...(version ? { getManifest: () => ({ version }) } : {}),
    },
  })
}

describe('Footer version', () => {
  it('renders the version from the manifest', () => {
    stubChrome('1.2.0')
    render(<Footer />)
    expect(screen.getByText('v1.2.0')).toBeTruthy()
  })

  it('tracks the manifest rather than a literal', () => {
    stubChrome('9.9.9')
    render(<Footer />)
    expect(screen.getByText('v9.9.9')).toBeTruthy()
    expect(screen.queryByText('v0.1.0')).toBeNull()
  })

  it('renders without a version rather than crashing when the manifest is unavailable', () => {
    // The preview build renders these components outside an extension context,
    // where chrome.runtime.getManifest does not exist.
    stubChrome(undefined)
    expect(() => render(<Footer />)).not.toThrow()
    expect(screen.getByText('Privacy')).toBeTruthy()
  })
})
