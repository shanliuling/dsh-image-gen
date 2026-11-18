/**
 * Pins the *mechanism* of the decompression size limit.
 *
 * The size-limit tests in `openai-compat-compressed-body.spec.ts` assert the
 * outcome only: a decoded body over the limit throws `ImageResponseTooLarge`.
 * That outcome survives the removal of `maxOutputLength` — the declared
 * zstd/gzip paths would still decode the whole 64MiB and then trip the
 * post-decode check with the identical message. The regression is invisible
 * from the outside; the only difference is that the buffer was already
 * allocated, which is exactly what the limit exists to prevent (a few KiB of
 * compressed body expanding to hundreds of MiB before anyone checks).
 *
 * So this file watches the zlib calls themselves: every decompression must
 * receive `maxOutputLength` equal to the caller's limit. Wrapping the decoders
 * is the only way to observe that, hence the module mock.
 */
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeCompressedBody } from '../src/openai-compatible.js'

/** Records what each decoder was called with, populated by the mock below. */
const recorder = vi.hoisted(() => ({
  calls: [] as { coding: string; options: Record<string, unknown> }[],
}))

vi.mock('node:zlib', async importOriginal => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  type Decode = (input: Buffer, options?: { maxOutputLength?: number }) => Buffer
  // Keep the real decoder, record the options it was handed, then delegate.
  const wrap = (coding: string, decode: Decode): Decode => (input, options) => {
    recorder.calls.push({ coding, options: { ...options } })
    return decode(input, options)
  }
  return {
    ...actual,
    zstdDecompressSync: wrap('zstd', actual.zstdDecompressSync as Decode),
    gunzipSync: wrap('gzip', actual.gunzipSync as Decode),
    brotliDecompressSync: wrap('br', actual.brotliDecompressSync as Decode),
    inflateSync: wrap('deflate', actual.inflateSync as Decode),
  }
})

const LIMIT = 1024 * 1024
/** 64MiB of zeros: a few KiB compressed, far past any limit under test. */
const ZEROS = Buffer.alloc(64 * 1024 * 1024)

function asBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer)
}

beforeEach(() => {
  recorder.calls.length = 0
})

describe('decodeCompressedBody: the limit must reach the decoder', () => {
  it('passes maxOutputLength to the declared zstd decoder', () => {
    // Without `maxOutputLength` this still throws after decompression, which is
    // why the outcome-level test cannot catch the removal — this can.
    const bomb = asBytes(zstdCompressSync(ZEROS))
    expect(() => decodeCompressedBody(bomb, 'zstd', LIMIT)).toThrow(/exceeded the 1048576 byte limit/)
    expect(recorder.calls).toEqual([{ coding: 'zstd', options: { maxOutputLength: LIMIT } }])
  })

  it('passes maxOutputLength to the declared gzip decoder', () => {
    const bomb = asBytes(gzipSync(ZEROS))
    expect(() => decodeCompressedBody(bomb, 'gzip', LIMIT)).toThrow(/exceeded the 1048576 byte limit/)
    expect(recorder.calls).toEqual([{ coding: 'gzip', options: { maxOutputLength: LIMIT } }])
  })

  it('passes maxOutputLength to every stage of a stacked header', () => {
    // `Content-Encoding: gzip, zstd` is decoded zstd-then-gzip.
    const nested = asBytes(zstdCompressSync(gzipSync(ZEROS)))
    expect(() => decodeCompressedBody(nested, 'gzip, zstd', LIMIT)).toThrow(/exceeded the 1048576 byte limit/)
    expect(recorder.calls).toEqual([
      { coding: 'zstd', options: { maxOutputLength: LIMIT } },
      { coding: 'gzip', options: { maxOutputLength: LIMIT } },
    ])
  })

  it('leaves the decoder unbounded when the caller sets no limit', () => {
    // The default path must stay unbounded: no limit was requested, so none is
    // invented. A bounded call here would silently truncate valid bodies.
    const decoded = decodeCompressedBody(asBytes(zstdCompressSync(Buffer.from('{"data":[]}'))), 'zstd')
    expect(Buffer.from(decoded).toString('utf8')).toBe('{"data":[]}')
    expect(recorder.calls).toEqual([{ coding: 'zstd', options: {} }])
  })
})
