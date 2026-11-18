/**
 * Regression tests for compressed response bodies from OpenAI-compatible relays.
 *
 * A relay may answer with `content-encoding: zstd` (or gzip / br / deflate)
 * while the fetch implementation does not decode it. The compressed bytes then
 * reach `JSON.parse` and surface as `returned invalid JSON`, which points at the
 * prompt or the site instead of the transport.
 *
 * These tests drive the exported `decodeCompressedBody` directly with real
 * compressed bytes so each branch is covered without touching the network.
 */
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { decodeCompressedBody, generateOpenAICompatibleImage } from '../src/openai-compatible.js'

const payload = Buffer.from(JSON.stringify({ data: [{ b64_json: 'AAAA', revised_prompt: '一张红色的苹果' }] }), 'utf8')

function asBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer)
}

describe('decodeCompressedBody: declared encodings', () => {
  it('decodes zstd when the header is declared', () => {
    const decoded = decodeCompressedBody(asBytes(zstdCompressSync(payload)), 'zstd')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('decodes gzip', () => {
    const decoded = decodeCompressedBody(asBytes(gzipSync(payload)), 'gzip')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('decodes brotli', () => {
    const decoded = decodeCompressedBody(asBytes(brotliCompressSync(payload)), 'br')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('decodes deflate', () => {
    const decoded = decodeCompressedBody(asBytes(deflateSync(payload)), 'deflate')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('tolerates a compound header such as "gzip, br" style lists', () => {
    const decoded = decodeCompressedBody(asBytes(gzipSync(payload)), 'gzip, identity')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })
})

describe('decodeCompressedBody: undeclared zstd', () => {
  it('decodes by magic number when the relay forgets the header', () => {
    const decoded = decodeCompressedBody(asBytes(zstdCompressSync(payload)), null)
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('decodes by magic number even when the declared encoding lies', () => {
    const decoded = decodeCompressedBody(asBytes(zstdCompressSync(payload)), 'identity')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })
})

describe('decodeCompressedBody: pass-through cases', () => {
  it('returns plain JSON untouched', () => {
    const decoded = decodeCompressedBody(asBytes(payload), null)
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('returns the bytes unchanged when the declaration disagrees with the body', () => {
    // Header says gzip, body is plain JSON: the runtime likely already decoded
    // it. Returning the input lets the caller's parser report the real cause.
    const decoded = decodeCompressedBody(asBytes(payload), 'gzip')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('keeps an empty body empty', () => {
    expect(decodeCompressedBody(new Uint8Array(), 'gzip').byteLength).toBe(0)
  })
})

describe('decodeCompressedBody: compound headers', () => {
  it('decodes every declared coding, in reverse application order', () => {
    // `Content-Encoding: gzip, zstd` means gzip was applied first, then zstd.
    const nested = zstdCompressSync(gzipSync(payload))
    const decoded = decodeCompressedBody(asBytes(nested), 'gzip, zstd')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('handles three stacked codings', () => {
    const nested = zstdCompressSync(brotliCompressSync(gzipSync(payload)))
    const decoded = decodeCompressedBody(asBytes(nested), 'gzip, br, zstd')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('ignores identity in the list', () => {
    const decoded = decodeCompressedBody(asBytes(gzipSync(payload)), 'gzip, identity')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('falls back to the zstd magic when the header names an unknown coding', () => {
    const decoded = decodeCompressedBody(asBytes(zstdCompressSync(payload)), 'something-new')
    expect(Buffer.from(decoded).toString('utf8')).toBe(payload.toString('utf8'))
  })
})

describe('decodeCompressedBody: decompressed size limit', () => {
  it('rejects a body that expands past the limit', () => {
    const compressed = asBytes(zstdCompressSync(payload))
    expect(() => decodeCompressedBody(compressed, 'zstd', 8)).toThrow(/exceeded the 8 byte limit after decompression/)
  })

  it('rejects before allocating: the limit is passed to the decompressor', () => {
    // 64MiB of zeros compresses to a few KiB. Without `maxOutputLength` the
    // whole 64MiB would be allocated before the size check could reject it.
    const bomb = asBytes(zstdCompressSync(Buffer.alloc(64 * 1024 * 1024)))
    expect(bomb.byteLength).toBeLessThan(64 * 1024)
    expect(() => decodeCompressedBody(bomb, 'zstd', 1024 * 1024)).toThrow(/exceeded the 1048576 byte limit after decompression/)
  })

  it('applies the limit to gzip as well', () => {
    const bomb = asBytes(gzipSync(Buffer.alloc(64 * 1024 * 1024)))
    expect(() => decodeCompressedBody(bomb, 'gzip', 1024 * 1024)).toThrow(/after decompression/)
  })

  it('applies the limit on the undeclared-magic path', () => {
    const bomb = asBytes(zstdCompressSync(Buffer.alloc(64 * 1024 * 1024)))
    expect(() => decodeCompressedBody(bomb, null, 1024 * 1024)).toThrow(/after decompression/)
  })

  it('accepts a body within the limit', () => {
    const compressed = asBytes(zstdCompressSync(payload))
    const decoded = decodeCompressedBody(compressed, 'zstd', payload.byteLength)
    expect(decoded.byteLength).toBe(payload.byteLength)
  })
})

/**
 * End-to-end proof of the bug this fixes: same relay response, compressed.
 *
 * Before the fix the compressed bytes reached `JSON.parse` and the request
 * failed with `returned invalid JSON`; after it, the same response yields an
 * image. The mock returns the compressed body as-is, exactly what a runtime
 * that ignores `content-encoding` hands to the parser.
 */
describe('generateOpenAICompatibleImage: compressed relay response', () => {
  const signal = AbortSignal.timeout(5000)
  const imageBytes = Buffer.from('image bytes')

  function compressedResponse(compress: (input: Buffer) => Buffer, encoding: string): Response {
    const body = compress(Buffer.from(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }), 'utf8'))
    return new Response(new Uint8Array(body), { headers: { 'content-type': 'application/json', 'content-encoding': encoding } })
  }

  it('parses a zstd body the runtime left compressed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => compressedResponse(zstdCompressSync, 'zstd')))
    const result = await generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 60_000, signal })
    expect(result.data).toEqual(new Uint8Array(imageBytes))
    expect(result.mediaType).toBe('image/png')
  })

  it('parses a gzip body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => compressedResponse(gzipSync, 'gzip')))
    const result = await generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 60_000, signal })
    expect(result.data).toEqual(new Uint8Array(imageBytes))
  })

  it('parses a brotli body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => compressedResponse(brotliCompressSync, 'br')))
    const result = await generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 60_000, signal })
    expect(result.data).toEqual(new Uint8Array(imageBytes))
  })

  it('parses a deflate body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => compressedResponse(deflateSync, 'deflate')))
    const result = await generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 60_000, signal })
    expect(result.data).toEqual(new Uint8Array(imageBytes))
  })

  it('still surfaces a genuinely broken body as invalid JSON', async () => {
    // Not every invalid-JSON failure is a compression problem: this body is
    // truncated mid-object, so the error must stay visible instead of being
    // swallowed by the decompression fallback.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data": [{"b64_json": "AA', { headers: { 'content-type': 'application/json' } })))
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 60_000, signal })).rejects.toThrow(/invalid JSON/)
  })
})
