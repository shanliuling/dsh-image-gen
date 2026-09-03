/** Restricted HTTP surface for the public inspiration snapshot and its images. */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  BUNDLED_INSPIRATION_CATALOG,
  INSPIRATION_SOURCE_ID,
  INSPIRATION_SOURCE_IMAGE_MIRROR,
  INSPIRATION_SOURCE_VERSION,
  MAX_INSPIRATION_CASES,
  findInspirationCase,
  parseInspirationSnapshot,
  publicInspirationCatalog,
  type ResolvedInspirationCatalog,
} from './inspiration.js'

const MAX_INDEX_BYTES = 3 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/** 磁盘缓存上限 200MB，LRU 淘汰最旧文件 */
const CACHE_MAX_BYTES = 200 * 1024 * 1024
const REMOTE_API = 'https://api.github.com/repos/freestylefly/awesome-gpt-image-2/commits/main'
const REMOTE_RAW = 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2'

export interface InspirationRouteDeps {
  fetch?: typeof fetch
}

/**
 * The browser can request only catalog metadata or a `(sourceId, caseId)` pair.
 * It cannot provide a URL, filename, host or image path to proxy.
 */
export function createInspirationRoute(deps: InspirationRouteDeps = {}) {
  const request = deps.fetch ?? fetch
  let activeCatalog = BUNDLED_INSPIRATION_CATALOG
  let triedRefreshForUnknownCase = false

  return async function serveInspiration(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/catalog') {
      return json(res, 200, publicInspirationCatalog(activeCatalog))
    }
    if (req.method === 'POST' && url.pathname === '/refresh') {
      try {
        activeCatalog = await fetchSnapshot(request)
        return json(res, 200, publicInspirationCatalog(activeCatalog))
      } catch (error) {
        return jsonError(res, 502, message(error, 'refresh-failed'))
      }
    }
    const match = /^\/image\/([a-z0-9-]{1,80})\/([a-zA-Z0-9_-]{1,120})$/u.exec(url.pathname)
    if (req.method !== 'GET' || match === null) return jsonError(res, 404, 'not-found')
    const [, sourceId, caseId] = match
    if (sourceId !== INSPIRATION_SOURCE_ID || caseId === undefined) return jsonError(res, 404, 'source-not-found')
    let item = findInspirationCase(activeCatalog, sourceId, caseId)
    // A browser can retain a manually refreshed catalog across a plugin restart.
    // Resolve one unknown case against the fixed upstream source, then keep the
    // result in this process. Do not retry arbitrary misses indefinitely.
    if (item === undefined && !triedRefreshForUnknownCase) {
      triedRefreshForUnknownCase = true
      try {
        activeCatalog = await fetchSnapshot(request)
        item = findInspirationCase(activeCatalog, sourceId, caseId)
      } catch {}
    }
    if (item === undefined) return jsonError(res, 404, 'case-not-found')
    const cacheKey = `${sourceId}_${caseId}`
    // 1. 先查磁盘缓存——命中则零网络开销直接返回 (纯异步非阻塞)
    const cached = await readImageCache(cacheKey)
    if (cached !== undefined) {
      res.writeHead(200, {
        'content-type': cached.type,
        'content-length': String(cached.data.byteLength),
        'cache-control': 'private, max-age=604800',
        'x-content-type-options': 'nosniff',
      })
      res.end(cached.data)
      return
    }
    // 2. 磁盘未命中，走三源瀑布降级拉取
    const source = activeCatalog.sources.find(candidate => candidate.id === sourceId)
    for (const imageUrl of imageUrls(source?.version, item.imagePath)) {
      try {
        const upstream = await request(imageUrl, {
          signal: AbortSignal.timeout(12_000),
          redirect: 'error',
          headers: { accept: 'image/avif,image/webp,image/png,image/jpeg' },
        })
        if (!upstream.ok) continue
        const type = upstream.headers.get('content-type')?.toLowerCase().split(';')[0] ?? ''
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) continue
        const declaredBytes = Number(upstream.headers.get('content-length') ?? '0')
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) continue
        // 流式限长读取：边读边算，超 12MB 立刻拔网线，防御 chunked 内存尖峰
        const body = await readLimitedStream(upstream, MAX_IMAGE_BYTES)
        if (body === null || body.byteLength === 0) continue
        // 3. 拉取成功，异步写入磁盘缓存（串行排队 + 防崩溃吞错）
        writeImageCache(cacheKey, type, body)
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(body.byteLength),
          'cache-control': 'private, max-age=604800',
          'x-content-type-options': 'nosniff',
        })
        res.end(body)
        return
      } catch {}
    }
    jsonError(res, 502, 'source-image-unavailable')
  }
}

/**
 * 边下边读的流式防爆读取器：累计超过 maxBytes 立即 cancel reader 并返回 null。
 * 防御 chunked 传输缺失 content-length 时的内存尖峰。
 */
