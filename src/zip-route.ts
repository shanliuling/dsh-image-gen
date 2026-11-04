/** Streaming ZIP export of gallery attachments. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageAttachmentRef, ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { parseImageAttachmentRef } from './reference-image.js'
import { ZipStreamWriter, ZipTooLargeError } from './zip-stream.js'
import { createZipJob, finishZipJob, isZipJobCancelled, isValidZipToken, updateZipJob } from './zip-progress.js'
import { isValidVaultKey } from './vault-store.js'

/** Dependencies required by the gallery export route. */
export interface ZipRouteDeps {
  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment>
  /** Optional raw-vault reader: archives prefer original bytes when present. */
  readVault?(key: string, mediaType?: string): Promise<{ data: Uint8Array; mediaType: ImageMediaType } | undefined>
  /** Hard cap on how many attachments one archive may contain. */
  maxEntries?: number
  maxBodyBytes?: number
}

const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
/** Sanity ceiling: ZIP64 removed the 4 GiB cap, not an accidental 2000 × 40 GiB. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

interface ZipExportItem {
  name?: string | undefined
  attachment: ImageAttachmentRef
  originalKey?: string | undefined
  originalMediaType?: string | undefined
}

/**
 * Package selected gallery images into one ZIP and stream it to the browser.
 *
 * The request is a plain form post (`items` = JSON array of {name, attachment}),
 * so the renderer never builds the archive: the browser download manager owns
 * the transfer while this route reads attachments one at a time.
 */
