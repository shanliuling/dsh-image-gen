import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { thumbUrlFor } from '../src/shared.js'
import { serveThumb } from '../src/thumb-route.js'

class FakeResponse {
  chunks: Buffer[] = []
  status = 0
  headers: Record<string, string> = {}
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.headers = { ...headers }
    return this
  }
  write(chunk: Buffer): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  end(chunk?: Buffer): void {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
  }
  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

const REF: ImageAttachmentRef = {
  attachmentId: 'sha256:' + 'b'.repeat(64) as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 3,
  width: 3840,
  height: 2160,
}

const VARIANT = {
  variantId: 'sha256:' + 'c'.repeat(64),
  data: Buffer.from('webp-bytes'),
  mediaType: 'image/webp' as const,
}

function getRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:8765', ...headers },
  } as unknown as IncomingMessage
}

function deps() {
  return { readImageRequest: vi.fn(async () => VARIANT) }
}

describe('thumbnail route', () => {
  it('serves the host-rendered variant with immutable caching', async () => {
    const readImageRequest = vi.fn(async () => VARIANT)
    const res = new FakeResponse()
    await serveThumb(getRequest(thumbUrlFor(REF)), res as unknown as ServerResponse, { readImageRequest })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/webp')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers.etag).toBe('"' + VARIANT.variantId + '"')
    expect(res.body().toString()).toBe('webp-bytes')
    expect(readImageRequest).toHaveBeenCalledWith(REF, { width: 320, height: 320, maxBytes: 96 * 1024 })
  })

  it('clamps the requested width', async () => {
    const readImageRequest = vi.fn(async () => VARIANT)
    await serveThumb(getRequest(thumbUrlFor(REF, 4096)), new FakeResponse() as unknown as ServerResponse, { readImageRequest })
    expect(readImageRequest).toHaveBeenCalledWith(REF, { width: 1024, height: 1024, maxBytes: 96 * 1024 })
    await serveThumb(getRequest(thumbUrlFor(REF, 1)), new FakeResponse() as unknown as ServerResponse, { readImageRequest })
    expect(readImageRequest).toHaveBeenLastCalledWith(REF, { width: 64, height: 64, maxBytes: 96 * 1024 })
  })

  it('answers 304 when the variant ETag matches', async () => {
    const res = new FakeResponse()
    await serveThumb(getRequest(thumbUrlFor(REF), { 'if-none-match': '"' + VARIANT.variantId + '"' }), res as unknown as ServerResponse, deps())
    expect(res.status).toBe(304)
    expect(res.body().length).toBe(0)
  })

  it('falls back to 404 when the backend cannot derive a variant', async () => {
    const res = new FakeResponse()
    await serveThumb(getRequest(thumbUrlFor(REF)), res as unknown as ServerResponse, { readImageRequest: vi.fn(async () => { throw new Error('unsupported') }) })
    expect(res.status).toBe(404)
  })

  it('rejects malformed refs and non-GET methods', async () => {
    const bad = new FakeResponse()
    await serveThumb(getRequest('/plugins/dsh-image-gen/thumb?ref=nope'), bad as unknown as ServerResponse, deps())
    expect(bad.status).toBe(400)
    const post = new FakeResponse()
    await serveThumb({ method: 'POST', url: thumbUrlFor(REF), headers: { host: '127.0.0.1:8765' } } as unknown as IncomingMessage, post as unknown as ServerResponse, deps())
    expect(post.status).toBe(405)
  })
})
