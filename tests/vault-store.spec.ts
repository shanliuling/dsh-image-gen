import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gcVault, readOriginal, resolveVaultPath, saveOriginal, type VaultConfig } from '../src/vault-store.js'

const dirs: string[] = []

async function makeConfig(overrides: Partial<VaultConfig> = {}): Promise<VaultConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vault-'))
  dirs.push(dir)
  return { enabled: true, dir, maxBytes: 0, ...overrides }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('raw image vault store', () => {
  it('resolves relative overrides below the DSH home, not the process cwd', () => {
    expect(resolveVaultPath('raw-images', '/srv/dsh')).toBe('/srv/dsh/raw-images')
    expect(resolveVaultPath('', '/srv/dsh')).toBe('/srv/dsh/image-gen/vault')
    expect(resolveVaultPath('/var/vault', '/srv/dsh')).toBe('/var/vault')
  })

  it('saves content-addressed originals, dedupes and reads them back', async () => {
    const config = await makeConfig()
    const data = new Uint8Array([1, 2, 3, 4])
    const first = await saveOriginal(config, { data, mediaType: 'image/png' })
    expect(first?.bytes).toBe(4)
    const second = await saveOriginal(config, { data, mediaType: 'image/png' })
    expect(second?.key).toBe(first?.key)
    expect(second?.bytes).toBe(4)

    const read = await readOriginal(config, first!.key)
    expect(read?.mediaType).toBe('image/png')
    expect(Array.from(read!.data)).toEqual([1, 2, 3, 4])
    expect((await readdir(join(config.dir, first!.key.slice(0, 2)))).length).toBe(1)
  })

  it('rejects malformed keys and non-enabled vaults', async () => {
    const config = await makeConfig()
    expect(await readOriginal(config, '../etc/passwd')).toBeUndefined()
    expect(await readOriginal(config, 'a'.repeat(63))).toBeUndefined()
    expect(await readOriginal({ ...config, enabled: false }, 'a'.repeat(64))).toBeUndefined()
  })

  it('garbage-collects only unreferenced files', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const dropped = await saveOriginal(config, { data: new Uint8Array([2]), mediaType: 'image/png' })
    const stats = await gcVault(config, [kept!.key])
    expect(stats.removed).toBe(1)
    expect(stats.bytes).toBe(1)
    expect(await readOriginal(config, kept!.key)).toBeDefined()
    expect(await readOriginal(config, dropped!.key)).toBeUndefined()
    const shards = await readdir(config.dir)
    expect(shards).toEqual([kept!.key.slice(0, 2)])
  })

  it('protects recently written files from a concurrent window gc', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const recent = await saveOriginal(config, { data: new Uint8Array([2]), mediaType: 'image/png' })
    const protectedStats = await gcVault(config, [kept!.key], { protectRecentMs: 60_000 })
    expect(protectedStats.removed).toBe(0)
    expect(await readOriginal(config, recent!.key)).toBeDefined()

    const sweep = await gcVault(config, [kept!.key])
    expect(sweep.removed).toBe(1)
    expect(await readOriginal(config, recent!.key)).toBeUndefined()
  })

  it('removes stale write temporaries and empty shards', async () => {
    const config = await makeConfig()
    const shard = join(config.dir, 'aa')
    await mkdir(shard, { recursive: true })
    const temporary = join(shard, 'a'.repeat(64) + '.png.tmp-1-2')
    await writeFile(temporary, 'partial')
    await utimes(temporary, new Date(1_000), new Date(1_000))
    const stats = await gcVault(config, [])
    expect(stats.removed).toBe(0)
    expect(await readdir(config.dir)).toEqual([])
  })

  it('honours a media type hint and still falls back to other extensions', async () => {
    const config = await makeConfig()
    const saved = await saveOriginal(config, { data: new Uint8Array([7, 7]), mediaType: 'image/jpeg' })
    expect((await readOriginal(config, saved!.key, 'image/jpeg'))?.mediaType).toBe('image/jpeg')
    // A stale hint must not make an existing file unreachable.
    expect((await readOriginal(config, saved!.key, 'image/png'))?.mediaType).toBe('image/jpeg')
  })

  it('evicts the oldest file when the byte cap is exceeded', async () => {
    const config = await makeConfig({ maxBytes: 2 })
    const old = await saveOriginal(config, { data: new Uint8Array([1, 1]), mediaType: 'image/png' })
    const fresh = await saveOriginal(config, { data: new Uint8Array([2, 2]), mediaType: 'image/png' })
    const oldPath = join(config.dir, old!.key.slice(0, 2), old!.key + '.png')
    const freshPath = join(config.dir, fresh!.key.slice(0, 2), fresh!.key + '.png')
    await utimes(oldPath, new Date(1_000), new Date(1_000))
    await utimes(freshPath, new Date(2_000), new Date(2_000))

    const stats = await gcVault(config, [old!.key, fresh!.key])
    expect(stats.removed).toBe(1)
    expect(await readOriginal(config, old!.key)).toBeUndefined()
    expect(await readOriginal(config, fresh!.key)).toBeDefined()
  })
})