export async function serveZip(req: IncomingMessage, res: ServerResponse, deps: ZipRouteDeps): Promise<void> {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return jsonError(res, 415, 'form-required')
  }
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')

  let body: string
  try {
    body = await readBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
  } catch {
    return jsonError(res, 413, 'request-too-large')
  }

  const params = new URLSearchParams(body)
  const tokenParam = params.get('token') ?? ''
  const jobToken = isValidZipToken(tokenParam) ? tokenParam : ''
  // Finish the matching SSE job before answering an error: otherwise the
  // progress stream keeps a placeholder alive and the button never recovers.
  const fail = (status: number, code: string): void => {
    if (jobToken !== '') {
      // The SSE stream may not have connected yet; create the job first so a
      // late subscriber still sees the terminal state instead of a placeholder.
      createZipJob(jobToken, 0)
      finishZipJob(jobToken, 'error')
    }
    jsonError(res, status, code)
  }
  const rawItems = params.get('items')
  if (rawItems === null) return fail(400, 'invalid-request')
  let parsed: unknown
  try {
    parsed = JSON.parse(rawItems)
  } catch {
    return fail(400, 'invalid-request')
  }
  if (!Array.isArray(parsed)) return fail(400, 'invalid-request')

  const items: ZipExportItem[] = []
  for (const entry of parsed) {
    const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined
    const attachment = parseImageAttachmentRef(record?.attachment)
    if (attachment === undefined) continue
    items.push({
      attachment,
      ...(typeof record?.name === 'string' ? { name: record.name } : {}),
      ...(typeof record?.originalKey === 'string' && isValidVaultKey(record.originalKey) ? { originalKey: record.originalKey } : {}),
      ...(typeof record?.originalMediaType === 'string' ? { originalMediaType: record.originalMediaType } : {}),
    })
  }
  if (items.length === 0) return fail(400, 'no-attachments')

  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
  if (items.length > maxEntries) return fail(413, 'too-many-attachments')

  let declaredBytes = 0
  for (const item of items) declaredBytes += item.attachment.bytes
  if (declaredBytes > MAX_ARCHIVE_BYTES) return fail(413, 'archive-too-large')

  if (jobToken !== '') createZipJob(jobToken, items.length)

  const filename = 'dsh-gallery-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.zip'
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="' + filename + '"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })

  const zip = new ZipStreamWriter(res)
  const skipped: string[] = []
  const onClose = (): void => {
    // Request close fires when the POST body is consumed, not when the download
    // socket goes away; response close is the disconnect signal here.
    if (res.writableFinished) return
    zip.markClientClosed()
    if (jobToken !== '') finishZipJob(jobToken, 'cancelled')
  }
  res.on('close', onClose)

  try {
    for (let index = 0; index < items.length; index += 1) {
      if (jobToken !== '' && isZipJobCancelled(jobToken)) {
        finishZipJob(jobToken, 'cancelled')
        res.destroy()
        return
      }
      const item = items[index]!
      let original: { data: Uint8Array; mediaType: ImageMediaType } | undefined
      if (item.originalKey !== undefined && deps.readVault !== undefined) {
        try { original = await deps.readVault(item.originalKey, item.originalMediaType) } catch { original = undefined }
      }
      const mediaType = original?.mediaType ?? item.attachment.mediaType
      const extension = IMAGE_EXTENSIONS[mediaType] ?? 'png'
      const fallback = 'dsh-' + String(item.attachment.attachmentId).replace(/^sha256:/, '').slice(0, 8) + '.' + extension
      // The client names entries from the raw copy; once that copy is gone the
      // bytes come from the attachment, so the extension must follow them.
      const entryName = item.name === undefined
        ? fallback
        : original === undefined ? replaceExtension(item.name, extension) : item.name
      try {
        if (original !== undefined) {
          await zip.add(entryName, Buffer.from(original.data))
        } else {
          const stored = await deps.readImage(item.attachment)
          await zip.add(entryName, Buffer.from(stored.data))
        }
      } catch (err) {
        if (zip.bytesWritten > 0 && isClosed(zip, err)) break
        skipped.push(String(item.attachment.attachmentId) + '\t' + (err instanceof Error ? err.message : 'unavailable'))
      }
      if (jobToken !== '') updateZipJob(jobToken, index + 1)
    }
    if (skipped.length > 0) {
      await zip.add('skipped.txt', Buffer.from(skipped.join('\n') + '\n', 'utf8'))
    }
    // Cancellation can arrive while the last attachment is being read or
    // written; do not let that export finish as a success.
    if (jobToken !== '' && isZipJobCancelled(jobToken)) {
      finishZipJob(jobToken, 'cancelled')
      res.destroy()
      return
    }
    await zip.finish()
    // res.end() only means the data was handed to the socket; wait for the
    // actual flush before reporting a completed archive.
    await waitForResponseFinish(res)
    if (jobToken !== '') finishZipJob(jobToken, 'done')
  } catch (err) {
    if (jobToken !== '') finishZipJob(jobToken, 'error')
    if (!res.headersSent) {
      jsonError(res, err instanceof ZipTooLargeError ? 413 : 500, err instanceof ZipTooLargeError ? 'archive-too-large' : 'zip-failed')
      return
    }
    // Headers are gone: the only honest signal left is a broken download.
    res.destroy(err instanceof Error ? err : undefined)
  } finally {
    res.off('close', onClose)
  }
}

function waitForResponseFinish(res: ServerResponse): Promise<void> {
  if (res.writableFinished) return Promise.resolve()
  if (res.destroyed) return Promise.reject(new Error('client closed the download'))
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off('finish', onFinish)
      res.off('close', onClose)
    }
    const onFinish = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new Error('client closed the download')) }
    res.once('finish', onFinish)
    res.once('close', onClose)
  })
}

function replaceExtension(name: string, extension: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const dot = name.lastIndexOf('.')
  return dot <= slash ? name + '.' + extension : name.slice(0, dot) + '.' + extension
}

function isClosed(zip: ZipStreamWriter, err: unknown): boolean {
  return zip.bytesWritten > 0 && err instanceof Error && err.message === 'client closed the download'
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && origin !== 'http://' + host && origin !== 'https://' + host) {
    return false
  }
  return true
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > limit) throw new Error('request too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
}
