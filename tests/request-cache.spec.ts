import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneRequestImageCache, resolveRequestImageCacheDir } from '../src/request-cache.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-request-cache-'))
  roots.push(root)
  return root
}

async function writeVariant(root: string, bucket: string, name: string, bytes: number, ageMs: number): Promise<string> {
  const dir = join(root, bucket)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, Buffer.alloc(bytes, 0x61))
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
  return path
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('request-image cache pruning', () => {
  it('ignores a missing cache directory', async () => {
    const stats = await pruneRequestImageCache({ dir: join(tmpdir(), 'dsh-request-cache-missing-' + String(Date.now())) })
    expect(stats).toEqual({ scanned: 0, removed: 0, freedBytes: 0, remainingBytes: 0 })
  })

  it('deletes variants past the TTL but keeps fresh ones', async () => {
    const root = await makeRoot()
    const old = await writeVariant(root, 'ab', 'old', 100, 20 * DAY)
    const fresh = await writeVariant(root, 'cd', 'fresh', 50, 2 * HOUR)
    const stats = await pruneRequestImageCache({ dir: root, ttlMs: 14 * DAY, maxBytes: 0 })
    expect(stats.scanned).toBe(2)
    expect(stats.removed).toBe(1)
    expect(stats.freedBytes).toBe(100)
    expect(stats.remainingBytes).toBe(50)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('evicts the oldest variants until the byte budget is met', async () => {
    const root = await makeRoot()
    const oldest = await writeVariant(root, 'aa', 'one', 40, 10 * DAY)
    const middle = await writeVariant(root, 'bb', 'two', 40, 5 * DAY)
    const newest = await writeVariant(root, 'cc', 'three', 40, 2 * DAY)
    const stats = await pruneRequestImageCache({ dir: root, ttlMs: 365 * DAY, maxBytes: 60, keepMs: HOUR })
    expect(stats.removed).toBe(2)
    expect(stats.remainingBytes).toBe(40)
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(false)
    expect(existsSync(newest)).toBe(true)
  })

  it('never deletes variants touched inside the keep window', async () => {
    const root = await makeRoot()
    const recent = await writeVariant(root, 'aa', 'recent', 100, 10 * 60 * 1000)
    const stats = await pruneRequestImageCache({ dir: root, ttlMs: 1, maxBytes: 1, keepMs: HOUR })
    expect(stats.removed).toBe(0)
    expect(existsSync(recent)).toBe(true)
  })

  it('walks the two-level bucket layout', async () => {
    const root = await makeRoot()
    const nested = await writeVariant(root, 'ab', 'nested', 10, 30 * DAY)
    const stats = await pruneRequestImageCache({ dir: root, ttlMs: 14 * DAY, maxBytes: 0 })
    expect(stats.removed).toBe(1)
    expect(existsSync(nested)).toBe(false)
  })

  it('resolves the default directory below DSH_HOME', () => {
    expect(resolveRequestImageCacheDir('/tmp/dsh-home')).toBe(join('/tmp/dsh-home', 'cache', 'attachments', 'request-images'))
  })
})
