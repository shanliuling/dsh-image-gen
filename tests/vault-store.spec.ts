import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gcVault, readOriginal, saveOriginal, type VaultConfig } from '../src/vault-store.js'

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
