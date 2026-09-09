import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TIMEOUT_MS, RepoError, fetchWithRetry, sleep } from '../repo/client'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

describe('fetchWithRetry timeout', () => {
  beforeEach(() => vi.useRealTimers())

  it('gives up on a request that never settles, instead of hanging forever', async () => {
    // The exact bug from the field: a connection that accepts and then stalls.
    // Before the fix this promise never resolved and the whole scan froze.
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    ) as unknown as typeof fetch

    const err = await fetchWithRetry('https://example.test/f', {}, 2, 40).catch((e) => e)
    expect(err).toBeInstanceOf(RepoError)
    expect((err as RepoError).kind).toBe('timeout')
  })

  it('retries a timeout and succeeds when the next attempt responds', async () => {
    let call = 0
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      call++
      if (call === 1) {
        return new Promise<Response>((_r, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
      return Promise.resolve(new Response('ok', { status: 200 }))
    }) as unknown as typeof fetch

    const res = await fetchWithRetry('https://example.test/f', {}, 3, 40)
    expect(res.status).toBe(200)
    expect(call).toBe(2)
  })

  it('reports a user cancel as cancelled, never as a timeout', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    ) as unknown as typeof fetch

    const p = fetchWithRetry('https://example.test/f', { signal: controller.signal }, 3, 5_000)
    setTimeout(() => controller.abort(), 20)
    const err = await p.catch((e) => e)
    expect((err as RepoError).kind).toBe('cancelled')
  })

  it('refuses to start a new attempt once cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch

    const err = await fetchWithRetry('https://example.test/f', { signal: controller.signal }).catch((e) => e)
    expect((err as RepoError).kind).toBe('cancelled')
    expect(spy).not.toHaveBeenCalled()
  })

  it('uses a 30s default so one stalled file cannot cost the scan', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
  })
})

describe('abortable sleep', () => {
  it('resolves normally', async () => {
    const started = Date.now()
    await sleep(20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const c = new AbortController()
    c.abort()
    await expect(sleep(10_000, c.signal)).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('rejects mid-wait rather than outliving a cancelled scan', async () => {
    const c = new AbortController()
    const p = sleep(10_000, c.signal)
    setTimeout(() => c.abort(), 20)
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
  })
})

describe('oversized response guard', () => {
  it('rejects a blob larger than the cap before reading its body', async () => {
    const { isOversized, MAX_FILE_BYTES } = await import('../repo/client')
    const big = new Response('x', { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } })
    const ok = new Response('x', { headers: { 'content-length': '2048' } })
    // GitLab omits sizes in the tree listing, so this header is the only place
    // the size is known before the body is streamed.
    const unknown = new Response('x')
    expect(isOversized(big)).toBe(true)
    expect(isOversized(ok)).toBe(false)
    expect(isOversized(unknown)).toBe(false)
  })
})
