import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { imageUrlFor } from '../src/shared.js'
import { serveImage } from '../src/image-route.js'

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
  attachmentId: 'sha256:' + 'a'.repeat(64) as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

function getRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:8765', ...headers },
  } as unknown as IncomingMessage
}

function postRequest(payload: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage
  Object.assign(stream, {
    method: 'POST',
    url: '/plugins/dsh-image-gen/image',
    headers: { host: '127.0.0.1:8765', 'content-type': 'application/json' },
  })
  return stream
}

const deps = {
  readImage: async (ref: ImageAttachmentRef) => ({ ref, data: Buffer.from('png') }),
}

describe('image route GET form', () => {
  it('serves bytes with an immutable cache header and ETag', async () => {
    const res = new FakeResponse()
    await serveImage(getRequest(imageUrlFor(REF)), res as unknown as ServerResponse, deps)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers.etag).toBe('"' + String(REF.attachmentId) + '"')
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.body().toString()).toBe('png')
  })

  it('answers 304 when the ETag matches', async () => {
    const res = new FakeResponse()
    await serveImage(getRequest(imageUrlFor(REF), { 'if-none-match': '"' + String(REF.attachmentId) + '"' }), res as unknown as ServerResponse, deps)
    expect(res.status).toBe(304)
    expect(res.body().length).toBe(0)
  })

  it('rejects malformed references', async () => {
    const res = new FakeResponse()
    await serveImage(getRequest('/plugins/dsh-image-gen/image?ref=not-base64'), res as unknown as ServerResponse, deps)
    expect(res.status).toBe(400)
  })

  it('keeps the POST form working', async () => {
    const res = new FakeResponse()
    await serveImage(postRequest({ attachment: REF }), res as unknown as ServerResponse, deps)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body().toString()).toBe('png')
  })
})
