/** Upload endpoint turning browser-picked image files into DSH attachments. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { MultipartError, readMultipart } from './multipart.js'

export interface ImportRouteDeps {
  /** Durable attachment store; computes dimensions and content-addresses the bytes. */
  saveImage(image: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
  /** Per-image byte cap from the host attachment limits. */
  maxImageBytes: number
  /** Accepted media types from the host attachment limits. */
  mediaTypes: readonly string[]
  /** Optional background warm-up for the gallery thumbnail of a saved image. */
  warmThumbnail?(ref: ImageAttachmentRef): void
  /** Persist the pre-normalization bytes when the attachment layer changed them. */
  saveOriginal?(input: { data: Uint8Array; mediaType: ImageMediaType }): Promise<{ key: string; bytes: number; mediaType: ImageMediaType } | undefined>
}

interface ImportRequestItem {
  data: string
  mediaType: string
  name?: string
}

const MAX_IMAGES_PER_REQUEST = 8

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = (() => {
  const table = new Uint8Array(128)
  for (let index = 0; index < BASE64_ALPHABET.length; index++) table[BASE64_ALPHABET.charCodeAt(index)] = 1
  return table
})()

/**
 * Validate base64 in linear time. A backtracking regexp looks harmless but V8
 * throws RangeError ("Maximum call stack size exceeded") once the input passes
 * a few megabytes, which turned every large import into a bare HTTP 400.
 */
function isValidBase64(value: string): boolean {
  // An empty payload is left to the byte-range check below so its stable
  // 'size-out-of-range' code is preserved.
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const end = value.length - padding
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index)
    if (code > 127 || BASE64_LOOKUP[code] !== 1) return false
  }
  return true
}

/** base64 inflates bytes by 4/3; allow one full batch plus JSON overhead. */
function bodyLimit(maxImageBytes: number): number {
  return MAX_IMAGES_PER_REQUEST * Math.ceil(maxImageBytes * 1.4) + 4096
}

export async function serveImport(req: IncomingMessage, res: ServerResponse, deps: ImportRouteDeps): Promise<void> {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return jsonError(res, 403, 'origin-rejected')
  }
  const contentType = req.headers['content-type'] ?? ''
  const boundary = multipartBoundary(contentType)
  if (boundary !== undefined) return serveMultipartImport(req, res, deps, boundary)
  if (!contentType.toLowerCase().startsWith('application/json')) return jsonError(res, 415, 'json-required')
  let body: unknown
  try {
    body = JSON.parse(await readBody(req, bodyLimit(deps.maxImageBytes)))
  } catch {
    return jsonError(res, 400, 'invalid-request')
  }
  const images = typeof body === 'object' && body !== null ? (body as { images?: unknown }).images : undefined
  if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES_PER_REQUEST) {
    return jsonError(res, 400, 'invalid-image-count')
  }
  const saved: { attachment: ImageAttachmentRef; original?: { key: string; bytes: number; mediaType: ImageMediaType } }[] = []
  const failures: { index: number; error: string }[] = []
  for (const [index, item] of images.entries()) {
    try {
      const record = typeof item === 'object' && item !== null ? item as Partial<ImportRequestItem> : undefined
      if (record === undefined || typeof record.data !== 'string' || typeof record.mediaType !== 'string') {
        failures.push({ index, error: 'invalid-item' })
        continue
      }
      if (!deps.mediaTypes.includes(record.mediaType)) {
        failures.push({ index, error: `unsupported-media-type: ${record.mediaType}` })
        continue
      }
      // Buffer.from silently skips characters outside the base64 alphabet, so the
      // encoded text is validated up front instead of relying on decode failures.
      if (!isValidBase64(record.data)) {
        failures.push({ index, error: 'invalid-base64' })
        continue
      }
      const bytes = Buffer.from(record.data, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > deps.maxImageBytes) {
        failures.push({ index, error: `size-out-of-range (max ${String(deps.maxImageBytes)} bytes)` })
        continue
      }
      try {
        const persisted = await persistImport(deps, bytes, record.mediaType as ImageMediaType, record.name)
        saved.push(persisted)
        try {
          deps.warmThumbnail?.(persisted.attachment)
        } catch { /* warm-up is best effort */ }
      } catch {
        // Host save errors may carry internal details; surface a stable code
        // instead, matching the canvas upload route's generic failure answer.
        failures.push({ index, error: 'save-failed' })
      }
    } catch {
      // Never let one malformed item reject the whole request: an uncaught
      // throw reaches the host web server, which answers with a bare HTTP 400.
      failures.push({ index, error: 'internal-error' })
    }
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ images: saved, failures }))
}

