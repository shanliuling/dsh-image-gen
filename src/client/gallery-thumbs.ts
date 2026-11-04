/** Disposable IndexedDB cache for grid thumbnails. */
export const GALLERY_THUMB_MAX_BYTES = 256 * 1024 * 1024
export const GALLERY_THUMB_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
export const GALLERY_THUMB_WIDTH = 320

const THUMB_DB_NAME = 'dsh_image_gen_thumbs'
const THUMB_DB_VERSION = 1
const THUMB_STORE = 'thumbs'

/** Cache key for one attachment thumbnail. */
export function galleryThumbKey(attachmentId: string, width = GALLERY_THUMB_WIDTH): string {
  return `${attachmentId}@${width}`
}

let thumbDbPromise: Promise<IDBDatabase> | null = null

function getThumbDB(): Promise<IDBDatabase> {
  if (thumbDbPromise) return thumbDbPromise
  thumbDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'))
      return
    }
    const request = indexedDB.open(THUMB_DB_NAME, THUMB_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(THUMB_STORE)) {
        db.createObjectStore(THUMB_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        thumbDbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      thumbDbPromise = null
      reject(request.error)
    }
  })
  return thumbDbPromise
}

/** Read a cached thumbnail; resolves undefined when it was never generated. */
export async function getGalleryThumb(key: string): Promise<Blob | undefined> {
  try {
    const db = await getThumbDB()
    return await new Promise<Blob | undefined>((resolve) => {
      const req = db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE).get(key)
      req.onsuccess = () => resolve((req.result as { blob?: Blob } | undefined)?.blob)
      req.onerror = () => resolve(undefined)
    })
  } catch {
    return undefined
  }
}

/** Persist a generated thumbnail. Failures are non-fatal: the grid falls back to the original. */
export async function putGalleryThumb(key: string, blob: Blob): Promise<void> {
  try {
    const db = await getThumbDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE, 'readwrite')
      tx.objectStore(THUMB_STORE).put({ key, blob, bytes: blob.size, createdAt: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to cache gallery thumbnail:', err)
  }
}

/** Aggregate size of the disposable thumbnail cache (storage panel). */
export async function getGalleryThumbStats(): Promise<{ count: number; bytes: number }> {
  try {
    const db = await getThumbDB()
    const records = await new Promise<{ bytes?: number }[]>((resolve, reject) => {
      const req = db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE).getAll()
      req.onsuccess = () => resolve((req.result ?? []) as { bytes?: number }[])
      req.onerror = () => reject(req.error)
    })
    return { count: records.length, bytes: records.reduce((sum, record) => sum + (typeof record.bytes === 'number' ? record.bytes : 0), 0) }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

/** Drop cached thumbnails for deleted records. Best-effort: the cache is disposable. */
export async function deleteGalleryThumbs(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    const db = await getThumbDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE, 'readwrite')
      const store = tx.objectStore(THUMB_STORE)
      for (const id of ids) store.delete(galleryThumbKey(id))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // A stale thumbnail is harmless; it is evicted with the rest of the cache.
  }
}

/**
 * Drop cached thumbnails whose attachment is no longer in the gallery.
 * Returns how many entries were removed.
 */
export async function pruneGalleryThumbs(
  validAttachmentIds: Iterable<string>,
  maxBytes = GALLERY_THUMB_MAX_BYTES,
  maxAgeMs = GALLERY_THUMB_MAX_AGE_MS,
): Promise<number> {
  try {
    const db = await getThumbDB()
    const valid = new Set(Array.from(validAttachmentIds, String))
    const keys = await new Promise<string[]>((resolve, reject) => {
      const req = db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE).getAllKeys()
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String))
      req.onerror = () => reject(req.error)
    })
    const stale = keys.filter((key) => {
      const at = key.lastIndexOf('@')
      return !valid.has(at > 0 ? key.slice(0, at) : key)
    })
    let removed = 0
    if (stale.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(THUMB_STORE, 'readwrite')
        const store = tx.objectStore(THUMB_STORE)
        for (const key of stale) store.delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      removed += stale.length
    }

    // Enforce the byte budget oldest-first so the disposable cache cannot grow
    // without bound on libraries with tens of thousands of images.
    const records = await new Promise<{ key: string; bytes?: number; createdAt?: number }[]>((resolve, reject) => {
      const req = db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE).getAll()
      req.onsuccess = () => resolve((req.result ?? []) as { key: string; bytes?: number; createdAt?: number }[])
      req.onerror = () => reject(req.error)
    })
    // Age out thumbnails nobody has asked for in a while; this keeps the
    // disposable store from holding a large library forever even when it fits
    // under the byte budget. maxAgeMs <= 0 disables the age pass.
    const cutoff = Date.now() - maxAgeMs
    const expired = maxAgeMs > 0
      ? records.filter(record => typeof record.createdAt === 'number' && record.createdAt < cutoff)
      : []
    if (expired.length > 0) {
      const expiredKeys = new Set(expired.map(record => String(record.key)))
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(THUMB_STORE, 'readwrite')
        const store = tx.objectStore(THUMB_STORE)
        for (const key of expiredKeys) store.delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      removed += expired.length
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (expiredKeys.has(String(records[i]?.key))) records.splice(i, 1)
      }
    }

    let total = records.reduce((sum, record) => sum + (typeof record.bytes === 'number' ? record.bytes : 0), 0)
    if (total > maxBytes) {
      const oldestFirst = [...records].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      const doomed: string[] = []
      for (const record of oldestFirst) {
        if (total <= maxBytes) break
        doomed.push(String(record.key))
        total -= typeof record.bytes === 'number' ? record.bytes : 0
      }
      if (doomed.length > 0) {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(THUMB_STORE, 'readwrite')
          const store = tx.objectStore(THUMB_STORE)
          for (const key of doomed) store.delete(key)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
        removed += doomed.length
      }
    }
    return removed
  } catch {
    return 0
  }
}

/** Drop every cached thumbnail (used when the gallery is cleared). */
export async function clearGalleryThumbs(): Promise<void> {
  try {
    const db = await getThumbDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE, 'readwrite')
      tx.objectStore(THUMB_STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // The cache is disposable.
  }
}
