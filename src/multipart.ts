/** Minimal streaming multipart/form-data reader for the gallery import route. */
import type { IncomingMessage } from 'node:http'

export class MultipartError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'MultipartError'
  }
}

export interface MultipartPart {
  name: string
  filename?: string
  mediaType?: string
  /** Part payload; empty when the part exceeded the per-part byte cap. */
  data: Buffer
  /** True when the payload exceeded the cap and was discarded. */
  tooLarge: boolean
  /** Payload byte count even when it was discarded. */
  bytes: number
}

export interface ReadMultipartOptions {
  /** Maximum payload bytes kept per part; larger parts are drained and flagged. */
  maxPartBytes: number
  /** Called once per complete part, in order; awaited before parsing continues. */
  onPart(part: MultipartPart): Promise<void>
}

const CRLF = Buffer.from('\r\n')
const DASH = Buffer.from('--')
const HEADER_LIMIT = 16 * 1024

/**
 * Parse a multipart body incrementally. Only one part is buffered at a time,
 * so an 8 x 40 MiB upload never holds the whole request in memory.
 */
export async function readMultipart(req: IncomingMessage, boundary: string, options: ReadMultipartOptions): Promise<void> {
  if (boundary.length === 0 || boundary.length > 200) throw new MultipartError(400, 'invalid-boundary')
  const first = Buffer.from('--' + boundary)
  const delimiter = Buffer.from('\r\n--' + boundary)
  let buffer = Buffer.alloc(0)
  let state: 'preamble' | 'headers' | 'body' | 'done' = 'preamble'
  let part: { name: string; filename?: string; mediaType?: string; chunks: Buffer[]; bytes: number; tooLarge: boolean } | undefined

  const append = (chunk: Buffer): void => {
    if (part === undefined || chunk.length === 0) return
    part.bytes += chunk.length
    if (part.tooLarge) return
    if (part.bytes > options.maxPartBytes) {
      part.tooLarge = true
      part.chunks = []
      return
    }
    part.chunks.push(Buffer.from(chunk))
  }

  const finishPart = async (): Promise<void> => {
    if (part === undefined) return
    const completed = part
    part = undefined
    // The importer decides how many images it accepts; the parser keeps going
    // so an over-limit request cannot leave already-saved parts unreferenced.
    if (completed.name !== 'images') return
    await options.onPart({
      name: completed.name,
      ...(completed.filename === undefined ? {} : { filename: completed.filename }),
      ...(completed.mediaType === undefined ? {} : { mediaType: completed.mediaType }),
      data: completed.tooLarge ? Buffer.alloc(0) : Buffer.concat(completed.chunks, completed.bytes),
      tooLarge: completed.tooLarge,
      bytes: completed.bytes,
    })
  }

  const consume = async (): Promise<void> => {
    while (true) {
      if (state === 'done') return
      if (state === 'preamble') {
        const index = buffer.indexOf(first)
        if (index === -1) {
          if (buffer.length > first.length + 4) buffer = buffer.subarray(buffer.length - (first.length + 4))
          return
        }
        if (buffer.length < index + first.length + 2) return
        const suffix = buffer.subarray(index + first.length, index + first.length + 2)
        if (suffix.equals(DASH)) {
          state = 'done'
          return
        }
        if (!suffix.equals(CRLF)) throw new MultipartError(400, 'invalid-multipart')
        buffer = buffer.subarray(index + first.length + 2)
        state = 'headers'
        continue
      }
      if (state === 'headers') {
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) {
          if (buffer.length > HEADER_LIMIT) throw new MultipartError(400, 'invalid-headers')
          return
        }
        const headerBuffer = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 4)
        const headers = parsePartHeaders(headerBuffer)
        if (headers.name.length === 0) throw new MultipartError(400, 'invalid-headers')
        part = {
          name: headers.name,
          ...(headers.filename === undefined ? {} : { filename: headers.filename }),
          ...(headers.mediaType === undefined ? {} : { mediaType: headers.mediaType }),
          chunks: [],
          bytes: 0,
          tooLarge: false,
        }
        state = 'body'
        continue
      }
      if (state === 'body') {
        const found = findDelimiter(buffer, delimiter)
        if (found === -1) {
          const keep = delimiter.length + 2
          if (buffer.length > keep) {
            append(buffer.subarray(0, buffer.length - keep))
            buffer = buffer.subarray(buffer.length - keep)
          }
          return
        }
        append(buffer.subarray(0, found))
        buffer = buffer.subarray(found + delimiter.length)
        const suffix = buffer.subarray(0, 2)
        buffer = buffer.subarray(2)
        await finishPart()
        if (suffix.equals(DASH)) {
          state = 'done'
          return
        }
        if (!suffix.equals(CRLF)) throw new MultipartError(400, 'invalid-multipart')
        state = 'headers'
        continue
      }
    }
  }

  for await (const chunk of req) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming])
    await consume()
  }
  await consume()
  const finalState: string = state
  if (finalState !== 'done') throw new MultipartError(400, 'truncated-multipart')
}

/** Locate a delimiter whose following two bytes are CRLF or a closing dash. */
function findDelimiter(buffer: Buffer, delimiter: Buffer): number {
  let from = 0
  while (true) {
    const index = buffer.indexOf(delimiter, from)
    if (index === -1) return -1
    if (buffer.length < index + delimiter.length + 2) return -1
    const suffix = buffer.subarray(index + delimiter.length, index + delimiter.length + 2)
    if (suffix.equals(CRLF) || suffix.equals(DASH)) return index
    from = index + 1
  }
}

function parsePartHeaders(raw: Buffer): { name: string; filename?: string; mediaType?: string } {
  let name = ''
  let filename: string | undefined
  let mediaType: string | undefined
  for (const line of raw.toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'content-disposition') {
      name = dispositionParam(value, 'name') ?? ''
      filename = dispositionParam(value, 'filename')
    } else if (key === 'content-type') {
      mediaType = value.split(';')[0]?.trim() || undefined
    }
  }
  return { name, ...(filename === undefined ? {} : { filename }), ...(mediaType === undefined ? {} : { mediaType }) }
}

function dispositionParam(value: string, key: string): string | undefined {
  const quoted = new RegExp(key + '="((?:\\\\.|[^"\\\\])*)"', 'i').exec(value)
  if (quoted !== null) return quoted[1]!.replace(/\\(.)/g, '$1')
  const bare = new RegExp(key + '=([^;\\s]+)', 'i').exec(value)
  return bare?.[1]
}
