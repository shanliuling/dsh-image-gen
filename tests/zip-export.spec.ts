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

function attachment(id: string, bytes: number, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): ImageAttachmentRef {
  return {
    attachmentId: 'sha256:' + id.padEnd(64, '0') as ImageAttachmentRef['attachmentId'],
    mediaType,
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
  it('uses the attachment extension when the vault copy is gone', async () => {
    const res = new FakeResponse()
    const readImage = vi.fn(async () => ({ data: Buffer.from('jpeg-bytes'), mediaType: 'image/jpeg' as const }))
    await serveZip(formRequest([{ name: 'photo.png', attachment: attachment('abc', 100, 'image/jpeg'), originalKey: 'b'.repeat(64), originalMediaType: 'image/png' }]), res as unknown as ServerResponse, { readImage })
    const zip = res.body()
    const nameLength = zip.readUInt16LE(26)
    expect(zip.subarray(30, 30 + nameLength).toString()).toBe('photo.jpg')
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('prefers the raw vault copy over the attachment bytes', async () => {
    const res = new FakeResponse()
    const readImage = vi.fn(async () => ({ data: Buffer.from('attachment-bytes'), mediaType: 'image/png' as const }))
    const readVault = vi.fn(async () => ({ data: new Uint8Array(Buffer.from('raw-bytes')), mediaType: 'image/png' as const }))
    await serveZip(formRequest([{ name: 'a.png', attachment: attachment('abc', 100), originalKey: 'b'.repeat(64), originalMediaType: 'image/png' }]), res as unknown as ServerResponse, { readImage, readVault })
    const zip = res.body()
    const nameLength = zip.readUInt16LE(26)
    const extraLength = zip.readUInt16LE(28)
    const dataStart = 30 + nameLength + extraLength
    const size = zip.readUInt32LE(18)
    expect(zip.subarray(dataStart, dataStart + size).toString()).toBe('raw-bytes')
    expect(readImage).not.toHaveBeenCalled()
    expect(readVault).toHaveBeenCalledWith('b'.repeat(64), 'image/png')
  })

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

  it('emits ZIP64 records when forced past the 32-bit limits', async () => {
    const res = new FakeResponse()
    const writer = new ZipStreamWriter(res as unknown as ServerResponse, { zip64: 'always' })
    const data = Buffer.from('zip64 payload')
    await writer.add('big.png', data)
    await writer.finish()

    const zip = res.body()
    expect(zip.readUInt16LE(4)).toBe(45)
    expect(zip.readUInt32LE(18)).toBe(0xffff_ffff)
    expect(zip.readUInt32LE(22)).toBe(0xffff_ffff)
    const nameLength = zip.readUInt16LE(26)
    const extraLength = zip.readUInt16LE(28)
    expect(extraLength).toBe(20)
    const extraAt = 30 + nameLength
    expect(zip.readUInt16LE(extraAt)).toBe(0x0001)
    expect(zip.readUInt16LE(extraAt + 2)).toBe(16)
    expect(Number(zip.readBigUInt64LE(extraAt + 4))).toBe(data.byteLength)
    expect(Number(zip.readBigUInt64LE(extraAt + 12))).toBe(data.byteLength)

    const end64 = zip.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))
    const locator = zip.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]))
    expect(end64).toBeGreaterThan(0)
    expect(locator).toBe(end64 + 56)
    expect(Number(zip.readBigUInt64LE(end64 + 24))).toBe(1)
    expect(Number(zip.readBigUInt64LE(locator + 8))).toBe(end64)

    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(zip.readUInt16LE(eocd + 10)).toBe(0xffff)
    expect(zip.readUInt32LE(eocd + 12)).toBe(0xffff_ffff)
    expect(zip.readUInt32LE(eocd + 16)).toBe(0xffff_ffff)

    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(zip.readUInt16LE(central + 6)).toBe(45)
    expect(zip.readUInt32LE(central + 20)).toBe(0xffff_ffff)
    expect(zip.readUInt32LE(central + 24)).toBe(0xffff_ffff)
    expect(zip.readUInt16LE(central + 30)).toBe(28)
    expect(zip.readUInt32LE(central + 42)).toBe(0xffff_ffff)
  })

  it('keeps small archives on the ZIP32 layout', async () => {
    const res = new FakeResponse()
    const writer = new ZipStreamWriter(res as unknown as ServerResponse)
    await writer.add('small.png', Buffer.from('x'))
    await writer.finish()
    const zip = res.body()
    expect(zip.readUInt16LE(4)).toBe(20)
    expect(zip.readUInt16LE(28)).toBe(0)
    expect(zip.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(-1)
    expect(zip.readUInt16LE(zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 10)).toBe(1)
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

  it('accepts selections declared past the ZIP32 4 GiB ceiling', async () => {
    const res = new FakeResponse()
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: Buffer.from('x') }))
    await serveZip(formRequest([
      { attachment: attachment('a', 0xffff_ff00) },
    ]), res as unknown as ServerResponse, { readImage })
    expect(res.status).toBe(200)
    expect(endOfCentralDirectory(res.body()).entries).toBe(1)
  })

  it('rejects archives declared beyond the sanity ceiling', async () => {
    const res = new FakeResponse()
    await serveZip(formRequest([
      { attachment: attachment('a', 40 * 1024 ** 3) },
      { attachment: attachment('b', 40 * 1024 ** 3) },
    ]), res as unknown as ServerResponse, { readImage: vi.fn() })
    expect(res.status).toBe(413)
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
