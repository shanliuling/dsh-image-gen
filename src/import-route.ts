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
  const images = (body as { images?: unknown }).images
  if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES_PER_REQUEST) {
    return jsonError(res, 400, 'invalid-image-count')
  }
  const saved: { attachment: ImageAttachmentRef }[] = []
  const failures: { index: number; error: string }[] = []
  for (const [index, item] of images.entries()) {
    const record = item as Partial<ImportRequestItem>
    if (typeof record.data !== 'string' || typeof record.mediaType !== 'string') {
      failures.push({ index, error: 'invalid-item' })
      continue
    }
    if (!deps.mediaTypes.includes(record.mediaType)) {
      failures.push({ index, error: `unsupported-media-type: ${record.mediaType}` })
      continue
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(record.data, 'base64')
    } catch {
      failures.push({ index, error: 'invalid-base64' })
      continue
    }
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
    } catch (error) {
      failures.push({ index, error: error instanceof Error ? error.message : String(error) })
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
