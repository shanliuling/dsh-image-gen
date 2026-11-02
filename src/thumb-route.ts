/** Server-rendered gallery variants derived from the attachment store. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { parseImageAttachmentRef } from './reference-image.js'
import { decodeImageRef } from './shared.js'

/** Dependencies required by the thumbnail and preview routes. */
export interface ThumbRouteDeps {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: { width: number; height: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ variantId: string; data: Uint8Array; mediaType: ImageAttachmentRef['mediaType'] }>
}

interface VariantConfig {
  defaultWidth: number
  minWidth: number
  maxWidth: number
  maxBytes: number
  unavailableCode: string
}

const THUMB: VariantConfig = {
  defaultWidth: 320,
  minWidth: 64,
  maxWidth: 1024,
  /** Generous for a 320 px tile, so the quality ladder stays at its top rung. */
  maxBytes: 96 * 1024,
  unavailableCode: 'thumbnail-unavailable',
}

/**
 * A 1600 px long edge keeps lightbox decoding small (a 33.5 MP original costs
 * roughly 130 MB as RGBA) while staying sharp on a desktop window.
 */
const PREVIEW: VariantConfig = {
  defaultWidth: 1600,
  minWidth: 256,
  maxWidth: 2048,
  maxBytes: 512 * 1024,
  unavailableCode: 'preview-unavailable',
}

/**
 * Serve one downscaled, cached thumbnail.
 *
 * The attachment backend already derives deterministic request images (resize by
 * long edge + JPEG/WebP quality ladder) and caches them on disk, so the gallery
 * can render a tile without transferring the original to the renderer at all.
 */
export async function serveThumb(req: IncomingMessage, res: ServerResponse, deps: ThumbRouteDeps): Promise<void> {
  return serveVariant(req, res, deps, THUMB)
}

/** Serve the mid-size variant used by the lightbox preview. */
export async function servePreview(req: IncomingMessage, res: ServerResponse, deps: ThumbRouteDeps): Promise<void> {
  return serveVariant(req, res, deps, PREVIEW)
}

async function serveVariant(req: IncomingMessage, res: ServerResponse, deps: ThumbRouteDeps, config: VariantConfig): Promise<void> {
  if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  const url = new URL(req.url ?? '/', 'http://x')
  const rawRef = url.searchParams.get('ref')
  const attachment = rawRef === null ? undefined : decodeImageRef(rawRef, parseImageAttachmentRef)
  if (attachment === undefined) return jsonError(res, 400, 'invalid-attachment')

  const requested = Number(url.searchParams.get('w') ?? config.defaultWidth)
  const width = Number.isFinite(requested)
    ? Math.min(config.maxWidth, Math.max(config.minWidth, Math.round(requested)))
    : config.defaultWidth

  try {
    const variant = await deps.readImageRequest(attachment, { width, height: width, maxBytes: config.maxBytes })
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
    jsonError(res, 404, config.unavailableCode)
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
