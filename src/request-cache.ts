/** Bounded maintenance for the attachment backend's request-image cache. */
import { lstat, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Default retention for request-image variants. */
export const DEFAULT_REQUEST_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** Default byte budget, matching the thumbnail cache policy. */
export const DEFAULT_REQUEST_CACHE_MAX_BYTES = 256 * 1024 * 1024
/** Never touch variants younger than this: a request may still be in flight. */
export const DEFAULT_REQUEST_CACHE_KEEP_MS = 60 * 60 * 1000
/** The cache layout is <dir>/<2 hex>/<variant hash>; two levels are enough. */
const MAX_DEPTH = 2

export interface RequestCachePruneOptions {
  /** Absolute request-image cache root. */
  dir: string
  /** Delete files older than this (default 14 days). */
  ttlMs?: number
  /** Keep the total under this many bytes (0 disables the cap). */
  maxBytes?: number
  /** Window of recent files that pruning never touches. */
  keepMs?: number
  /** Injectable clock for tests. */
  now?: number
  /** Additional roots whose files must never be pruned (for example the raw vault). */
  protectedRoots?: string[]
}

export interface RequestCachePruneStats {
  scanned: number
  removed: number
  freedBytes: number
  remainingBytes: number
}

interface CacheFile {
  path: string
  bytes: number
  mtimeMs: number
}

/** Resolve the default cache root below DSH_HOME. */
export function resolveRequestImageCacheDir(home?: string): string {
  const root = home?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'cache', 'attachments', 'request-images')
}

/** Durable attachment objects; never a pruning target, even via a broad override. */
export function durableAttachmentsRoot(): string {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'attachments')
}

function comparable(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/** Resolve through junctions/symlinks, falling back to the nearest existing ancestor. */
async function canonicalPath(path: string): Promise<string> {
  let probe = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      const real = await realpath(probe)
      return comparable(join(real, ...suffix.reverse()))
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return comparable(resolve(path))
      suffix.push(basename(probe))
      probe = parent
    }
  }
}

async function overlapsProtectedRoot(target: string, roots: readonly string[]): Promise<boolean> {
  for (const root of roots) {
    const protectedRoot = await canonicalPath(root)
    if (target === protectedRoot || isWithin(target, protectedRoot) || isWithin(protectedRoot, target)) return true
  }
  return false
}

/** True when the directory is the durable attachment tree or one of its ancestors. */
export function overlapsDurableAttachments(dir: string, attachmentsRoot = durableAttachmentsRoot()): boolean {
  const target = resolve(dir)
  const durable = resolve(attachmentsRoot)
  const prefix = target.endsWith(sep) ? target : target + sep
  return target === durable || target.startsWith(durable + sep) || durable.startsWith(prefix)
}

/**
 * Remove stale request-image variants.
 *
 * The attachment backend writes one file per (attachment, target) variant and
 * never cleans them up itself, so a gallery full of 320 px thumbnails grows it
 * without bound. Deletion is safe: variants are deterministic and regenerated
 * on demand, so removing an entry only costs one sharp pass next time.
 */
export async function pruneRequestImageCache(options: RequestCachePruneOptions): Promise<RequestCachePruneStats> {
  const ttlMs = options.ttlMs ?? DEFAULT_REQUEST_CACHE_TTL_MS
  const maxBytes = options.maxBytes ?? DEFAULT_REQUEST_CACHE_MAX_BYTES
  const keepMs = options.keepMs ?? DEFAULT_REQUEST_CACHE_KEEP_MS
  const now = options.now ?? Date.now()
  const protectedRoots = options.protectedRoots ?? [durableAttachmentsRoot()]
  // Pin the root once; resolving it again inside the overlap check leaves a
  // swap window between the two resolutions.
  const cacheRoot = await canonicalPath(options.dir)
  if (await overlapsProtectedRoot(cacheRoot, protectedRoots)) {
    return { scanned: 0, removed: 0, freedBytes: 0, remainingBytes: 0 }
  }
  const files: CacheFile[] = []
  await collect(options.dir, 0, files, cacheRoot)

  let remainingBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const protectedAfter = now - keepMs
  const expiredBefore = now - ttlMs
  const doomed = new Set<string>()

  for (const file of files) {
    if (file.mtimeMs < expiredBefore && file.mtimeMs < protectedAfter) {
      doomed.add(file.path)
      remainingBytes -= file.bytes
    }
  }

  if (maxBytes > 0 && remainingBytes > maxBytes) {
    const candidates = files
      .filter(file => !doomed.has(file.path) && file.mtimeMs < protectedAfter)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of candidates) {
      if (remainingBytes <= maxBytes) break
      doomed.add(file.path)
      remainingBytes -= file.bytes
    }
  }

  let removed = 0
  let freedBytes = 0
  for (const file of files) {
    if (!doomed.has(file.path)) continue
    try {
      // Re-check immediately before unlink: a path that was a regular file
      // during collect may have been swapped for a symlink/junction since.
      const latest = await lstat(file.path)
      if (latest.isSymbolicLink() || !latest.isFile() || !isWithin(await canonicalPath(file.path), cacheRoot)) {
        remainingBytes += file.bytes
        continue
      }
      await unlink(file.path)
      removed += 1
      freedBytes += file.bytes
    } catch {
      // A concurrent writer or a locked file: leave it for the next pass.
      remainingBytes += file.bytes
    }
  }

  return { scanned: files.length, removed, freedBytes, remainingBytes }
}

async function collect(dir: string, depth: number, out: CacheFile[], cacheRoot: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    let info
    try {
      info = await lstat(path)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      if (depth >= MAX_DEPTH) continue
      if (!isWithin(await canonicalPath(path), cacheRoot)) continue
      await collect(path, depth + 1, out, cacheRoot)
      continue
    }
    if (!info.isFile()) continue
    if (!isWithin(await canonicalPath(path), cacheRoot)) continue
    try {
      const latest = await stat(path)
      out.push({ path, bytes: latest.size, mtimeMs: latest.mtimeMs })
    } catch {
      // Raced with a writer or a concurrent prune: skip.
    }
  }
}
