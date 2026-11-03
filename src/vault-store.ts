/** Content-addressed store for original image bytes the attachment layer normalized. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

export const VAULT_KEY_PATTERN = /^[a-f0-9]{64}$/

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const MEDIA_TYPE: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export interface VaultConfig {
  enabled: boolean
  dir: string
  /** 0 disables the size cap; referenced files may be evicted oldest-first. */
  maxBytes: number
}

export interface SavedOriginal {
  key: string
  bytes: number
  mediaType: ImageMediaType
}

export function resolveDshHome(home?: string): string {
  return home?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function resolveVaultDir(home?: string): string {
  return join(resolveDshHome(home), 'image-gen', 'vault')
}

/** Resolve a configured vault path; relative values stay below the DSH home, not the process cwd. */
export function resolveVaultPath(configured: string, home?: string): string {
  const value = configured.trim()
  if (value.length === 0) return resolveVaultDir(home)
  return isAbsolute(value) ? value : join(resolveDshHome(home), value)
}

export function isValidVaultKey(key: string): boolean {
  return VAULT_KEY_PATTERN.test(key)
}

/** Persist one original file; the same bytes are shared through content addressing. */
export async function saveOriginal(
  config: VaultConfig,
  input: { data: Uint8Array; mediaType: ImageMediaType },
): Promise<SavedOriginal | undefined> {
  if (!config.enabled) return undefined
  const extension = EXTENSION[input.mediaType]
  if (extension === undefined) return undefined
  const key = createHash('sha256').update(input.data).digest('hex')
  const target = join(config.dir, key.slice(0, 2), key + '.' + extension)
  try {
    const existing = await stat(target)
    if (existing.size === input.data.byteLength) return { key, bytes: existing.size, mediaType: input.mediaType }
  } catch {
    // Missing files are written below.
  }
  await mkdir(dirname(target), { recursive: true })
  const temporary = target + '.tmp-' + String(process.pid) + '-' + String(Date.now())
  try {
    await writeFile(temporary, input.data)
    await rename(temporary, target)
  } catch (err) {
    await unlink(temporary).catch(() => undefined)
    throw err
  }
  return { key, bytes: input.data.byteLength, mediaType: input.mediaType }
}

export async function readOriginal(
  config: VaultConfig,
  key: string,
  preferredMediaType?: string,
): Promise<{ data: Buffer; mediaType: ImageMediaType } | undefined> {
  if (!config.enabled || !isValidVaultKey(key)) return undefined
  // The caller usually knows the stored media type; skip probing the other
  // extensions. Unknown hints fall back to the full probe for old clients.
  const preferred = preferredMediaType === undefined ? undefined : EXTENSION[preferredMediaType]
  const all = Object.entries(MEDIA_TYPE)
  // Try the hinted extension first, then fall back so a stale hint cannot hide
  // a file that is still present under another known extension.
  const candidates: readonly (readonly [string, ImageMediaType])[] = preferred === undefined
    ? all
    : [[preferred, preferredMediaType as ImageMediaType] as const, ...all.filter(([extension]) => extension !== preferred)]
  for (const [extension, mediaType] of candidates) {
    try {
      return { data: await readFile(join(config.dir, key.slice(0, 2), key + '.' + extension)), mediaType }
    } catch {
      // Try the next known extension.
    }
  }
  return undefined
}

export interface VaultGcOptions {
  /** Keep files written this recently even when unreferenced (multi-window import race). */
  protectRecentMs?: number
  /** Abandoned .tmp-* files older than this are removed; 0 disables the sweep. */
  tempMaxAgeMs?: number
}

const TEMPORARY_NAME = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)\.tmp-\d+-\d+$/

/** Remove write temporaries left behind by a crash; older than the cutoff only. */
async function removeStaleTemporaries(config: VaultConfig, maxAgeMs: number): Promise<void> {
  if (maxAgeMs <= 0) return
  const cutoff = Date.now() - maxAgeMs
  try {
    for (const shard of await readdir(config.dir, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue
      for (const entry of await readdir(join(config.dir, shard.name), { withFileTypes: true })) {
        if (!entry.isFile() || !TEMPORARY_NAME.test(entry.name)) continue
        const path = join(config.dir, shard.name, entry.name)
        try {
          const info = await stat(path)
          if (info.mtimeMs <= cutoff) await unlink(path)
        } catch {
          // Removed concurrently or still being written.
        }
      }
    }
  } catch {
    // The vault directory may not exist yet.
  }
}

interface VaultFile {
  path: string
  key: string
  bytes: number
  mtimeMs: number
}

async function listVaultFiles(config: VaultConfig): Promise<VaultFile[]> {
  const files: VaultFile[] = []
  try {
    for (const shard of await readdir(config.dir, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue
      for (const entry of await readdir(join(config.dir, shard.name), { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const dot = entry.name.lastIndexOf('.')
        const key = dot > 0 ? entry.name.slice(0, dot) : entry.name
        if (!isValidVaultKey(key)) continue
        const path = join(config.dir, shard.name, entry.name)
        try {
          const info = await stat(path)
          files.push({ path, key, bytes: info.size, mtimeMs: info.mtimeMs })
        } catch {
          // Removed between readdir and stat.
        }
      }
    }
  } catch {
    return []
  }
  return files
}

/** Remove files no gallery record references, then evict oldest if the cap is exceeded. */
export async function gcVault(
  config: VaultConfig,
  referencedKeys: Iterable<string>,
  options: VaultGcOptions = {},
): Promise<{ removed: number; bytes: number }> {
  if (!config.enabled) return { removed: 0, bytes: 0 }
  await removeStaleTemporaries(config, options.tempMaxAgeMs ?? 60 * 60 * 1000)
  const protectRecentMs = options.protectRecentMs ?? 0
  const now = Date.now()
  const references = new Set<string>()
  for (const key of referencedKeys) {
    if (isValidVaultKey(key)) references.add(key)
  }
  const files = await listVaultFiles(config)
  let removed = 0
  let bytes = 0
  const keep: VaultFile[] = []
  for (const file of files) {
    if (references.has(file.key)) {
      keep.push(file)
      continue
    }
    // A concurrent window may have saved this key but not yet written its
    // gallery record; deleting it here would silently lose the original.
    if (protectRecentMs > 0 && now - file.mtimeMs < protectRecentMs) {
      keep.push(file)
      continue
    }
    try {
      await unlink(file.path)
      removed += 1
      bytes += file.bytes
    } catch {
      // A concurrent gc or a locked file: leave it for the next sweep.
    }
  }
  if (config.maxBytes > 0) {
    let total = keep.reduce((sum, file) => sum + file.bytes, 0)
    if (total > config.maxBytes) {
      keep.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const file of keep) {
        if (total <= config.maxBytes) break
        try {
          await unlink(file.path)
          removed += 1
          bytes += file.bytes
          total -= file.bytes
        } catch {
          // Keep the budget calculation conservative on failure.
        }
      }
    }
  }
  // Drop shard directories that became empty so deleting every image also
  // removes the visible folder tree, not just the files.
  try {
    for (const shard of await readdir(config.dir, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue
      try { await rmdir(join(config.dir, shard.name)) } catch { /* non-empty or locked */ }
    }
  } catch {
    // The vault directory itself may not exist yet.
  }
  return { removed, bytes }
}
