import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { MultipartError, readMultipart, type MultipartPart } from '../src/multipart.js'

const BOUNDARY = '----dsh-test-boundary'

interface PartSpec {
  name: string
  filename?: string
  contentType?: string
  data: Buffer
}

function buildBody(parts: PartSpec[]): Buffer {
  const pieces: Buffer[] = []
  for (const part of parts) {
    pieces.push(Buffer.from('--' + BOUNDARY + '\r\n'))
    const disposition = 'Content-Disposition: form-data; name="' + part.name + '"' + (part.filename === undefined ? '' : '; filename="' + part.filename + '"')
    const headers = [disposition, ...(part.contentType === undefined ? [] : ['Content-Type: ' + part.contentType]), '', ''].join('\r\n')
    pieces.push(Buffer.from(headers))
    pieces.push(part.data)
    pieces.push(Buffer.from('\r\n'))
  }
  pieces.push(Buffer.from('--' + BOUNDARY + '--\r\n'))
  return Buffer.concat(pieces)
}

function fakeRequest(body: Buffer, chunkSize: number): IncomingMessage {
  return {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        yield body.subarray(offset, Math.min(body.length, offset + chunkSize))
      }
    },
  } as unknown as IncomingMessage
}

async function collect(body: Buffer, chunkSize: number, maxPartBytes = 1024): Promise<MultipartPart[]> {
  const parts: MultipartPart[] = []
  await readMultipart(fakeRequest(body, chunkSize), BOUNDARY, {
    maxPartBytes,
    onPart: async part => { parts.push(part) },
  })
  return parts
}

describe('multipart reader', () => {
  it('does not split quoted filename on a semicolon', async () => {
    const body = Buffer.concat([
      Buffer.from('--' + BOUNDARY + '\r\n'),
      Buffer.from('Content-Disposition: form-data; filename="a; name=evil.png"; name="images"\r\n'),
      Buffer.from('Content-Type: image/png\r\n\r\n'),
      Buffer.from([1, 2, 3]),
      Buffer.from('\r\n--' + BOUNDARY + '--\r\n'),
    ])
    const parts = await collect(body, 5)
    expect(parts).toHaveLength(1)
    expect(parts[0]!.name).toBe('images')
    expect(parts[0]!.filename).toBe('a; name=evil.png')
  })

  it('does not treat filename as the form field name', async () => {
    const body = Buffer.concat([
      Buffer.from('--' + BOUNDARY + '\r\n'),
      Buffer.from('Content-Disposition: form-data; filename="a.png"; name="images"\r\n'),
      Buffer.from('Content-Type: image/png\r\n\r\n'),
      Buffer.from([1, 2, 3]),
      Buffer.from('\r\n--' + BOUNDARY + '--\r\n'),
    ])
    const parts = await collect(body, 7)
    expect(parts).toHaveLength(1)
    expect(parts[0]!.name).toBe('images')
    expect(parts[0]!.filename).toBe('a.png')
  })

  it('parses parts split at every byte boundary', async () => {
    const body = buildBody([
      { name: 'images', filename: 'a.png', contentType: 'image/png', data: Buffer.from([1, 2, 3, 4]) },
      { name: 'images', filename: 'b.jpg', contentType: 'image/jpeg', data: Buffer.from([9, 8, 7]) },
    ])
    for (const chunkSize of [1, 2, 3, 5, 7, body.length]) {
      const parts = await collect(body, chunkSize)
      expect(parts.map(part => part.filename)).toEqual(['a.png', 'b.jpg'])
      expect(Array.from(parts[0]!.data)).toEqual([1, 2, 3, 4])
      expect(Array.from(parts[1]!.data)).toEqual([9, 8, 7])
      expect(parts[0]!.mediaType).toBe('image/png')
    }
  })

  it('flags an oversized part but still returns the next one', async () => {
    const body = buildBody([
      { name: 'images', filename: 'big.png', contentType: 'image/png', data: Buffer.alloc(20, 1) },
      { name: 'images', filename: 'ok.png', contentType: 'image/png', data: Buffer.from([1, 2]) },
    ])
    const parts = await collect(body, 3, 8)
    expect(parts).toHaveLength(2)
    expect(parts[0]!.tooLarge).toBe(true)
    expect(parts[0]!.bytes).toBe(20)
    expect(Array.from(parts[1]!.data)).toEqual([1, 2])
  })

  it('ignores non-image fields and leaves the image cap to the importer', async () => {
    const body = buildBody([
      { name: 'note', data: Buffer.from('hello') },
      { name: 'images', filename: 'a.png', data: Buffer.from([1]) },
    ])
    const parts = await collect(body, 4)
    expect(parts).toHaveLength(1)

    const nine = buildBody(Array.from({ length: 9 }, (_, index) => ({ name: 'images', filename: index + '.png', data: Buffer.from([index]) })))
    expect(await collect(nine, 64)).toHaveLength(9)
  })

  it('rejects a truncated body', async () => {
    const body = buildBody([{ name: 'images', filename: 'a.png', data: Buffer.from([1, 2, 3]) }])
    const truncated = body.subarray(0, body.length - 6)
    await expect(collect(truncated, 5)).rejects.toBeInstanceOf(MultipartError)
  })
})