interface SpooledPart {
  index: number
  path: string
  mediaType: ImageMediaType
  filename?: string
  bytes: number
}

async function serveMultipartImport(req: IncomingMessage, res: ServerResponse, deps: ImportRouteDeps, boundary: string): Promise<void> {
  const saved: { attachment: ImageAttachmentRef; original?: { key: string; bytes: number; mediaType: ImageMediaType } }[] = []
  const failures: { index: number; error: string }[] = []
  let tempDir: string | undefined
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-image-import-'))
    const spooled: SpooledPart[] = []
    let index = 0
    await readMultipart(req, boundary, {
      maxPartBytes: deps.maxImageBytes,
      onPart: async part => {
        const current = index++
        // Keep parsing after the cap, but never save part nine: the first eight
        // are returned normally and the rest are reported as failures.
        if (current >= MAX_IMAGES_PER_REQUEST) {
          failures.push({ index: current, error: 'invalid-image-count' })
          return
        }
        if (part.tooLarge || part.bytes === 0 || part.bytes > deps.maxImageBytes) {
          failures.push({ index: current, error: 'size-out-of-range (max ' + String(deps.maxImageBytes) + ' bytes)' })
          return
        }
        const declared = part.mediaType !== undefined && deps.mediaTypes.includes(part.mediaType)
          ? part.mediaType
          : mediaTypeFromFilename(part.filename)
        if (declared === undefined || !deps.mediaTypes.includes(declared)) {
          failures.push({ index: current, error: 'unsupported-media-type: ' + (declared ?? 'unknown') })
          return
        }
        // Spool the complete part before touching the durable attachment store.
        // A truncated request therefore leaves no unreferenced attachments.
        const path = join(tempDir!, String(current) + '.part')
        await writeFile(path, part.data)
        spooled.push({
          index: current,
          path,
          mediaType: declared as ImageMediaType,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
          bytes: part.bytes,
        })
      },
    })

    // The request body is complete; now commit the batch in order.
    for (const part of spooled) {
      try {
        const data = await readFile(part.path)
        const persisted = await persistImport(deps, data, part.mediaType, part.filename)
        saved.push(persisted)
        try {
          deps.warmThumbnail?.(persisted.attachment)
        } catch { /* warm-up is best effort */ }
      } catch {
        failures.push({ index: part.index, error: 'save-failed' })
      }
    }
  } catch (err) {
    if (err instanceof MultipartError) return jsonError(res, err.status, err.code)
    return jsonError(res, 400, 'invalid-request')
  } finally {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
  if (saved.length === 0 && failures.length === 0) return jsonError(res, 400, 'invalid-image-count')
  failures.sort((a, b) => a.index - b.index)
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ images: saved, failures }))
}

/** Save one image and, when the attachment layer normalized it, keep the raw copy. */
async function persistImport(
  deps: ImportRouteDeps,
  bytes: Uint8Array,
  mediaType: ImageMediaType,
  name?: string,
): Promise<{ attachment: ImageAttachmentRef; original?: { key: string; bytes: number; mediaType: ImageMediaType } }> {
  const attachment = await deps.saveImage({
    data: bytes,
    mediaType,
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
  })
  let original: { key: string; bytes: number; mediaType: ImageMediaType } | undefined
  if (deps.saveOriginal !== undefined && (attachment.mediaType !== mediaType || attachment.bytes !== bytes.byteLength)) {
    // Do not acknowledge a full-resolution import whose original could not be
    // stored and protected. The caller can retry instead of silently losing it.
    original = await deps.saveOriginal({ data: bytes, mediaType })
  }
  return { attachment, ...(original === undefined ? {} : { original }) }
}

function multipartBoundary(contentType: string): string | undefined {
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return undefined
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const value = (match?.[1] ?? match?.[2] ?? '').trim()
  return value.length > 0 ? value : undefined
}

const FILENAME_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function mediaTypeFromFilename(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const dot = name.lastIndexOf('.')
  if (dot === -1) return undefined
  return FILENAME_MEDIA_TYPES[name.slice(dot + 1).toLowerCase()]
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
}
