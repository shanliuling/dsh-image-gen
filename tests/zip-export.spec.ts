import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { crc32 } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { ZipStreamWriter } from '../src/zip-stream.js'
import { serveZip } from '../src/zip-route.js'

class FakeResponse {
  chunks: Buffer[] = []
  status = 0
  headers: Record<string, string> = {}
  headersSent = false
  destroyed: Error | undefined

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.headers = headers
    this.headersSent = true
    return this
  }

  write(chunk: Buffer): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }

  end(chunk?: Buffer): void {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
  }

  destroy(error?: Error): void {
    this.destroyed = error
  }

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function attachment(id: string, bytes: number): ImageAttachmentRef {
  return {
    attachmentId: 'sha256:' + id.padEnd(64, '0') as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes,
    width: 64,
    height: 64,
  }
}

function formRequest(items: unknown[]): IncomingMessage {
  const body = new URLSearchParams({ items: JSON.stringify(items) }).toString()
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(stream, {
    method: 'POST',
    url: '/plugins/dsh-image-gen/zip',
    headers: { host: '127.0.0.1:8765', 'content-type': 'application/x-www-form-urlencoded' },
  })
  return stream
}

function endOfCentralDirectory(zip: Buffer): { entries: number; centralOffset: number; centralSize: number } {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBeGreaterThanOrEqual(0)
  return {
    entries: zip.readUInt16LE(eocd + 10),
    centralSize: zip.readUInt32LE(eocd + 12),
    centralOffset: zip.readUInt32LE(eocd + 16),
  }
}

describe('zip export writer', () => {
  it('writes stored entries with correct CRC and an EOCD', async () => {
    const res = new FakeResponse()
    const writer = new ZipStreamWriter(res as unknown as ServerResponse)
    const data = Buffer.from('hello dsh-image-gen')
    await writer.add('a.png', data)
    await writer.add('b.png', Buffer.from('second'))
    await writer.finish()

    const zip = res.body()
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304')
    const nameLength = zip.readUInt16LE(26)
    expect(zip.subarray(30, 30 + nameLength).toString()).toBe('a.png')
    expect(zip.readUInt32LE(14)).toBe(crc32(data))

    const end = endOfCentralDirectory(zip)
    expect(end.entries).toBe(2)
    expect(end.centralOffset + end.centralSize).toBeLessThanOrEqual(zip.length)
  })

  it('deduplicates repeated names', async () => {
    const res = new FakeResponse()
    const writer = new ZipStreamWriter(res as unknown as ServerResponse)
    await writer.add('same.png', Buffer.from('1'))
    await writer.add('same.png', Buffer.from('2'))
    await writer.finish()
    const zip = res.body()
    expect(zip.includes(Buffer.from('same-1.png'))).toBe(true)
  })
})

describe('zip export route', () => {
  it('streams a ZIP of the requested attachments', async () => {
    const res = new FakeResponse()
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: Buffer.from('bytes:' + ref.attachmentId) }))
    await serveZip(formRequest([
      { name: 'one.png', attachment: attachment('a', 10) },
      { attachment: attachment('b', 11) },
    ]), res as unknown as ServerResponse, { readImage })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain('dsh-gallery-')
    const zip = res.body()
    expect(zip.subarray(0, 2).toString()).toBe('PK')
    expect(zip.includes(Buffer.from('one.png'))).toBe(true)
    expect(endOfCentralDirectory(zip).entries).toBe(2)
  })

  it('reports unreadable attachments in skipped.txt instead of failing', async () => {
    const res = new FakeResponse()
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => {
      if (String(ref.attachmentId).endsWith('b' + '0'.repeat(63))) throw new Error('missing')
      return { ref, data: Buffer.from('ok') }
    })
    await serveZip(formRequest([
      { attachment: attachment('a', 2) },
      { attachment: attachment('b', 2) },
    ]), res as unknown as ServerResponse, { readImage })
    expect(res.status).toBe(200)
    const zip = res.body()
    expect(zip.includes(Buffer.from('skipped.txt'))).toBe(true)
    expect(endOfCentralDirectory(zip).entries).toBe(2)
  })

  it('rejects non-form and empty requests', async () => {
    const res = new FakeResponse()
    const req = formRequest([])
    ;(req as unknown as { headers: Record<string, string> }).headers['content-type'] = 'application/json'
    await serveZip(req, res as unknown as ServerResponse, { readImage: vi.fn() })
    expect(res.status).toBe(415)

    const empty = new FakeResponse()
    await serveZip(formRequest([]), empty as unknown as ServerResponse, { readImage: vi.fn() })
    expect(empty.status).toBe(400)
  })

  it('enforces the entry cap', async () => {
    const res = new FakeResponse()
    await serveZip(formRequest([
      { attachment: attachment('a', 1) },
      { attachment: attachment('b', 1) },
    ]), res as unknown as ServerResponse, { readImage: vi.fn(), maxEntries: 1 })
    expect(res.status).toBe(413)
  })
})
