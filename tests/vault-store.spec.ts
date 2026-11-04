import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteVaultKeys, readOriginal, resolveVaultPath, saveOriginal, type VaultConfig } from '../src/vault-store.js'

const dirs: string[] = []

async function makeConfig(overrides: Partial<VaultConfig> = {}): Promise<VaultConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vault-'))
  dirs.push(dir)
  return { enabled: true, dir, ...overrides }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('raw image vault store', () => {
  it('resolves relative overrides below the DSH home, not the process cwd', () => {
    const home = join(tmpdir(), 'dsh-path-test')
    const absolute = join(tmpdir(), 'vault-absolute')
    expect(resolveVaultPath('raw-images', home)).toBe(join(home, 'raw-images'))
    expect(resolveVaultPath('', home)).toBe(join(home, 'image-gen', 'vault'))
    expect(resolveVaultPath(absolute, home)).toBe(absolute)
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

  it('deletes only the explicitly requested keys', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const dropped = await saveOriginal(config, { data: new Uint8Array([2]), mediaType: 'image/png' })
    const stats = await deleteVaultKeys(config, [dropped!.key])
    expect(stats).toEqual({ removed: 1, bytes: 1 })
    expect(await readOriginal(config, kept!.key)).toBeDefined()
    expect(await readOriginal(config, dropped!.key)).toBeUndefined()
  })

  it('keeps files that were not requested and removes empty shards', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([3]), mediaType: 'image/png' })
    const dropped = await saveOriginal(config, { data: new Uint8Array([4]), mediaType: 'image/png' })
    await deleteVaultKeys(config, [dropped!.key])
    expect(await readOriginal(config, kept!.key)).toBeDefined()
    const shards = await readdir(config.dir)
    expect(shards).toEqual([kept!.key.slice(0, 2)])
  })
});
