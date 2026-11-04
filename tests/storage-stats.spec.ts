import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectStorageStats } from '../src/storage-stats.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stats-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('storage stats', () => {
  it('counts attachments and reports unreferenced objects', async () => {
    const attachments = await makeRoot()
    await mkdir(join(attachments, 'aa'), { recursive: true })
    await writeFile(join(attachments, 'aa', 'hash1'), Buffer.alloc(10))
    await writeFile(join(attachments, 'aa', 'hash2'), Buffer.alloc(20))
    const requestImages = await makeRoot()
    await writeFile(join(requestImages, 'variant1'), Buffer.alloc(5))

    const stats = await collectStorageStats(['sha256:hash1'], { attachmentsRoot: attachments, requestImagesRoot: requestImages })
    expect(stats.attachments).toEqual({ count: 2, bytes: 30 })
    expect(stats.requestImages).toEqual({ count: 1, bytes: 5 })
    expect(stats.orphans.count).toBe(1)
    expect(stats.orphans.bytes).toBe(20)
    expect(stats.orphans.ids).toEqual(['sha256:hash2'])
  })

  it('accepts bare hashes as references', async () => {
    const attachments = await makeRoot()
    await writeFile(join(attachments, 'hash1'), Buffer.alloc(4))
    const requestImages = await makeRoot()
    const stats = await collectStorageStats(['hash1'], { attachmentsRoot: attachments, requestImagesRoot: requestImages })
    expect(stats.orphans.count).toBe(0)
  })

  it('tolerates missing directories', async () => {
    const attachments = join(await makeRoot(), 'missing')
    const requestImages = join(await makeRoot(), 'missing')
    const stats = await collectStorageStats([], { attachmentsRoot: attachments, requestImagesRoot: requestImages })
    expect(stats.attachments).toEqual({ count: 0, bytes: 0 })
    expect(stats.requestImages).toEqual({ count: 0, bytes: 0 })
    expect(stats.orphans.count).toBe(0)
  })
})
