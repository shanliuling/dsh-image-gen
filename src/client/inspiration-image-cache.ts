/** Persistent, bounded browser cache for publicly proxied inspiration images. */
import { INSPIRATION_ROUTE } from '../shared.js'

const DB_NAME = 'dsh-image-gen-inspiration'
const STORE = 'images'
const CATALOG_STORE = 'catalog'
const MAX_ENTRIES = 120
const MAX_BYTES = 180 * 1024 * 1024

interface CachedImage {
  key: string
  blob: Blob
  bytes: number
  accessedAt: number
}

const pending = new Map<string, Promise<Blob>>()

export function fetchInspirationImage(sourceId: string, caseId: string): Promise<Blob> {
  const key = `${sourceId}:${caseId}`
  const existing = pending.get(key)
  if (existing !== undefined) return existing
  const task = getCached(key).then(async cached => {
    if (cached !== undefined) return cached
    const response = await fetch(`${INSPIRATION_ROUTE}/image/${encodeURIComponent(sourceId)}/${encodeURIComponent(caseId)}`, {
      credentials: 'same-origin',
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg' },
    })
    if (!response.ok) throw new Error(`灵感图片读取失败 (${String(response.status)})`)
    const blob = await response.blob()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('灵感图片格式不受支持')
    void putCached(key, blob)
    return blob
  }).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined)
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 2)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' })
          store.createIndex('accessedAt', 'accessedAt')
        }
        if (!db.objectStoreNames.contains(CATALOG_STORE)) db.createObjectStore(CATALOG_STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

async function getCached(key: string): Promise<Blob | undefined> {
  const db = await openDatabase()
  if (db === undefined) return undefined
  try {
    return await new Promise(resolve => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const request = store.get(key)
      request.onsuccess = () => {
        const entry = request.result as CachedImage | undefined
        if (entry === undefined || !(entry.blob instanceof Blob)) return resolve(undefined)
        entry.accessedAt = Date.now()
        store.put(entry)
        resolve(entry.blob)
      }
      request.onerror = () => resolve(undefined)
    })
  } finally {
    db.close()
  }
}

async function putCached(key: string, blob: Blob): Promise<void> {
  const db = await openDatabase()
  if (db === undefined) return
  try {
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      store.put({ key, blob, bytes: blob.size, accessedAt: Date.now() } satisfies CachedImage)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
    await trimCache(db)
  } finally {
    db.close()
  }
}

async function trimCache(db: IDBDatabase): Promise<void> {
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const items: CachedImage[] = []
    const cursor = store.openCursor()
    cursor.onsuccess = () => {
      const result = cursor.result
      if (result !== null) {
        items.push(result.value as CachedImage)
        result.continue()
        return
      }
      items.sort((a, b) => a.accessedAt - b.accessedAt)
      let count = items.length
      let bytes = items.reduce((total, item) => total + Math.max(0, item.bytes), 0)
      for (const item of items) {
        if (count <= MAX_ENTRIES && bytes <= MAX_BYTES) break
        store.delete(item.key)
        count -= 1
        bytes -= Math.max(0, item.bytes)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}
