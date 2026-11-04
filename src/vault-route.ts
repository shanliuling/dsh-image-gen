/** Read-only delivery, reference sync and explicit deletion for the raw-image vault. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isValidVaultKey, readOriginal, type VaultConfig } from './vault-store.js'
import { deleteUnreferencedOriginals, isValidVaultProfileId, updateVaultRegistry } from './vault-registry.js'

export async function serveVault(req: IncomingMessage, res: ServerResponse, config: VaultConfig): Promise<void> {
  if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  const params = new URL(req.url ?? '/', 'http://x').searchParams
  const key = params.get('key') ?? ''
  if (!isValidVaultKey(key)) return jsonError(res, 400, 'invalid-key')
  const mediaType = params.get('mediaType') ?? undefined
  const original = await readOriginal(config, key, mediaType)
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

/** Sync one browser profile's references; never deletes originals. */
export async function serveVaultRefs(req: IncomingMessage, res: ServerResponse, config: VaultConfig): Promise<void> {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  const payload = await readJson(req, res)
  if (payload === undefined) return
  const profileId = payload.profileId
  const keys = payload.keys
  if (!isValidVaultProfileId(profileId)) {
    // Old clients cannot prove a global reference set. They are sync-only now;
    // never delete from this route.
    jsonOk(res, { removed: 0, bytes: 0 })
    return
  }
  if (!validKeys(keys) || profileId === 'legacy-vault') return jsonError(res, 400, 'invalid-request')
  const registry = await updateVaultRegistry(config.dir, profileId, keys)
  if (registry === undefined) return jsonError(res, 409, 'registry-unavailable')
  jsonOk(res, { removed: 0, bytes: 0, profiles: Object.keys(registry.profiles).length })
}

/** Explicit gallery deletion: remove only keys no profile still references. */
export async function serveVaultDelete(req: IncomingMessage, res: ServerResponse, config: VaultConfig): Promise<void> {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  const payload = await readJson(req, res)
  if (payload === undefined) return
  const profileId = payload.profileId
  const keys = payload.keys
  const deleteKeys = payload.deleteKeys
  if (!isValidVaultProfileId(profileId) || profileId === 'legacy-vault') return jsonError(res, 400, 'invalid-profile')
  if (!validKeys(keys) || !validKeys(deleteKeys) || payload.confirm !== true) {
    return jsonError(res, 400, 'invalid-request')
  }
  const stats = await deleteUnreferencedOriginals(config, profileId, keys, deleteKeys)
  if (stats === undefined) return jsonError(res, 409, 'registry-unavailable')
  jsonOk(res, stats)
}

type VaultPayload = { profileId?: unknown; keys?: unknown; deleteKeys?: unknown; confirm?: unknown }

function validKeys(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key): key is string => typeof key === 'string' && isValidVaultKey(key))
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<VaultPayload | undefined> {
  let body: string
  try {
    body = await readBody(req, 4 * 1024 * 1024)
  } catch {
    jsonError(res, 413, 'request-too-large')
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) {
      jsonError(res, 400, 'invalid-request')
      return undefined
    }
    return parsed as VaultPayload
  } catch {
    jsonError(res, 400, 'invalid-request')
    return undefined
  }
}

function jsonOk(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
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
