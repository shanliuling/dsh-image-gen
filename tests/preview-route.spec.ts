import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { previewUrlFor } from '../src/shared.js'
import { servePreview } from '../src/thumb-route.js'

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
  data: Buffer.from('jpeg-bytes'),
  mediaType: 'image/jpeg' as const,
}

function getRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method: 'GET', url, headers: { host: '127.0.0.1:8765', ...headers } } as unknown as IncomingMessage
}

function deps() {
  return { readImageRequest: vi.fn(async () => VARIANT) }
}

describe('preview route', () => {
  it('serves a 1600 px variant with immutable caching', async () => {
    const readImageRequest = vi.fn(async () => VARIANT)
    const res = new FakeResponse()
    await servePreview(getRequest(previewUrlFor(REF)), res as unknown as ServerResponse, { readImageRequest })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers.etag).toBe('"' + VARIANT.variantId + '"')
    expect(res.body().toString()).toBe('jpeg-bytes')
    expect(readImageRequest).toHaveBeenCalledWith(REF, { width: 1600, height: 1600, maxBytes: 512 * 1024 })
  })

  it('clamps the requested width between 256 and 2048', async () => {
    const readImageRequest = vi.fn(async () => VARIANT)
    const url = previewUrlFor(REF) + '&w=9999'
    await servePreview(getRequest(url), new FakeResponse() as unknown as ServerResponse, { readImageRequest })
    expect(readImageRequest).toHaveBeenLastCalledWith(REF, { width: 2048, height: 2048, maxBytes: 512 * 1024 })
    const small = previewUrlFor(REF) + '&w=1'
    await servePreview(getRequest(small), new FakeResponse() as unknown as ServerResponse, { readImageRequest })
    expect(readImageRequest).toHaveBeenLastCalledWith(REF, { width: 256, height: 256, maxBytes: 512 * 1024 })
  })

  it('answers 304 when the variant ETag matches', async () => {
    const res = new FakeResponse()
    await servePreview(getRequest(previewUrlFor(REF), { 'if-none-match': '"' + VARIANT.variantId + '"' }), res as unknown as ServerResponse, deps())
    expect(res.status).toBe(304)
    expect(res.body().length).toBe(0)
  })

  it('falls back to 404 when the backend cannot derive a variant', async () => {
    const res = new FakeResponse()
    await servePreview(getRequest(previewUrlFor(REF)), res as unknown as ServerResponse, { readImageRequest: vi.fn(async () => { throw new Error('unsupported') }) })
    expect(res.status).toBe(404)
  })

  it('rejects malformed refs and non-GET methods', async () => {
    const bad = new FakeResponse()
    await servePreview(getRequest('/plugins/dsh-image-gen/preview?ref=nope'), bad as unknown as ServerResponse, deps())
    expect(bad.status).toBe(400)
    const post = new FakeResponse()
    await servePreview({ method: 'POST', url: previewUrlFor(REF), headers: { host: '127.0.0.1:8765' } } as unknown as IncomingMessage, post as unknown as ServerResponse, deps())
    expect(post.status).toBe(405)
  })
})
