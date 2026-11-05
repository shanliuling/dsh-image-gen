/** Persistent per-profile vault references so one client cannot delete another client's originals. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { deleteVaultKeys, isValidVaultKey, listVaultKeys, saveOriginal, type SavedOriginal, type VaultConfig } from './vault-store.js'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

export interface VaultRegistryProfile {
  keys: string[]
  updatedAt: number
}

export interface VaultRegistry {
  version: 1
  profiles: Record<string, VaultRegistryProfile>
}

export interface VaultRegistryLoad {
  status: 'ok' | 'missing' | 'corrupt'
  registry?: VaultRegistry
}

const REGISTRY_FILE = '.refs.json'
const PROFILE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

export function isValidVaultProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_PATTERN.test(value)
}

function registryPath(dir: string): string {
  return join(dir, REGISTRY_FILE)
}

function normalizeRegistry(value: unknown): VaultRegistry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as { version?: unknown; profiles?: unknown }
  if (raw.version !== 1 || typeof raw.profiles !== 'object' || raw.profiles === null || Array.isArray(raw.profiles)) return undefined
  const profiles: Record<string, VaultRegistryProfile> = Object.create(null) as Record<string, VaultRegistryProfile>
  for (const [profileId, profile] of Object.entries(raw.profiles as Record<string, unknown>)) {
    // A malformed profile can hide another browser's last reference. Never
    // turn partial corruption into an apparently valid, smaller reference set.
    if (!isValidVaultProfileId(profileId) || typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
    const { keys, updatedAt } = profile as { keys?: unknown; updatedAt?: unknown }
    if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === 'string' && isValidVaultKey(key))) return undefined
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return undefined
    profiles[profileId] = {
      keys: Array.from(new Set(keys)),
      updatedAt,
    }
  }
  return { version: 1, profiles }
}

export async function loadVaultRegistry(dir: string): Promise<VaultRegistryLoad> {
  try {
    const parsed: unknown = JSON.parse(await readFile(registryPath(dir), 'utf8'))
    const registry = normalizeRegistry(parsed)
    return registry === undefined ? { status: 'corrupt' } : { status: 'ok', registry }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'corrupt' }
  }
}

const queues = new Map<string, Promise<unknown>>()

/** Canonicalize existing ancestors too, so aliases share a lock before creation. */
async function vaultTransactionKey(dir: string): Promise<string> {
  let parent = resolve(dir)
  const suffix: string[] = []
  while (true) {
    try {
      const canonical = join(await realpath(parent), ...suffix)
      return process.platform === 'win32' ? canonical.toLowerCase() : canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
      suffix.unshift(basename(parent))
      parent = dirname(parent)
    }
  }
}

/** Serialize reference mutations and deletion together within this host. */
async function inVaultTransaction<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const key = await vaultTransactionKey(dir)
  const previous = queues.get(key) ?? Promise.resolve()
  const operation = previous.then(run)
  const tail = operation.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return operation
}

/** Persist a complete profile only after all newly claimed originals exist. */
async function writeVaultProfile(dir: string, profileId: string, keys: readonly string[], loaded: VaultRegistryLoad): Promise<VaultRegistry | undefined> {
  if (loaded.status === 'corrupt' || !isValidVaultProfileId(profileId) || profileId === 'legacy-vault' || !keys.every(isValidVaultKey)) return undefined
  const registry: VaultRegistry = loaded.registry ?? { version: 1, profiles: {} }
  const accepted = Array.from(new Set(keys))
  const previous = new Set(registry.profiles[profileId]?.keys ?? [])
  let existing: string[] | undefined
  if (loaded.status === 'missing' || accepted.some(key => !previous.has(key))) {
    existing = await listVaultKeys({ enabled: true, dir })
    const available = new Set(existing)
    // A sync queued behind a deletion must fail instead of acknowledging a
    // dangling reference to the file that the earlier transaction removed.
    if (accepted.some(key => !available.has(key))) return undefined
  }
  if (loaded.status === 'missing') {
    const legacy = existing!.filter(key => !accepted.includes(key))
    if (legacy.length > 0) registry.profiles['legacy-vault'] = { keys: legacy, updatedAt: 0 }
  }
  Object.defineProperty(registry.profiles, profileId, {
    value: { keys: accepted, updatedAt: Date.now() }, enumerable: true, writable: true, configurable: true,
  })
  await persistRegistry(dir, registry)
  return registry
}