async function readLimitedStream(upstream: Response, maxBytes: number): Promise<Uint8Array | null> {
  const stream = upstream.body
  if (!stream) {
    try {
      const buffer = await upstream.arrayBuffer()
      return buffer.byteLength <= maxBytes ? new Uint8Array(buffer) : null
    } catch {
      return null
    }
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          await reader.cancel('exceeded-max-bytes')
          return null
        }
        chunks.push(value)
      }
    }
  } catch {
    return null
  }
  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function fetchSnapshot(request: typeof fetch): Promise<ResolvedInspirationCatalog> {
  const commitResponse = await request(REMOTE_API, { cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/vnd.github+json' } })
  if (!commitResponse.ok) throw new Error(`素材源不可用 (${String(commitResponse.status)})`)
  const commit = await commitResponse.json() as { sha?: unknown; commit?: { author?: { date?: unknown } } }
  const sha = typeof commit.sha === 'string' && /^[a-f0-9]{40}$/i.test(commit.sha) ? commit.sha : undefined
  if (sha === undefined) throw new Error('素材源版本无效')
  const response = await request(`${REMOTE_RAW}/${sha}/data/cases.json`, { cache: 'no-store', signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!response.ok) throw new Error(`素材索引不可用 (${String(response.status)})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INDEX_BYTES) throw new Error('素材索引体积无效')
  const catalog = parseInspirationSnapshot(JSON.parse(new TextDecoder().decode(bytes)), sha)
  if (catalog.sources[0]?.cases.length === 0 || catalog.sources[0]!.cases.length > MAX_INSPIRATION_CASES) {
    throw new Error('素材索引校验失败')
  }
  // The upstream repository does not publish a manifest yet. Keep the digest
  // with the versioned catalog so a later manifest can verify it before publish.
  catalog.sources[0]!.integritySha256 = createHash('sha256').update(bytes).digest('hex')
  const updatedAt = commit.commit?.author?.date
  if (typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))) catalog.sources[0]!.updatedAt = updatedAt
  return catalog
}

function imageUrls(version: string | undefined, imagePath: string): string[] {
  const commit = typeof version === 'string' && /^[a-f0-9]{40}$/i.test(version)
    ? version
    : INSPIRATION_SOURCE_VERSION
  // 三源瀑布降级：jsDelivr 国内有网宿 CDN 节点可直连 → 苍何镜像 → GitHub Raw（需 VPN）
  // imagePath 形如 /images/case544.jpg，GitHub 仓库实际路径为 data/images/...
  return [
    `https://cdn.jsdelivr.net/gh/freestylefly/awesome-gpt-image-2@${commit}/data${imagePath}`,
    `${INSPIRATION_SOURCE_IMAGE_MIRROR}${imagePath}`,
    `${REMOTE_RAW}/${commit}/data${imagePath}`,
  ]
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  return origin === undefined || host === undefined || origin === `http://${host}` || origin === `https://${host}`
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  json(res, status, { error })
}

// ── 磁盘 LRU 缓存 (全异步非阻塞) ────────────────────────────────────
// 缓存目录跟随 DSH 用户数据目录 (~/.dsh/cache/dsh-image-gen/inspiration/)
// 读写不阻塞 Node.js 事件循环；Windows NTFS 默认不记录 atime，使用 mtime（修改时间）作为 FIFO 淘汰基准。

const MIME_TO_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }
const EXT_TO_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

async function getCacheDir(): Promise<string> {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (!home) return ''
  const dir = join(home, '.dsh', 'cache', 'dsh-image-gen', 'inspiration')
  try {
    await mkdir(dir, { recursive: true })
    return dir
  } catch {
    return ''
  }
}

async function readImageCache(key: string): Promise<{ type: string; data: Uint8Array } | undefined> {
  const dir = await getCacheDir()
  if (!dir) return undefined
  try {
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const file = join(dir, `${key}${ext}`)
      try {
        const data = await readFile(file)
        return { type: EXT_TO_MIME[ext]!, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
      } catch {}
    }
  } catch {}
  return undefined
}

let cacheWriteChain: Promise<void> = Promise.resolve()

function writeImageCache(key: string, mimeType: string, data: Uint8Array): void {
  const ext = MIME_TO_EXT[mimeType]
  if (ext === undefined) return
  // 串行队列异步落盘，吞掉全部错误，绝不触发 unhandledRejection 搞崩宿主进程
  cacheWriteChain = cacheWriteChain.then(async () => {
    try {
      const dir = await getCacheDir()
      if (!dir) return
      await writeFile(join(dir, `${key}${ext}`), data)
      await trimImageCache(dir)
    } catch {}
  }).catch(() => {})
}

/** 淘汰算法：超标时删除最早写入的文件 (基于真实 mtime) */
async function trimImageCache(dir: string): Promise<void> {
  try {
    const names = await readdir(dir)
    const validNames = names.filter(name => /\.(jpg|png|webp)$/i.test(name))
    const entries = await Promise.all(
      validNames.map(async name => {
        const full = join(dir, name)
        try {
          const s = await stat(full)
          return { path: full, size: s.size, mtime: s.mtimeMs }
        } catch {
          return { path: full, size: 0, mtime: 0 }
        }
      })
    )
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (totalBytes <= CACHE_MAX_BYTES) return
    // 按修改时间升序排列，优先淘汰最早写入的
    entries.sort((a, b) => a.mtime - b.mtime)
    let remaining = totalBytes
    for (const entry of entries) {
      if (remaining <= CACHE_MAX_BYTES) break
      try { await unlink(entry.path) } catch {}
      remaining -= entry.size
    }
  } catch {}
}
