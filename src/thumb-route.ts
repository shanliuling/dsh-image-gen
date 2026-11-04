/** Server-rendered gallery thumbnails derived from the attachment store. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { parseImageAttachmentRef } from './reference-image.js'
import { decodeImageRef } from './shared.js'

/** Dependencies required by the thumbnail route. */
export interface ThumbRouteDeps {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: { width: number; height: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ variantId: string; data: Uint8Array; mediaType: ImageAttachmentRef['mediaType'] }>
}

const DEFAULT_WIDTH = 320
const MIN_WIDTH = 64
const MAX_WIDTH = 1024
/** Generous for a 320 px tile, so the quality ladder stays at its top rung. */
const MAX_BYTES = 96 * 1024

/**
 * Serve one downscaled, cached thumbnail.
 *
 * The attachment backend already derives deterministic request images (resize by
 * long edge + JPEG/WebP quality ladder) and caches them on disk, so the gallery
 * can render a tile without transferring the original to the renderer at all.
 */
export async function serveThumb(req: IncomingMessage, res: ServerResponse, deps: ThumbRouteDeps): Promise<void> {
  if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  const url = new URL(req.url ?? '/', 'http://x')
  const rawRef = url.searchParams.get('ref')
  const attachment = rawRef === null ? undefined : decodeImageRef(rawRef, parseImageAttachmentRef)
  if (attachment === undefined) return jsonError(res, 400, 'invalid-attachment')

  const requested = Number(url.searchParams.get('w') ?? DEFAULT_WIDTH)
  const width = Number.isFinite(requested)
    ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(requested)))
    : DEFAULT_WIDTH

  try {
    const variant = await deps.readImageRequest(attachment, { width, height: width, maxBytes: MAX_BYTES })
    const etag = '"' + String(variant.variantId) + '"'
    const headers = {
      'cache-control': 'private, max-age=31536000, immutable',
      etag,
    }
    const ifNoneMatch = req.headers['if-none-match']
    if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some(value => value.trim() === etag)) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': variant.mediaType,
      'content-length': String(variant.data.byteLength),
      'x-content-type-options': 'nosniff',
      ...headers,
    })
    res.end(variant.data)
  } catch {
    jsonError(res, 404, 'thumbnail-unavailable')
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) return false
  return true
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
}
