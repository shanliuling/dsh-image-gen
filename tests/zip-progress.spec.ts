import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { serveZip } from '../src/zip-route.js'
import { serveZipProgress } from '../src/zip-progress.js'

class FakeResponse {
  chunks: Buffer[] = []
  status = 0
  headers: Record<string, string> = {}
  writableEnded = false
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.headers = { ...headers }
    return this
  }
  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
    this.writableEnded = true
  }
  body(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function request(method: string, url: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:8765' } })
  return req
}

describe('zip progress jobs', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('rejects malformed tokens and accepts client-generated ids', async () => {
    const mod = await import('../src/zip-progress.js')
    expect(mod.isValidZipToken('abc')).toBe(false)
    expect(mod.isValidZipToken('x'.repeat(65))).toBe(false)
    expect(mod.isValidZipToken('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
  })

  it('streams progress events and a final state', async () => {
    const mod = await import('../src/zip-progress.js')
    mod.createZipJob('123e4567-e89b-12d3-a456-426614174000', 5)
    mod.updateZipJob('123e4567-e89b-12d3-a456-426614174000', 2)

    const res = new FakeResponse()
    mod.serveZipProgress(request('GET', '/plugins/dsh-image-gen/zip/progress?token=123e4567-e89b-12d3-a456-426614174000'), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body()).toContain('"done":2')
    expect(res.body()).toContain('"total":5')

    mod.finishZipJob('123e4567-e89b-12d3-a456-426614174000', 'done')
    expect(res.body()).toContain('"state":"done"')
    expect(res.body()).toContain('"done":5')
    expect(res.writableEnded).toBe(true)
  })

  it('cancels a running export', async () => {
    const mod = await import('../src/zip-progress.js')
    mod.createZipJob('123e4567-e89b-12d3-a456-426614174000', 5)
    expect(mod.cancelZipJob('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(mod.isZipJobCancelled('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(mod.cancelZipJob('missing-token-123')).toBe(false)

    const res = new FakeResponse()
    mod.serveZipCancel(request('POST', '/plugins/dsh-image-gen/zip/cancel?token=123e4567-e89b-12d3-a456-426614174000'), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
    expect(res.body()).toBe('{"ok":true}')
  })

  it('finishes the job with an error when the archive request is rejected', async () => {
    const mod = await import('../src/zip-progress.js')
    const token = '123e4567-e89b-12d3-a456-426614174000'
    const body = new URLSearchParams({ items: JSON.stringify([]), token }).toString()
    const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
    Object.assign(stream, { method: 'POST', url: '/plugins/dsh-image-gen/zip', headers: { host: '127.0.0.1:8765', 'content-type': 'application/x-www-form-urlencoded' } })
    const res = new FakeResponse()
    await serveZip(stream, res as unknown as ServerResponse, { readImage: async () => { throw new Error('unused') } })
    expect(res.status).toBe(400)

    const sse = new FakeResponse()
    serveZipProgress(request('GET', '/plugins/dsh-image-gen/zip/progress?token=' + token), sse as unknown as ServerResponse)
    expect(sse.status).toBe(200)
    expect(sse.body()).toContain('"state":"error"')
    expect(sse.writableEnded).toBe(true)
  })

  it('answers 404 for malformed tokens and waits for a valid one', async () => {
    const mod = await import('../src/zip-progress.js')
    const bad = new FakeResponse()
    mod.serveZipProgress(request('GET', '/plugins/dsh-image-gen/zip/progress?token=bad'), bad as unknown as ServerResponse)
    expect(bad.status).toBe(404)

    const waiting = new FakeResponse()
    mod.serveZipProgress(request('GET', '/plugins/dsh-image-gen/zip/progress?token=123e4567-e89b-12d3-a456-426614174000'), waiting as unknown as ServerResponse)
    expect(waiting.status).toBe(200)
    mod.createZipJob('123e4567-e89b-12d3-a456-426614174000', 3)
    mod.updateZipJob('123e4567-e89b-12d3-a456-426614174000', 1)
    expect(waiting.body()).toContain('"done":1')
    expect(waiting.body()).toContain('"total":3')
  })
})
