/**
 * Minimal TAR reader for repository archives.
 *
 * Both forges serve a whole repository as one gzipped tarball, which turns an
 * N-request ingest into a single request. The browser can gunzip natively via
 * DecompressionStream, so the only missing piece is a TAR parser — and TAR is
 * simple enough (512-byte headers, 512-byte-aligned payloads) that a focused
 * reader beats pulling in a dependency.
 */

export interface TarEntry {
  /** Path with the archive's top-level directory stripped. */
  path: string
  size: number
  /** Decoded text. Only populated for entries the caller accepts. */
  text: string
}

const BLOCK = 512

/** Header field offsets, from the ustar specification. */
const OFF = {
  name: 0, size: 124, typeflag: 156, magic: 257, prefix: 345,
} as const

export interface TarReadOptions {
  /** Decide whether to keep an entry before its bytes are decoded. */
  accept: (path: string, size: number) => boolean
  /** Hard ceiling on total decoded bytes, so a hostile archive cannot OOM us. */
  maxTotalBytes?: number
  signal?: AbortSignal
  onProgress?: (bytesRead: number, filesKept: number) => void
}

/** 256MB of decompressed source is far beyond any real repository. */
const DEFAULT_MAX_TOTAL = 256 * 1024 * 1024

export async function readTarGz(
  body: ReadableStream<Uint8Array<ArrayBufferLike>>,
  opts: TarReadOptions,
): Promise<TarEntry[]> {
  // The DOM lib types DecompressionStream's writable side as BufferSource,
  // which does not unify with ReadableStream<Uint8Array>. The pairing is
  // correct at runtime; the cast is the narrowest way to say so.
  const stream = body.pipeThrough(
    new DecompressionStream('gzip') as unknown as ReadableWritablePair<
      Uint8Array<ArrayBufferLike>,
      Uint8Array<ArrayBufferLike>
    >,
  )
  return readTar(stream, opts)
}

export async function readTar(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  opts: TarReadOptions,
): Promise<TarEntry[]> {
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })

  const entries: TarEntry[] = []
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let totalRead = 0
  let rootPrefix: string | null = null
  /** Set by a GNU long-name (typeflag 'L') header for the following entry. */
  let pendingLongName: string | null = null

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('cancelled')

      const { done, value } = await reader.read()
      if (value) {
        buffer = concat(buffer, value)
        totalRead += value.length
        if (totalRead > maxTotal) {
          throw new Error('Archive is larger than the safety limit.')
        }
        opts.onProgress?.(totalRead, entries.length)
      }

      // Drain every complete entry currently in the buffer.
      for (;;) {
        if (buffer.length < BLOCK) break

        const header = buffer.subarray(0, BLOCK)
        if (isZeroBlock(header)) {
          // Two zero blocks terminate the archive; one may be padding.
          buffer = buffer.subarray(BLOCK)
          continue
        }

        const size = parseOctal(header, OFF.size, 12)
        const padded = Math.ceil(size / BLOCK) * BLOCK
        if (buffer.length < BLOCK + padded) break // need more bytes

        const typeflag = String.fromCharCode(header[OFF.typeflag] ?? 0)
        const payload = buffer.subarray(BLOCK, BLOCK + size)
        buffer = buffer.subarray(BLOCK + padded)

        let name = pendingLongName ?? readName(header, decoder)
        pendingLongName = null

        // GNU long name: this entry's payload is the *next* entry's path.
        if (typeflag === 'L') {
          pendingLongName = decoder.decode(payload).replace(/\0+$/, '')
          continue
        }
        // pax extended headers and directories carry no file content.
        if (typeflag === 'x' || typeflag === 'g' || typeflag === '5') continue
        // Regular file is '0' or NUL; anything else (link, device) is skipped.
        if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') continue

        // Archives are wrapped in a single top-level directory named after the
        // commit. Strip it so paths match what the forge APIs report.
        if (rootPrefix === null) {
          const slash = name.indexOf('/')
          rootPrefix = slash === -1 ? '' : name.slice(0, slash + 1)
        }
        if (rootPrefix && name.startsWith(rootPrefix)) name = name.slice(rootPrefix.length)
        if (!name) continue

        if (!opts.accept(name, size)) continue
        entries.push({ path: name, size, text: decoder.decode(payload) })
      }

      if (done) break
    }
  } finally {
    reader.releaseLock()
  }

  return entries
}

function readName(header: Uint8Array<ArrayBufferLike>, decoder: TextDecoder): string {
  const name = readString(header, OFF.name, 100, decoder)
  // ustar splits long paths across prefix + name.
  const isUstar = readString(header, OFF.magic, 5, decoder) === 'ustar'
  if (!isUstar) return name
  const prefix = readString(header, OFF.prefix, 155, decoder)
  return prefix ? `${prefix}/${name}` : name
}

function readString(buf: Uint8Array<ArrayBufferLike>, offset: number, length: number, decoder: TextDecoder): string {
  const slice = buf.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end)).trim()
}

function parseOctal(buf: Uint8Array<ArrayBufferLike>, offset: number, length: number): number {
  const slice = buf.subarray(offset, offset + length)

  // GNU base-256 encoding for sizes that do not fit in 11 octal digits.
  if ((slice[0] ?? 0) & 0x80) {
    let value = 0
    for (let i = 1; i < slice.length; i++) value = value * 256 + (slice[i] ?? 0)
    return value
  }

  let out = 0
  for (const byte of slice) {
    if (byte === 0 || byte === 32) continue
    if (byte < 48 || byte > 55) break
    out = out * 8 + (byte - 48)
  }
  return out
}

function isZeroBlock(block: Uint8Array<ArrayBufferLike>): boolean {
  for (const b of block) if (b !== 0) return false
  return true
}

function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
