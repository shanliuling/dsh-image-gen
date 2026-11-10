import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchGalleryItemBlob, galleryDownloadName, postZipDownload, shouldPrefetchOriginal, syncVaultRefs, type GalleryRecord } from '../src/client/gallery-media.js'
import type { GalleryItem } from '../src/client/gallery-store.js'
import { parseImageAttachmentRef } from '../src/reference-image.js'

afterEach(() => vi.unstubAllGlobals())

type Request = { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown }

/** The gallery store's IndexedDB surface, enough for saveGalleryItem and its tombstone check. */
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

describe('gallery original reference sync', () => {
  it('submits 2000 compact attachment refs that the real ZIP parser still accepts', () => {
    let body = ''
    vi.stubGlobal('document', {
      body: { appendChild() {} },
      createElement: () => {
        const children: Array<{ name: string; value: string }> = []
        return { style: {}, appendChild: (child: { name: string; value: string }) => children.push(child), remove() {}, submit() { body = new URLSearchParams(children.map(child => [child.name, child.value])).toString() } }
      },
    })
    vi.stubGlobal('window', { setTimeout() {} })
    const item: GalleryItem = {
      id: 'import-normal', provider: 'import', prompt: '', model: '', createdAt: 0,
      attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/jpeg', bytes: 24996, width: 1672, height: 2508, name: 'fixture-portrait.png', originalDimensions: { width: 2400, height: 3600 } },
      original: { key: 'b'.repeat(64), bytes: 121331, mediaType: 'image/png' },
    }
    postZipDownload(Array.from({ length: 2000 }, () => item), 'zip-contract-1234')
    const payload = JSON.parse(new URLSearchParams(body).get('items')!) as Array<{ attachment: unknown }>
    expect(payload).toHaveLength(2000)
    expect(payload.every(entry => parseImageAttachmentRef(entry.attachment) !== undefined)).toBe(true)
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024)
  })
  it('names a PNG original fallback from the resolved JPEG attachment bytes', async () => {
    const item: GalleryItem = {
      id: 'jpeg-fallback', provider: 'import', model: '', prompt: '', createdAt: 0,
      attachment: { attachmentId: 'sha256:' + 'd'.repeat(64), mediaType: 'image/jpeg', bytes: 3 },
      original: { key: 'a'.repeat(64), mediaType: 'image/png', bytes: 100 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } })))
    const blob = await fetchGalleryItemBlob(item)
    expect(blob.type).toBe('image/jpeg')
    expect(galleryDownloadName(item, blob)).toBe('dsh-import-jpeg-fallback.jpg')
  })
  it('surfaces rejected references rather than reporting successful import', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'profile-browser-b' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"registry-unavailable"}', { status: 409 })))
    await expect(syncVaultRefs(['a'.repeat(64)])).rejects.toThrow('409')
  })
})

describe('gallery original prefetch on hover', () => {
  it('pulls GIF originals up to 16 MB and other originals up to 4 MB, so a drag-out gets the real file', () => {
    const mb = 1024 * 1024
    expect(shouldPrefetchOriginal({ key: 'k', bytes: 3 * mb, mediaType: 'image/png' })).toBe(true)
    expect(shouldPrefetchOriginal({ key: 'k', bytes: 5 * mb, mediaType: 'image/png' })).toBe(false)
    expect(shouldPrefetchOriginal({ key: 'k', bytes: 5 * mb, mediaType: 'image/gif' })).toBe(true)
    expect(shouldPrefetchOriginal({ key: 'k', bytes: 20 * mb, mediaType: 'image/gif' })).toBe(false)
    expect(shouldPrefetchOriginal(undefined)).toBe(false)
  })
})

describe('gallery record persistence with an animated original', () => {
  const key = 'c'.repeat(64)
  const record: GalleryRecord = {
    id: 'sha256:gif-card', provider: 'openai-compat', prompt: 'a gif', model: 'relay',
    attachment: { attachmentId: 'sha256:gif-card' as never, mediaType: 'image/webp', bytes: 48 },
    original: { key, bytes: 500, mediaType: 'image/gif' },
  }
  const load = async () => { vi.resetModules(); return import('../src/client/gallery-media.js') }
  const bodyOf = (fetch: ReturnType<typeof vi.fn>) => JSON.parse(String((fetch.mock.calls[0] as [unknown, RequestInit])[1].body)) as unknown
  beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => 'profile-browser-b', setItem() {} }) })

  it('claims the original for this profile right after writing the record', async () => {
    const stores = installFakeIndexedDB()
    const fetch = vi.fn(async () => new Response('{"removed":0,"bytes":0}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const media = await load()
    expect(await media.persistGalleryRecord(record)).toBe(true)
    expect(stores.get('gallery_history')?.get(record.id)).toMatchObject({ original: record.original })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetch)).toEqual({ profileId: 'profile-browser-b', keys: [key] })
  })

  it('drops the reference only when the vault says the original is gone, and keeps it through an unusable registry or a transient failure', async () => {
    const stores = installFakeIndexedDB()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"original-missing"}', { status: 410 })))
    const gone = await load()
    expect(await gone.persistGalleryRecord(record)).toBe(true)
    expect(stores.get('gallery_history')?.get(record.id)?.original).toBeUndefined()
    // A registry no profile can write refuses every claim; the file is still there, so the record keeps pointing at it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"registry-unavailable"}', { status: 409 })))
    const refused = await load()
    expect(await refused.persistGalleryRecord({ ...record, id: 'sha256:gif-card-2' })).toBe(true)
    expect(stores.get('gallery_history')?.get('sha256:gif-card-2')).toMatchObject({ original: record.original })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const offline = await load()
    expect(await offline.persistGalleryRecord({ ...record, id: 'sha256:gif-card-3' })).toBe(true)
    expect(stores.get('gallery_history')?.get('sha256:gif-card-3')).toMatchObject({ original: record.original })
  })

  it('does not claim an original for a record the gallery has deleted', async () => {
    const stores = installFakeIndexedDB()
    stores.get('gallery_tombstones')?.set(record.id, { id: record.id, deletedAt: Date.now() })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const media = await load()
    expect(await media.persistGalleryRecord(record)).toBe(true)
    expect(stores.get('gallery_history')?.has(record.id)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
