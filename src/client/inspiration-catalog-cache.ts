/** Keep a manually refreshed public catalog available across plugin restarts. */
import type { InspirationCatalog } from '../inspiration.js'

const DB_NAME = 'dsh-image-gen-inspiration'
const STORE = 'catalog'
const IMAGE_STORE = 'images'
const KEY = 'latest'

interface CachedCatalog {
  id: typeof KEY
  catalog: InspirationCatalog
  storedAt: number
}

export async function loadCachedInspirationCatalog(): Promise<InspirationCatalog | undefined> {
  const db = await openDatabase()
  if (db === undefined) return undefined
  try {
    return await new Promise(resolve => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
      request.onsuccess = () => {
        const record = request.result as CachedCatalog | undefined
        resolve(isCatalog(record?.catalog) ? record.catalog : undefined)
      }
      request.onerror = () => resolve(undefined)
    })
  } finally {
    db.close()
  }
}

export async function saveCachedInspirationCatalog(catalog: InspirationCatalog): Promise<void> {
  if (!isCatalog(catalog)) return
  const db = await openDatabase()
  if (db === undefined) return
  try {
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ id: KEY, catalog, storedAt: Date.now() } satisfies CachedCatalog)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } finally {
    db.close()
  }
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined)
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 2)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(IMAGE_STORE)) {
          const images = db.createObjectStore(IMAGE_STORE, { keyPath: 'key' })
          images.createIndex('accessedAt', 'accessedAt')
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

function isCatalog(value: unknown): value is InspirationCatalog {
  if (typeof value !== 'object' || value === null || (value as { schemaVersion?: unknown }).schemaVersion !== 1) return false
  const sources = (value as { sources?: unknown }).sources
  return Array.isArray(sources) && sources.length > 0 && sources.every(source => typeof source === 'object' && source !== null && Array.isArray((source as { cases?: unknown }).cases))
}
