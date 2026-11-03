/** Read-only delivery and garbage collection for the raw-image vault. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { gcVault, isValidVaultKey, readOriginal, type VaultConfig } from './vault-store.js'

export async function serveVault(req: IncomingMessage, res: ServerResponse, config: VaultConfig): Promise<void> {
  if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  const key = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? ''
  if (!isValidVaultKey(key)) return jsonError(res, 400, 'invalid-key')
  const original = await readOriginal(config, key)
  if (original === undefined) return jsonError(res, 404, 'not-found')

  const etag = '"sha256:' + key + '"'
  const cacheControl = 'private, max-age=31536000, immutable'
  const noneMatch = req.headers['if-none-match']
  if (typeof noneMatch === 'string' && noneMatch.split(',').some(value => value.trim() === etag)) {
    res.writeHead(304, { 'cache-control': cacheControl, etag })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': original.mediaType,
    'content-length': String(original.data.byteLength),
    'cache-control': cacheControl,
    etag,
    'x-content-type-options': 'nosniff',
  })
  res.end(original.data)
}

/** POST { keys: string[] } -> drop files the gallery no longer references. */
export async function serveVaultGc(req: IncomingMessage, res: ServerResponse, config: VaultConfig): Promise<void> {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  let body: string
  try {
    body = await readBody(req, 1024 * 1024)
  } catch {
    return jsonError(res, 413, 'request-too-large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return jsonError(res, 400, 'invalid-request')
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys
  if (!Array.isArray(keys)) return jsonError(res, 400, 'invalid-request')
  const stats = await gcVault(config, keys.filter((key): key is string => typeof key === 'string'))
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(stats))
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && origin !== 'http://' + host && origin !== 'https://' + host) return false
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
