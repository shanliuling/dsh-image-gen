import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:http'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { serveImport, type ImportRouteDeps } from '../src/import-route.js'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64')

function attachmentRef(id: string): ImageAttachmentRef {
  return { attachmentId: id, mediaType: 'image/png', bytes: PNG_BYTES.byteLength, width: 1, height: 1 }
}

describe('import route', () => {
  let server: Server
  let serverUrl: string
  let saved: Array<{ data: Uint8Array; mediaType: string; name?: string }>
  let failNextSave: Error | undefined
  let nextAttachment: ImageAttachmentRef | undefined

  const deps: ImportRouteDeps = {
    saveImage: async image => {
      if (failNextSave !== undefined) {
        const error = failNextSave
        failNextSave = undefined
        throw error
      }
      saved.push(image)
      return nextAttachment ?? attachmentRef(`att-${String(saved.length)}`)
    },
    maxImageBytes: 1024,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }

  beforeEach(() => {
    saved = []
    failNextSave = undefined
    nextAttachment = undefined
    server = createServer((req, res) => {
      void serveImport(req, res, deps).catch(() => {
        res.statusCode = 500
        res.end()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  async function listen(): Promise<void> {
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  }

  async function post(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; payload: unknown }> {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, payload: await response.json().catch(() => undefined) }
  }

  it('keeps the raw copy when the attachment layer normalizes the image', async () => {
    await listen()
    nextAttachment = { attachmentId: 'att-normalized', mediaType: 'image/jpeg', bytes: 2, width: 1, height: 1 }
    const saveOriginal = vi.fn(async () => ({ key: 'a'.repeat(64), bytes: PNG_BYTES.byteLength, mediaType: 'image/png' as const }))
    deps.saveOriginal = saveOriginal
    try {
      const { status, payload } = await post({ images: [{ data: PNG_BASE64, mediaType: 'image/png' }] })
      expect(status).toBe(200)
      expect((payload as { images: { original?: { key: string } }[] }).images[0]?.original?.key).toBe('a'.repeat(64))
      expect(saveOriginal).toHaveBeenCalledTimes(1)
      expect(saveOriginal.mock.calls[0]?.[0]).toMatchObject({ mediaType: 'image/png' })
    } finally {
      delete deps.saveOriginal
    }
  })

  it('saves each picked image and returns its attachment ref', async () => {
    await listen()
    const { status, payload } = await post({
      images: [
        { data: PNG_BASE64, mediaType: 'image/png', name: 'cat.png' },
        { data: PNG_BASE64, mediaType: 'image/webp' },
      ],
    })
    expect(status).toBe(200)
    expect(payload).toEqual({
      images: [{ attachment: attachmentRef('att-1') }, { attachment: attachmentRef('att-2') }],
      failures: [],
    })
    expect(saved).toEqual([
      { data: PNG_BYTES, mediaType: 'image/png', name: 'cat.png' },
      { data: PNG_BYTES, mediaType: 'image/webp' },
    ])
  })

  it('rejects non-POST methods and non-JSON bodies', async () => {
    await listen()
    const get = await fetch(serverUrl, { method: 'GET' })
    expect(get.status).toBe(405)
    expect(await get.json()).toEqual({ error: 'method-not-allowed' })
    const text = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    })
    expect(text.status).toBe(415)
    expect(await text.json()).toEqual({ error: 'json-required' })
  })

  it('rejects cross-origin uploads', async () => {
    await listen()
    const { status, payload } = await post({ images: [{ data: PNG_BASE64, mediaType: 'image/png' }] }, { origin: 'http://evil.example' })
    expect(status).toBe(403)
    expect(payload).toEqual({ error: 'origin-rejected' })
  })

  it('rejects empty and oversized image arrays', async () => {
    await listen()
    for (const images of [[], Array.from({ length: 9 }, () => ({ data: PNG_BASE64, mediaType: 'image/png' }))]) {
      const { status, payload } = await post({ images })
      expect(status).toBe(400)
      expect(payload).toEqual({ error: 'invalid-image-count' })
    }
  })

  it('rejects undecodable JSON bodies', async () => {
    await listen()
    const { status, payload } = await post('{not json')
    expect(status).toBe(400)
    expect(payload).toEqual({ error: 'invalid-request' })
  })

  it('reports per-image failures without dropping the valid items', async () => {
    await listen()
    const { status, payload } = await post({
      images: [
        { mediaType: 'image/png' },
        { data: PNG_BASE64, mediaType: 'image/bmp' },
        { data: '', mediaType: 'image/png' },
        { data: 'A'.repeat(2048), mediaType: 'image/png' },
        { data: PNG_BASE64, mediaType: 'image/png' },
      ],
    })
    expect(status).toBe(200)
    const result = payload as { images: { attachment: ImageAttachmentRef }[]; failures: { index: number; error: string }[] }
    expect(result.images).toEqual([{ attachment: attachmentRef('att-1') }])
    expect(result.failures.map(failure => failure.index)).toEqual([0, 1, 2, 3])
    expect(result.failures[0].error).toBe('invalid-item')
    expect(result.failures[1].error).toContain('unsupported-media-type')
    expect(result.failures[2].error).toContain('size-out-of-range')
    expect(result.failures[3].error).toContain('size-out-of-range')
  })

  it('warms a thumbnail for every saved attachment', async () => {
    const warmed: string[] = []
    const warmServer = createServer((req, res) => {
      void serveImport(req, res, {
        saveImage: async () => attachmentRef('att-warm'),
        maxImageBytes: 1024,
        mediaTypes: ['image/png'],
        warmThumbnail: ref => { warmed.push(String(ref.attachmentId)) },
      })
    })
    await new Promise<void>(resolve => warmServer.listen(0, '127.0.0.1', resolve))
    try {
      const port = (warmServer.address() as AddressInfo).port
      const response = await fetch('http://127.0.0.1:' + String(port) + '/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ images: [{ data: PNG_BASE64, mediaType: 'image/png' }] }),
      })
      expect(response.status).toBe(200)
      expect(warmed).toEqual(['att-warm'])
    } finally {
      await new Promise<void>(resolve => { warmServer.close(() => { resolve() }) })
    }
  })

  it('reports saveImage errors as a stable code without leaking details', async () => {
    await listen()
    failNextSave = new Error('disk-full /var/lib/postgresql/pgdata volume 7f3a')
    const { status, payload } = await post({ images: [{ data: PNG_BASE64, mediaType: 'image/png' }] })
    expect(status).toBe(200)
    expect((payload as { failures: { index: number; error: string }[] }).failures).toEqual([{ index: 0, error: 'save-failed' }])
  })

  it('rejects null JSON bodies without throwing', async () => {
    await listen()
    const { status, payload } = await post('null')
    expect(status).toBe(400)
    expect(payload).toEqual({ error: 'invalid-image-count' })
  })

  it('reports null image items as indexed failures', async () => {
    await listen()
    const { status, payload } = await post({ images: [null, { data: PNG_BASE64, mediaType: 'image/png' }] })
    expect(status).toBe(200)
    const result = payload as { images: unknown[]; failures: { index: number; error: string }[] }
    expect(result.images).toHaveLength(1)
    expect(result.failures).toEqual([{ index: 0, error: 'invalid-item' }])
  })

  it('rejects base64 payloads containing characters outside the alphabet', async () => {
    await listen()
    const { status, payload } = await post({ images: [{ data: `${PNG_BASE64}!`, mediaType: 'image/png' }] })
    expect(status).toBe(200)
    expect((payload as { failures: { index: number; error: string }[] }).failures).toEqual([{ index: 0, error: 'invalid-base64' }])
  })

  it('accepts multi-megabyte base64 payloads without overflowing the regexp stack', async () => {
    // V8's backtracking regexp threw RangeError ("Maximum call stack size
    // exceeded") for base64 strings past a few megabytes, which surfaced as a
    // bare HTTP 400 from the host web server.
    const bigSaved: Array<{ data: Uint8Array }> = []
    const bigServer = createServer((req, res) => {
      void serveImport(req, res, {
        saveImage: async image => {
          bigSaved.push(image)
          return attachmentRef('att-big')
        },
        maxImageBytes: 16 * 1024 * 1024,
        mediaTypes: ['image/png'],
      })
    })
    await new Promise<void>(resolve => bigServer.listen(0, '127.0.0.1', resolve))
    try {
      const port = (bigServer.address() as AddressInfo).port
      const data = Buffer.alloc(8 * 1024 * 1024).toString('base64')
      const response = await fetch('http://127.0.0.1:' + String(port) + '/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ images: [{ data, mediaType: 'image/png' }] }),
      })
      const payload = await response.json() as { images: unknown[]; failures: unknown[] }
      expect(response.status).toBe(200)
      expect(payload.failures).toEqual([])
      expect(payload.images).toHaveLength(1)
      expect(bigSaved).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => { bigServer.close(() => { resolve() }) })
    }
  })

  it('rejects request bodies above the batch limit', async () => {
    await listen()
    const { status, payload } = await post(JSON.stringify({ images: [{ data: 'A'.repeat(64 * 1024), mediaType: 'image/png' }] }))
    expect(status).toBe(400)
    expect(payload).toEqual({ error: 'invalid-request' })
  })
})
