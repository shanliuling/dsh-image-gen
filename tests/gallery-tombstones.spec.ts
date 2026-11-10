import { beforeEach, describe, expect, it, vi } from 'vitest'

type Request = { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown }

function installFakeIndexedDB() {
  const stores = new Map<string, Map<string, Record<string, unknown>>>()
  for (const name of ['gallery_history', 'gallery_tombstones', 'thumbs']) stores.set(name, new Map())
  const request = (run: () => unknown): Request => {
    const req: Request = { onsuccess: null, onerror: null, result: undefined }
    queueMicrotask(() => {
      req.result = run()
      req.onsuccess?.()
    })
    return req
  }
  const storeFor = (name: string) => {
    const map = stores.get(name) ?? new Map<string, Record<string, unknown>>()
    return {
      get: (key: string) => request(() => map.get(key)),
      put: (record: Record<string, unknown>) => request(() => map.set(String(record.id ?? record.key), record)),
      delete: (key: string) => request(() => map.delete(key)),
      getAllKeys: () => request(() => [...map.keys()]),
      getAll: () => request(() => [...map.values()]),
    }
  }
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    transaction: () => {
      const tx = { objectStore: (name: string) => storeFor(name), oncomplete: null as (() => void) | null, onerror: null as (() => void) | null }
      setTimeout(() => tx.oncomplete?.(), 0)
      return tx
    },
    onversionchange: null as (() => void) | null,
  }
  vi.stubGlobal('indexedDB', { open: () => { const req: Request = { onsuccess: null, onerror: null, result: db }; queueMicrotask(() => req.onsuccess?.()); return req } })
  return stores
}

describe('gallery tombstone retention', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('keeps deleted IDs after maintenance so old sessions cannot resurrect them', async () => {
    const stores = installFakeIndexedDB()
    const store = await import('../src/client/gallery-store.js')
    const map = stores.get('gallery_tombstones')
    map?.set('old', { id: 'old', deletedAt: Date.now() - 5_000 })
    map?.set('new', { id: 'new', deletedAt: Date.now() })

    const removed = await store.pruneTombstones(1_000)
    expect(removed).toBe(0)
    expect(map?.has('old')).toBe(true)
    expect(map?.has('new')).toBe(true)
    await store.saveGalleryItem({ id: 'old', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 1 }, provider: 'openai', prompt: '', model: '' })
    expect(stores.get('gallery_history')?.has('old')).toBe(false)
  })

  it('keeps everything inside the window', async () => {
    const stores = installFakeIndexedDB()
    const store = await import('../src/client/gallery-store.js')
    stores.get('gallery_tombstones')?.set('fresh', { id: 'fresh', deletedAt: Date.now() })
    expect(await store.pruneTombstones()).toBe(0)
    expect(stores.get('gallery_tombstones')?.has('fresh')).toBe(true)
  })
})
