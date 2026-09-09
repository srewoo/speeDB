import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { readTar, readTarGz } from '../repo/tar'

/** Build a TAR byte stream so the parser is tested against real bytes. */
function tar(entries: { name: string; body: string; typeflag?: string; ustar?: boolean }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  const enc = new TextEncoder()

  for (const e of entries) {
    const header = new Uint8Array(512)
    const bodyBytes = enc.encode(e.body)

    let name = e.name
    let prefix = ''
    if (e.ustar && name.length > 100) {
      const cut = name.lastIndexOf('/', 100)
      prefix = name.slice(0, cut)
      name = name.slice(cut + 1)
    }

    header.set(enc.encode(name.slice(0, 100)), 0)
    header.set(enc.encode(bodyBytes.length.toString(8).padStart(11, '0') + '\0'), 124)
    header[156] = (e.typeflag ?? '0').charCodeAt(0)
    if (e.ustar) {
      header.set(enc.encode('ustar\0'), 257)
      header.set(enc.encode(prefix), 345)
    }

    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(bodyBytes.length / 512) * 512)
    padded.set(bodyBytes)
    blocks.push(padded)
  }

  blocks.push(new Uint8Array(1024)) // two terminating zero blocks
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const b of blocks) { out.set(b, at); at += b.length }
  return out
}

/** Emit in small chunks so entries straddle read boundaries, as they do live. */
function stream(bytes: Uint8Array, chunk = 137): ReadableStream<Uint8Array> {
  let at = 0
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) { c.close(); return }
      c.enqueue(bytes.slice(at, at + chunk))
      at += chunk
    },
  })
}

const acceptAll = { accept: () => true }

describe('tar reader', () => {
  it('reads entries and strips the top-level directory', async () => {
    // Forge archives wrap everything in one commit-named directory.
    const bytes = tar([
      { name: 'repo-a1b2c3/src/db.ts', body: 'SELECT 1' },
      { name: 'repo-a1b2c3/README.md', body: '# hi' },
    ])
    const files = await readTar(stream(bytes), acceptAll)
    expect(files.map((f) => f.path)).toEqual(['src/db.ts', 'README.md'])
    expect(files[0]!.text).toBe('SELECT 1')
  })

  it('reassembles entries split across read boundaries', async () => {
    const body = 'x'.repeat(5000)
    const bytes = tar([{ name: 'r/big.sql', body }])
    const files = await readTar(stream(bytes, 61), acceptAll)
    expect(files[0]!.text).toHaveLength(5000)
    expect(files[0]!.size).toBe(5000)
  })

  it('honours accept() so rejected files are never decoded', async () => {
    const seen: string[] = []
    const bytes = tar([
      { name: 'r/a.ts', body: 'a' },
      { name: 'r/node_modules/b.js', body: 'b' },
      { name: 'r/c.png', body: 'binary' },
    ])
    const files = await readTar(stream(bytes), {
      accept: (path) => { seen.push(path); return path.endsWith('.ts') },
    })
    expect(files.map((f) => f.path)).toEqual(['a.ts'])
    expect(seen).toEqual(['a.ts', 'node_modules/b.js', 'c.png'])
  })

  it('skips directories, symlinks and pax headers', async () => {
    const bytes = tar([
      { name: 'r/dir/', body: '', typeflag: '5' },
      { name: 'r/link', body: '', typeflag: '2' },
      { name: 'r/PaxHeaders/x', body: 'junk', typeflag: 'x' },
      { name: 'r/real.ts', body: 'ok' },
    ])
    const files = await readTar(stream(bytes), acceptAll)
    expect(files.map((f) => f.path)).toEqual(['real.ts'])
  })

  it('resolves a GNU long name from the preceding L entry', async () => {
    const long = 'r/' + 'nested/'.repeat(20) + 'deep.ts'
    const bytes = tar([
      { name: 'r/@LongLink', body: long, typeflag: 'L' },
      { name: 'r/ignored', body: 'content' },
    ])
    const files = await readTar(stream(bytes), acceptAll)
    expect(files[0]!.path).toBe(long.slice(2))
    expect(files[0]!.text).toBe('content')
  })

  it('joins a ustar prefix and name for long paths', async () => {
    const long = 'r/' + 'a/'.repeat(50) + 'file.ts'
    const bytes = tar([{ name: long, body: 'v', ustar: true }])
    const files = await readTar(stream(bytes), acceptAll)
    expect(files[0]!.path).toBe(long.slice(2))
  })

  it('refuses an archive larger than the safety limit', async () => {
    const bytes = tar([{ name: 'r/big.sql', body: 'y'.repeat(20_000) }])
    await expect(
      readTar(stream(bytes), { accept: () => true, maxTotalBytes: 4_096 }),
    ).rejects.toThrow(/safety limit/)
  })

  it('gunzips a real gzip stream', async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from(tar([{ name: 'r/q.sql', body: 'SELECT 2' }]))))
    const files = await readTarGz(stream(gz), acceptAll)
    expect(files[0]!).toMatchObject({ path: 'q.sql', text: 'SELECT 2' })
  })

  it('handles an empty archive without throwing', async () => {
    const files = await readTar(stream(new Uint8Array(1024)), acceptAll)
    expect(files).toEqual([])
  })
})
