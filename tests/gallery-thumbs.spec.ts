import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

type Request = { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown }

/** Minimal IndexedDB stand-in: four gallery stores plus the thumbnail store. */
function installFakeIndexedDB() {
  const stores = new Map<string, Map<string, Record<string, unknown>>>()
  for (const name of ['gallery_history', 'gallery_tombstones', 'favorite_prompts', 'favorite_folders', 'thumbs']) {
    stores.set(name, new Map())
  }
  const schedule = (request: Request): void => {
    queueMicrotask(() => request.onsuccess?.())
  }
  const request = (run: () => unknown): Request => {
    const req: Request = { onsuccess: null, onerror: null, result: undefined }
    queueMicrotask(() => {
      req.result = run()
      req.onsuccess?.()
    })
    return req
  }
  const storeFor = (name: string) => {
    const map = stores.get(name) ?? new Map()
    return {
      get: (key: string) => request(() => map.get(key)),
      put: (record: Record<string, unknown>) => request(() => {
        const key = String(record.id ?? record.key)
        map.set(key, record)
        return key
      }),
      delete: (key: string) => request(() => map.delete(key)),
      getAllKeys: () => request(() => [...map.keys()]),
      getAll: () => request(() => [...map.values()]),
      clear: () => request(() => map.clear()),
    }
  }
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    transaction: (names: string | string[]) => {
      const tx = {
        objectStore: (name: string) => storeFor(name),
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
      }
      setTimeout(() => tx.oncomplete?.(), 0)
      return tx
    },
    onversionchange: null as (() => void) | null,
  }
  const fake = {
    open: () => {
      const req: Request = { onsuccess: null, onerror: null, result: db }
      queueMicrotask(() => req.onsuccess?.())
      return req
    },
  }
  vi.stubGlobal('indexedDB', fake)
  return stores
}

const HELLO = new Blob([new Uint8Array([104, 105])], { type: 'image/webp' })

function attachment(id: string): ImageAttachmentRef {
  return { attachmentId: id as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 2, width: 4, height: 4 }
}

describe('gallery thumbnail cache lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('drops the thumbnail even when the record id is not the attachment id', async () => {
    const stores = installFakeIndexedDB()
    const store = await import('../src/client/gallery-store.js')
    const recordId = 'import-sha256:abc123-uuid'
    await store.saveGalleryItem({ id: recordId, attachment: attachment('sha256:abc123'), prompt: '', provider: 'import', model: '' })
    await store.putGalleryThumb('sha256:abc123@320', HELLO)
    expect(stores.get('thumbs')?.has('sha256:abc123@320')).toBe(true)

    await store.deleteGalleryItem(recordId)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(stores.get('thumbs')?.has('sha256:abc123@320')).toBe(false)
  })

  it('evicts the oldest thumbnails once the byte budget is exceeded', async () => {
    const stores = installFakeIndexedDB()
    const store = await import('../src/client/gallery-store.js')
    const blob = () => new Blob([new Uint8Array(10)])
    await store.putGalleryThumb('sha256:a@320', blob())
    await new Promise(resolve => setTimeout(resolve, 3))
    await store.putGalleryThumb('sha256:b@320', blob())
    await new Promise(resolve => setTimeout(resolve, 3))
    await store.putGalleryThumb('sha256:c@320', blob())

    const removed = await store.pruneGalleryThumbs(['sha256:a', 'sha256:b', 'sha256:c'], 25)
    expect(removed).toBe(1)
    expect(stores.get('thumbs')?.has('sha256:a@320')).toBe(false)
    expect(stores.get('thumbs')?.has('sha256:b@320')).toBe(true)
    expect(stores.get('thumbs')?.has('sha256:c@320')).toBe(true)
  })

  it('prunes thumbnails whose attachment is no longer in the gallery', async () => {
    const stores = installFakeIndexedDB()
    const store = await import('../src/client/gallery-store.js')
    await store.putGalleryThumb('sha256:live@320', HELLO)
    await store.putGalleryThumb('sha256:gone@320', HELLO)

    const removed = await store.pruneGalleryThumbs(['sha256:live'])
    expect(removed).toBe(1)
    expect(stores.get('thumbs')?.has('sha256:live@320')).toBe(true)
    expect(stores.get('thumbs')?.has('sha256:gone@320')).toBe(false)
  })
})
