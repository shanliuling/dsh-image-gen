/** Same-origin HTTP bridge from the Web result card to the Attachment service. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { parseImageAttachmentRef } from './reference-image.js'
import { IMAGE_ROUTE, DELETE_ROUTE } from './shared.js'

export { IMAGE_ROUTE, DELETE_ROUTE } from './shared.js'
const MAX_BODY_BYTES = 64 * 1024

/** Dependencies required by the image route. */
export interface ImageRouteDeps {
  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment>
}

/** Dependencies required by the delete route. */
export interface DeleteRouteDeps {
  deleteWorkspaceImage(filePath: string): Promise<boolean>
}

/** Serve one verified durable image reference to a same-origin browser request. */
export async function serveImage(req: IncomingMessage, res: ServerResponse, deps: ImageRouteDeps): Promise<void> {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return jsonError(res, 415, 'json-required')
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return jsonError(res, 403, 'origin-rejected')
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return jsonError(res, 400, 'invalid-request')
  }
  const attachment = attachmentFromRequest(body)
  if (attachment === undefined) return jsonError(res, 400, 'invalid-attachment')
  try {
    const stored = await deps.readImage(attachment)
    res.writeHead(200, {
      'content-type': stored.ref.mediaType,
      'content-length': String(stored.data.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(stored.data)
  } catch {
    jsonError(res, 404, 'image-unavailable')
  }
}

/** Safely delete one or more generated image files from the workspace disk. */
export async function serveDelete(req: IncomingMessage, res: ServerResponse, deps: DeleteRouteDeps): Promise<void> {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return jsonError(res, 415, 'json-required')
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return jsonError(res, 403, 'origin-rejected')
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return jsonError(res, 400, 'invalid-request')
  }
  const rawPaths = typeof body === 'object' && body !== null && 'paths' in body && Array.isArray((body as Record<string, unknown>).paths)
    ? (body as { paths: unknown[] }).paths
    : []

  const deletedFiles: string[] = []
  const failedFiles: { path: string; error: string }[] = []

  // Delete by direct paths
  for (const p of rawPaths) {
    if (typeof p === 'string' && p.trim()) {
      try {
        const ok = await deps.deleteWorkspaceImage(p)
        if (ok) {
          deletedFiles.push(p)
        } else {
          failedFiles.push({ path: p, error: 'File not found or rejected by safety checks' })
        }
      } catch (err) {
        failedFiles.push({ path: p, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({
    ok: failedFiles.length === 0,
    deletedCount: deletedFiles.length,
    deletedFiles,
    failedFiles,
  }))
}

/** Validate the persisted reference carried by a tool presentation. */
export function imageAttachmentFromMeta(meta: unknown): ImageAttachmentRef | undefined {
  const value = record(meta)
  if (value?.kind !== 'dsh-image-gen') return undefined
  return parseImageAttachmentRef(value.attachment)
}

function attachmentFromRequest(value: unknown): ImageAttachmentRef | undefined {
  return parseImageAttachmentRef(record(value)?.attachment)
}


function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
}
