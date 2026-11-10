import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalleryItem } from '../src/client/gallery-store.js'

// A minimal in-memory IndexedDB stand-in: requests fire their success/error
// handler on the next microtask, mirroring how a real IDBRequest settles.
type FakeRequest = {
  onsuccess: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  result: unknown
  error: unknown
}

function createFakeIndexedDB() {
  const records = new Map<string, Record<string, unknown>>()
  const tombstoneIds = new Set<string>()
  const state = { openCalls: 0, failOpens: false }

  const schedule = (request: FakeRequest, error?: unknown): void => {
    queueMicrotask(() => { (error === undefined ? request.onsuccess : request.onerror)?.({ target: request }) })
  }

  const objectStore = (name: string) => ({
    get: (id: string) => {
      const request: FakeRequest = {
        onsuccess: null, onerror: null,
        result: name === 'gallery_tombstones' ? (tombstoneIds.has(id) ? { id } : undefined) : records.get(id),
        error: undefined,
      }
      schedule(request)
      return request
    },
    put: (record: Record<string, unknown>) => {
      records.set(String(record.id), record)
      const request: FakeRequest = { onsuccess: null, onerror: null, result: undefined, error: undefined }
      schedule(request)
      return request
    },
    getAllKeys: () => {
      const request: FakeRequest = { onsuccess: null, onerror: null, result: [...tombstoneIds], error: undefined }
      schedule(request)
      return request
    },
  })

  const db = {
    objectStoreNames: { contains: () => true },
    transaction: (_names: string | string[]) => {
      const tx = { objectStore: (name: string) => objectStore(name), oncomplete: null as (() => void) | null, onerror: null, onabort: null }
      setTimeout(() => tx.oncomplete?.(), 0)
      return tx
    },
    onversionchange: null,
  }

  return {
    records,
    tombstoneIds,
    state,
    indexedDB: {
      open: () => {
        state.openCalls += 1
        const error = state.failOpens ? new Error('quota exceeded') : undefined
        const request: FakeRequest = { onsuccess: null, onerror: null, result: db, error }
        schedule(request, error)
        return request
      },
    },
  }
}

const loadStore = async () => import('../src/client/gallery-store.js')

const item = (id: string): GalleryItem => ({
  id,
  attachment: { attachmentId: 1, mediaType: 'image/png' } as GalleryItem['attachment'],
  prompt: 'a red panda',
  provider: 'openai',
  model: 'gpt-image-1',
  createdAt: 123,
})

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals() })

describe('saveGalleryItem failure signalling', () => {
  it('honors a deletion written by another tab after this tab cached the tombstones', async () => {
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake.indexedDB)
    const store = await loadStore()
    await store.saveGalleryItem(item('first'))
    fake.tombstoneIds.add('deleted-elsewhere')
    await store.saveGalleryItem(item('deleted-elsewhere'))
    expect(fake.records.has('deleted-elsewhere')).toBe(false)
  })
  it('resolves to false when IndexedDB cannot open, instead of swallowing the failure', async () => {
    const fake = createFakeIndexedDB()
    fake.state.failOpens = true
    vi.stubGlobal('indexedDB', fake.indexedDB)
    const store = await loadStore()

    await expect(store.saveGalleryItem(item('a1'))).resolves.toBe(false)
    expect(fake.records.size).toBe(0)
  })

  it('retries opening the database on the next call after an open failure', async () => {
    const fake = createFakeIndexedDB()
    fake.state.failOpens = true
    vi.stubGlobal('indexedDB', fake.indexedDB)
    const store = await loadStore()

    await expect(store.saveGalleryItem(item('a1'))).resolves.toBe(false)
    expect(fake.state.openCalls).toBe(1)

    // The failed open must not be cached: a later attempt can recover.
    fake.state.failOpens = false
    await expect(store.saveGalleryItem(item('a1'))).resolves.toBe(true)
    expect(fake.state.openCalls).toBe(2)
    expect(fake.records.size).toBe(1)
  })

  it('resolves to true without writing when the item was tombstoned', async () => {
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake.indexedDB)
    fake.tombstoneIds.add('deleted-1')
    const store = await loadStore()

    await expect(store.saveGalleryItem(item('deleted-1'))).resolves.toBe(true)
    expect(fake.records.has('deleted-1')).toBe(false)
  })

  it('resolves to true, persists the record, and notifies listeners on success', async () => {
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake.indexedDB)
    const store = await loadStore()
    const listener = vi.fn()
    store.subscribeGallery(listener)

    await expect(store.saveGalleryItem(item('a1'))).resolves.toBe(true)
    expect(fake.records.get('a1')).toMatchObject({ id: 'a1', prompt: 'a red panda' })
    expect(fake.records.get('a1')).not.toHaveProperty('isFavorite')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps preserving existing favorite and tags fields across re-saves', async () => {
    const fake = createFakeIndexedDB()
    vi.stubGlobal('indexedDB', fake.indexedDB)
    const store = await loadStore()

    await store.saveGalleryItem({ ...item('a1'), isFavorite: true, tags: ['portrait'] })
    await store.saveGalleryItem({ ...item('a1'), prompt: 'updated prompt' })

    expect(fake.records.get('a1')).toMatchObject({
      prompt: 'updated prompt',
      isFavorite: true,
      tags: ['portrait'],
    })
  })
})