async function persistRegistry(dir: string, registry: VaultRegistry): Promise<void> {
  await mkdir(dir, { recursive: true })
  const target = registryPath(dir)
  const temporary = target + '.tmp-' + randomUUID()
  try {
    await writeFile(temporary, JSON.stringify(registry, null, 2), 'utf8')
    // Never unlink the previous registry to work around a failed replacement:
    // retaining the old references is safer than leaving a missing registry.
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Store and claim an import in the same transaction used by explicit deletion. */
export function saveImportedOriginal(
  config: VaultConfig, input: { data: Uint8Array; mediaType: ImageMediaType }, profileId?: string,
): Promise<SavedOriginal | undefined> {
  if (!config.enabled) return Promise.resolve(undefined)
  return inVaultTransaction(config.dir, async () => {
    if (profileId !== undefined && (!isValidVaultProfileId(profileId) || profileId === 'legacy-vault')) throw new Error('invalid-vault-profile')
    const loaded = await loadVaultRegistry(config.dir)
    if (loaded.status === 'corrupt') throw new Error('registry-unavailable')
    const registry: VaultRegistry = loaded.registry ?? { version: 1, profiles: {} }
    if (loaded.status === 'missing') {
      const legacy = await listVaultKeys(config)
      if (legacy.length > 0) registry.profiles['legacy-vault'] = { keys: legacy, updatedAt: 0 }
    }
    const saved = await saveOriginal(config, input)
    if (saved === undefined) return undefined
    // Old clients cannot acknowledge ownership; retain their imports as legacy
    // rather than exposing them to a different browser's manual deletion.
    const owner = profileId ?? 'legacy-vault'
    Object.defineProperty(registry.profiles, owner, {
      value: { keys: [...new Set([...(registry.profiles[owner]?.keys ?? []), saved.key])], updatedAt: Date.now() },
      enumerable: true, configurable: true, writable: true,
    })
    await persistRegistry(config.dir, registry)
    return saved
  })
}

/**
 * Merge one profile's complete key set into the persistent registry.
 *
 * On first creation, pre-existing vault files that the syncing profile does
 * not already reference are placed in a reserved legacy profile, so a browser
 * that has not opened yet cannot lose an original. Once a profile syncs a
 * legacy key, the unknown legacy owners remain protected too.
 */
export function updateVaultRegistry(
  dir: string,
  profileId: string,
  keys: readonly string[],
): Promise<VaultRegistry | undefined> {
  return inVaultTransaction(dir, async () => {
    const loaded = await loadVaultRegistry(dir)
    return writeVaultProfile(dir, profileId, [...(loaded.registry?.profiles[profileId]?.keys ?? []), ...keys], loaded)
  })
    .catch(() => undefined)
}

/** Remove explicitly owned keys using the same transaction as reference sync. */
export function deleteUnreferencedOriginals(
  config: VaultConfig, profileId: string, keys: readonly string[], deleteKeys: readonly string[],
): Promise<{ removed: number; bytes: number } | undefined> {
  return inVaultTransaction(config.dir, async () => {
    const loaded = await loadVaultRegistry(config.dir)
    if (loaded.status !== 'ok' || loaded.registry === undefined) return undefined
    const previouslyOwned = new Set(loaded.registry.profiles[profileId]?.keys ?? [])
    // A stale snapshot must not remove imports claimed after that snapshot was
    // read. Only explicitly deleted keys may release this profile's ownership.
    const removedKeys = new Set(deleteKeys)
    const remaining = [...previouslyOwned].filter(key => !removedKeys.has(key))
    const registry = await writeVaultProfile(config.dir, profileId, [...remaining, ...keys], loaded)
    if (registry === undefined) return undefined
    const referenced = new Set(unionVaultKeys(registry))
    const deletable = deleteKeys.filter(key => previouslyOwned.has(key) && !referenced.has(key))
    return deleteVaultKeys(config, deletable)
  }).catch(() => undefined)
}

export function unionVaultKeys(registry: VaultRegistry): string[] {
  const keys = new Set<string>()
  for (const profile of Object.values(registry.profiles)) {
    for (const key of profile.keys) keys.add(key)
  }
  return Array.from(keys)
}
