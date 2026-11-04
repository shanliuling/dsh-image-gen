/** Persistent per-profile vault references so one client cannot delete another client's originals. */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidVaultKey } from './vault-store.js'

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
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { version?: unknown; profiles?: unknown }
  if (raw.version !== 1 || typeof raw.profiles !== 'object' || raw.profiles === null) return undefined
  const profiles: Record<string, VaultRegistryProfile> = {}
  for (const [profileId, profile] of Object.entries(raw.profiles as Record<string, unknown>)) {
    if (!isValidVaultProfileId(profileId)) continue
    if (typeof profile !== 'object' || profile === null) continue
    const keys = (profile as { keys?: unknown }).keys
    if (!Array.isArray(keys)) continue
    const valid = keys.filter((key): key is string => typeof key === 'string' && isValidVaultKey(key))
    profiles[profileId] = {
      keys: Array.from(new Set(valid)),
      updatedAt: typeof (profile as { updatedAt?: unknown }).updatedAt === 'number'
        ? (profile as { updatedAt: number }).updatedAt
        : 0,
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

/**
 * Merge one profile's complete key set into the persistent registry.
 * The first registry creation adopts all pre-existing vault keys into a
 * legacy profile so an upgrade cannot delete files before their client opens.
 */
export function updateVaultRegistry(
  dir: string,
  profileId: string,
  keys: readonly string[],
): Promise<VaultRegistry | undefined> {
  const previous = queues.get(dir) ?? Promise.resolve()
  const operation = previous.then(async () => {
    const loaded = await loadVaultRegistry(dir)
    if (loaded.status === 'corrupt') return undefined
    const registry: VaultRegistry = loaded.registry ?? { version: 1, profiles: {} }
    registry.profiles[profileId] = {
      keys: Array.from(new Set(keys.filter(isValidVaultKey))),
      updatedAt: Date.now(),
    }
    try {
      await mkdir(dir, { recursive: true })
      const target = registryPath(dir)
      const temporary = target + '.tmp-' + String(process.pid) + '-' + String(Date.now())
      await writeFile(temporary, JSON.stringify(registry, null, 2), 'utf8')
      try {
        await rename(temporary, target)
      } catch (err) {
        // Windows can reject rename over an existing file; retry after removing it.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' && (err as NodeJS.ErrnoException).code !== 'EPERM') throw err
        await unlink(target).catch(() => undefined)
        await rename(temporary, target)
      }
      return registry
    } catch {
      return undefined
    }
  })
  queues.set(dir, operation.catch(() => undefined))
  return operation
}

export function unionVaultKeys(registry: VaultRegistry): string[] {
  const keys = new Set<string>()
  for (const profile of Object.values(registry.profiles)) {
    for (const key of profile.keys) keys.add(key)
  }
  return Array.from(keys)
}
