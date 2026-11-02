/** Upload endpoint turning browser-picked image files into DSH attachments. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

export interface ImportRouteDeps {
  /** Durable attachment store; computes dimensions and content-addresses the bytes. */
  saveImage(image: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
  /** Per-image byte cap from the host attachment limits. */
  maxImageBytes: number
  /** Accepted media types from the host attachment limits. */
  mediaTypes: readonly string[]
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
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return jsonError(res, 415, 'json-required')
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return jsonError(res, 403, 'origin-rejected')
  }
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
  const saved: { attachment: ImageAttachmentRef }[] = []
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
        const attachment = await deps.saveImage({
          data: bytes,
          mediaType: record.mediaType as ImageMediaType,
          ...(typeof record.name === 'string' && record.name.length > 0 ? { name: record.name } : {}),
        })
        saved.push({ attachment })
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
