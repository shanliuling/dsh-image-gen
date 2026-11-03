/**
 * Lightweight IndexedDB persistence layer for Image Generation Gallery.
 * Stores lightweight metadata indexes; image binaries remain managed by DSH Attachment service.
 * Supports tombstones to ensure deleted items are never resurrected when revisiting conversations.
 */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ImageProvider, StudioWatermark } from '../shared.js'

export interface GalleryItem {
  id: string
  attachment: ImageAttachmentRef
  prompt: string
  /** Generation provider, or 'import' for user-uploaded images. */
  provider: ImageProvider | 'import'
  channel?: string | undefined
  model: string
  createdAt: number
  aspectRatio?: string | undefined
  imageSize?: string | undefined
  resolution?: string | undefined
  generationQuality?: string | undefined
  watermark?: StudioWatermark | undefined
  output?: string | undefined
  /** Workflow seed reported by the ComfyUI provider. Optional so records written by older versions stay readable; the object store is schemaless, so no IndexedDB version bump is needed. */
  seed?: number | undefined
  /** Saved file path on workspace disk if savedTo was returned */
  savedTo?: string | undefined
  /** Whether this item is marked as favorite */
  isFavorite?: boolean | undefined
  /** Custom tags or collection markers */
  tags?: string[] | undefined
  /** Workspace filesystem path where the image was generated/saved */
  workspacePath?: string | undefined
  /** Workspace ID if known */
  workspaceId?: string | undefined
  /** Conversation session ID where the image was generated */
  sessionId?: string | undefined
  /** Attachment ids of the source images this image was edited from; used by the canvas to rebuild edit chains. Optional so records written by older versions stay readable. */
  sourceAttachmentIds?: string[] | undefined
  /** Raw pre-normalization bytes, present only when the attachment layer changed the import. */
  original?: { key: string; bytes: number; mediaType: ImageMediaType } | undefined
}

const DB_NAME = 'dsh_image_gen_db'
const DB_VERSION = 4
const STORE_NAME = 'gallery_history'
const TOMBSTONE_STORE = 'gallery_tombstones'
const FAV_PROMPT_STORE = 'favorite_prompts'
const FAV_FOLDER_STORE = 'favorite_folders'

// Thumbnails live in their own database: the cache is disposable, and keeping it
// out of the gallery DB avoids an irreversible version bump for existing users.
const THUMB_DB_NAME = 'dsh_image_gen_thumbs'
const THUMB_DB_VERSION = 1
const THUMB_STORE = 'thumbs'

/** A user-created folder grouping favorite prompts. */
export interface FavoriteFolder {
  id: string
  kind: 'image' | 'prompt'
  name: string
  addedAt: number
}

/** A prompt kept in the workbench favorites rail. */
export interface FavoritePrompt {
  /** Stable id derived from the trimmed text; identical prompts dedupe. */
  id: string
  text: string
  addedAt: number
  /** Owning folder id; absent entries are unfiled and appear under "all". */
  folderId?: string
}

let dbPromise: Promise<IDBDatabase> | null = null
let tombstonesCache: Set<string> | null = null

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
      if (!db.objectStoreNames.contains(TOMBSTONE_STORE)) {
        db.createObjectStore(TOMBSTONE_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(FAV_PROMPT_STORE)) {
        db.createObjectStore(FAV_PROMPT_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(FAV_FOLDER_STORE)) {
        db.createObjectStore(FAV_FOLDER_STORE, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // Close proactively when another tab requests an upgrade: holding this
      // older-version connection open blocks their upgrade (onblocked)
      // until every tab releases it.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }

    request.onerror = () => {
      // Drop the cached promise so the next call retries opening the database
      // instead of failing for the rest of the session (e.g. transient quota
      // or version-block states that a later attempt can recover from).
      dbPromise = null
      reject(request.error)
    }

    request.onblocked = () => {
      dbPromise = null
      reject(new Error('IndexedDB upgrade blocked. Close other open Studio tabs and retry.'))
    }
  })
  return dbPromise
}

async function loadTombstones(db: IDBDatabase): Promise<Set<string>> {
  if (tombstonesCache) return tombstonesCache
  return new Promise<Set<string>>((resolve) => {
    if (!db.objectStoreNames.contains(TOMBSTONE_STORE)) {
      tombstonesCache = new Set()
      resolve(tombstonesCache)
      return
    }
    try {
      const tx = db.transaction(TOMBSTONE_STORE, 'readonly')
      const store = tx.objectStore(TOMBSTONE_STORE)
      const req = store.getAllKeys()
      req.onsuccess = () => {
        tombstonesCache = new Set(req.result.map(String))
        resolve(tombstonesCache)
      }
      req.onerror = () => {
        tombstonesCache = new Set()
        resolve(tombstonesCache)
      }
    } catch {
      tombstonesCache = new Set()
      resolve(tombstonesCache)
    }
  })
}

/** Tombstones younger than this still protect multi-window deletes. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Drop tombstones older than the retention window so the table (and the set
 * consulted on every save) does not grow without bound. Returns the number of
 * removed entries.
 */
export async function pruneTombstones(maxAgeMs = TOMBSTONE_TTL_MS): Promise<number> {
  try {
    const db = await getDB()
    if (!db.objectStoreNames.contains(TOMBSTONE_STORE)) return 0
    const records = await new Promise<{ id?: string; deletedAt?: number }[]>((resolve, reject) => {
      const req = db.transaction(TOMBSTONE_STORE, 'readonly').objectStore(TOMBSTONE_STORE).getAll()
      req.onsuccess = () => resolve((req.result ?? []) as { id?: string; deletedAt?: number }[])
      req.onerror = () => reject(req.error)
    })
    const cutoff = Date.now() - maxAgeMs
    const doomed = records.filter(record => typeof record.deletedAt === 'number' && record.deletedAt < cutoff)
    if (doomed.length === 0) return 0
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(TOMBSTONE_STORE, 'readwrite')
      const store = tx.objectStore(TOMBSTONE_STORE)
      for (const record of doomed) store.delete(String(record.id))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    tombstonesCache = null
    return doomed.length
  } catch {
    return 0
  }
}

type GalleryListener = () => void
const listeners = new Set<GalleryListener>()

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.error('[dsh-image-gen] Gallery listener error:', err)
    }
  }
}

/**
 * Subscribe to gallery mutations (insert/delete/clear).
 */
export function subscribeGallery(listener: GalleryListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Save or update a gallery record by attachmentId.
 * Skipped if the item was previously deleted (tombstoned).
 * Preserves existing isFavorite, tags, and original createdAt on re-renders.
 * Returns false when the record was not persisted (e.g. IndexedDB unavailable)
 * so callers can surface the failure and let the user retry.
 */
export async function saveGalleryItem(
  item: Omit<GalleryItem, 'createdAt'> & { createdAt?: number }
): Promise<boolean> {
  try {
    const db = await getDB()
    const tombstones = await loadTombstones(db)
    if (tombstones.has(item.id)) {
      return true
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const getReq = store.get(item.id)

      getReq.onsuccess = () => {
        const existing = getReq.result as GalleryItem | undefined
        const fav = item.isFavorite !== undefined ? item.isFavorite : existing?.isFavorite
        const userTags = item.tags !== undefined ? item.tags : existing?.tags
        const savedPath = item.savedTo !== undefined ? item.savedTo : existing?.savedTo
        const record: GalleryItem = {
          ...existing,
          ...item,
          // Preserve original generation timestamp if already recorded
          createdAt: existing?.createdAt ?? item.createdAt ?? Date.now(),
          ...(fav !== undefined ? { isFavorite: fav } : {}),
          ...(userTags !== undefined ? { tags: userTags } : {}),
          ...(savedPath !== undefined ? { savedTo: savedPath } : {}),
        }
        const putReq = store.put(record)
        putReq.onsuccess = () => resolve()
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
    notifyListeners()
    return true
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to save gallery item to IndexedDB:', err)
    return false
  }
}

async function readGalleryItems(): Promise<GalleryItem[]> {
  const db = await getDB()
  return await new Promise<GalleryItem[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('createdAt')
    const req = index.openCursor(null, 'prev') // newest first
    const items: GalleryItem[] = []

    req.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
      if (cursor) {
        items.push(cursor.value as GalleryItem)
        cursor.continue()
      } else {
        resolve(items)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Retrieve all gallery records sorted by createdAt descending.
 */
export async function getGalleryItems(): Promise<GalleryItem[]> {
  try {
    return await readGalleryItems()
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to read gallery items from IndexedDB:', err)
    return []
  }
}

/**
 * Like getGalleryItems, but rejects when IndexedDB is unavailable. Maintenance
 * callers must not treat a read failure as an empty gallery (that would make
 * vault gc delete every original).
 */
export async function getGalleryItemsStrict(): Promise<GalleryItem[]> {
  return readGalleryItems()
}

/** Width, in CSS pixels, of the thumbnail cached for the grid. */
/** Byte budget for the disposable thumbnail cache; oldest entries go first. */
export const GALLERY_THUMB_MAX_BYTES = 256 * 1024 * 1024

/** Cached thumbnails unused for this long are dropped on the next sweep. */
export const GALLERY_THUMB_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export const GALLERY_THUMB_WIDTH = 320

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
async function deleteGalleryThumbs(ids: string[]): Promise<void> {
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
async function clearGalleryThumbs(): Promise<void> {
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

/**
 * Toggle favorite status of a gallery item.
 * Returns the new favorite status (true if favorited, false if unfavorited).
 */
export async function toggleFavoriteGalleryItem(id: string): Promise<boolean> {
  try {
    const db = await getDB()
    const newStatus = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const getReq = store.get(id)

      getReq.onsuccess = () => {
        const item = getReq.result as GalleryItem | undefined
        if (!item) {
          resolve(false)
          return
        }
        const nextFavorite = !item.isFavorite
        item.isFavorite = nextFavorite
        const putReq = store.put(item)
        putReq.onsuccess = () => resolve(nextFavorite)
        putReq.onerror = () => reject(putReq.error)
      }
      getReq.onerror = () => reject(getReq.error)
    })
    notifyListeners()
    return newStatus
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to toggle favorite item in IndexedDB:', err)
    return false
  }
}

/**
 * Resolve the attachment ids behind gallery record ids. Imported records carry a
 * synthetic `import-<attachmentId>-<uuid>` id, so the record id is not always
 * the thumbnail key.
 */
async function attachmentIdsFor(db: IDBDatabase, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  return new Promise<string[]>((resolve) => {
    const found: string[] = []
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      for (const id of ids) {
        const req = store.get(id)
        req.onsuccess = () => {
          const item = req.result as GalleryItem | undefined
          const attachmentId = item?.attachment?.attachmentId
          if (typeof attachmentId === 'string') found.push(attachmentId)
        }
      }
      tx.oncomplete = () => resolve(found)
      tx.onerror = () => resolve(found)
    } catch {
      resolve(found)
    }
  })
}

/**
 * Delete a single gallery record by ID and record a tombstone.
 */
export async function deleteGalleryItem(id: string): Promise<void> {
  const db = await getDB()
  const tombstones = await loadTombstones(db)
  const attachmentIds = await attachmentIdsFor(db, [id])
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const tombstoneStore = tx.objectStore(TOMBSTONE_STORE)
    store.delete(id)
    tombstoneStore.put({ id, deletedAt: Date.now() })
    tx.oncomplete = () => {
      tombstones.add(id)
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
  void deleteGalleryThumbs([id, ...attachmentIds])
  notifyListeners()
}

/**
 * Bulk delete multiple gallery records by IDs and record tombstones in a single transaction.
 */
export async function bulkDeleteGalleryItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getDB()
  const tombstones = await loadTombstones(db)
  const attachmentIds = await attachmentIdsFor(db, ids)
  const now = Date.now()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const tombstoneStore = tx.objectStore(TOMBSTONE_STORE)
    for (const id of ids) {
      store.delete(id)
      tombstoneStore.put({ id, deletedAt: now })
    }
    tx.oncomplete = () => {
      for (const id of ids) {
        tombstones.add(id)
      }
      resolve()
    }
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
  void deleteGalleryThumbs([...ids, ...attachmentIds])
  notifyListeners()
}

/**
 * Bulk update favorite status for multiple gallery records in a single transaction.
 */
export async function bulkSetFavoriteGalleryItems(ids: string[], isFavorite: boolean): Promise<void> {
  if (ids.length === 0) return
  const db = await getDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const id of ids) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const item = getReq.result as GalleryItem | undefined
        if (item && item.isFavorite !== isFavorite) {
          item.isFavorite = isFavorite
          store.put(item)
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
  notifyListeners()
}

/**
 * Clear all gallery records and reset tombstones.
 */
export async function clearGallery(): Promise<void> {
  try {
    const db = await getDB()
    if (tombstonesCache) tombstonesCache.clear()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME, TOMBSTONE_STORE], 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const tombstoneStore = tx.objectStore(TOMBSTONE_STORE)
      store.clear()
      tombstoneStore.clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    void clearGalleryThumbs()
    notifyListeners()
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to clear gallery in IndexedDB:', err)
  }
}

/**
 * Standardize path format across Windows and POSIX (lowercase, forward slashes, no trailing slash).
 */
export function normalizeWorkspacePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/**
 * Determine if a gallery item belongs to the given workspace context.
 * Compares workspaceId, sessionId membership, workspacePath, and savedTo file path prefix.
 */
export function isItemInWorkspace(
  item: GalleryItem,
  workspace?: {
    workspaceId?: string | undefined
    path?: string | undefined
    sessionIds?: readonly string[] | undefined
  } | null,
): boolean {
  if (!workspace || (!workspace.workspaceId && !workspace.path && (!workspace.sessionIds || workspace.sessionIds.length === 0))) {
    return true
  }

  // Items with no workspace attribution at all (generated before the studio
  // learned the active workspace) belong to every view; a workspace filter
  // must not hide them from the gallery or favorites tabs.
  if (!item.workspaceId && !item.sessionId && !item.workspacePath && !item.savedTo) {
    return true
  }

  // 1. Direct workspaceId match
  if (item.workspaceId && workspace.workspaceId && item.workspaceId === workspace.workspaceId) {
    return true
  }

  // 2. SessionId membership match
  if (item.sessionId && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(item.sessionId)) {
    return true
  }

  // 3. Direct workspacePath match
  if (item.workspacePath && workspace.path) {
    if (normalizeWorkspacePath(item.workspacePath) === normalizeWorkspacePath(workspace.path)) {
      return true
    }
  }

  // 4. savedTo disk file prefix match (for historical items or files written to the workspace)
  if (item.savedTo && workspace.path) {
    const normSaved = normalizeWorkspacePath(item.savedTo)
    const normWs = normalizeWorkspacePath(workspace.path)
    if (normSaved === normWs || normSaved.startsWith(normWs + '/')) {
      return true
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Workbench favorites: reusable reference images and prompts. Same database,
// separate stores; a dedicated listener set keeps favorite mutations from
// re-reading the (potentially large) gallery history.
// ---------------------------------------------------------------------------

const favoriteListeners = new Set<() => void>()

function notifyFavorites(): void {
  for (const listener of favoriteListeners) {
    try {
      listener()
    } catch (err) {
      console.error('[dsh-image-gen] Favorites listener error:', err)
    }
  }
}

/** Subscribe to favorites mutations (insert/delete). */
export function subscribeFavorites(listener: () => void): () => void {
  favoriteListeners.add(listener)
  return () => {
    favoriteListeners.delete(listener)
  }
}

/** Stable base36 id for a favorite prompt; identical trimmed text dedupes. */
function promptIdOf(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return `p${(hash >>> 0).toString(36)}-${text.length.toString(36)}`
}

/**
 * Collision-free prompt id. Distinct texts can share the djb2 hash and the
 * length, which would silently overwrite an unrelated saved prompt; suffix
 * until the id is free or already owned by the same text.
 */
async function uniquePromptId(db: IDBDatabase, text: string): Promise<string> {
  const rows = await readAll<FavoritePrompt>(db, FAV_PROMPT_STORE)
  const byId = new Map(rows.map(row => [row.id, row]))
  const base = promptIdOf(text)
  let candidate = base
  let suffix = 1
  while (byId.has(candidate) && byId.get(candidate)?.text !== text) {
    suffix++
    candidate = `${base}-${suffix}`
  }
  return candidate
}

function readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor()
    const rows: T[] = []
    req.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
      if (cursor) {
        rows.push(cursor.value as T)
        cursor.continue()
      } else {
        resolve(rows)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Keep one prompt in the favorites rail; identical trimmed text overwrites
 * (one record per distinct prompt).
 * @returns false when the write failed.
 */
export async function saveFavoritePrompt(text: string): Promise<boolean> {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  try {
    const db = await getDB()
    const id = await uniquePromptId(db, trimmed)
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(FAV_PROMPT_STORE, 'readwrite').objectStore(FAV_PROMPT_STORE).put({
        id,
        text: trimmed,
        addedAt: Date.now(),
      })
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    notifyFavorites()
    return true
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to save favorite prompt:', err)
    return false
  }
}

/** Prompt favorites, newest first. */
export async function getFavoritePrompts(): Promise<FavoritePrompt[]> {
  try {
    const db = await getDB()
    const rows = await readAll<FavoritePrompt>(db, FAV_PROMPT_STORE)
    return rows.sort((a, b) => b.addedAt - a.addedAt)
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to read favorite prompts:', err)
    return []
  }
}

/** Drop one prompt favorite. */
export async function deleteFavoritePrompt(id: string): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(FAV_PROMPT_STORE, 'readwrite').objectStore(FAV_PROMPT_STORE).delete(id)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    notifyFavorites()
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to delete favorite prompt:', err)
  }
}

function folderIdOf(kind: 'image' | 'prompt', name: string): string {
  return `f-${kind}-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${name.length.toString(36)}`
}

/** Create a favorites folder; returns null when the name is empty or already used for the kind. */
export async function addFavoriteFolder(kind: 'image' | 'prompt', name: string): Promise<FavoriteFolder | null> {
  const trimmed = name.trim()
  if (trimmed === '') return null
  try {
    const db = await getDB()
    const existing = await readAll<FavoriteFolder>(db, FAV_FOLDER_STORE)
    if (existing.some(folder => folder.kind === kind && folder.name === trimmed)) return null
    const folder: FavoriteFolder = { id: folderIdOf(kind, trimmed), kind, name: trimmed, addedAt: Date.now() }
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(FAV_FOLDER_STORE, 'readwrite').objectStore(FAV_FOLDER_STORE).put(folder)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    notifyFavorites()
    return folder
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to add favorite folder:', err)
    return null
  }
}

/** List all favorite folders. */
export async function getFavoriteFolders(): Promise<FavoriteFolder[]> {
  try {
    const db = await getDB()
    const rows = await readAll<FavoriteFolder>(db, FAV_FOLDER_STORE)
    return rows.sort((a, b) => a.addedAt - b.addedAt)
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to read favorite folders:', err)
    return []
  }
}

/** Delete a folder; member favorites survive and become unfiled. */
export async function deleteFavoriteFolder(id: string): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FAV_PROMPT_STORE, 'readwrite')
      const req = tx.objectStore(FAV_PROMPT_STORE).openCursor()
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          const row = cursor.value as { folderId?: string }
          if (row.folderId === id) {
            delete row.folderId
            cursor.update(row)
          }
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(FAV_FOLDER_STORE, 'readwrite').objectStore(FAV_FOLDER_STORE).delete(id)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    notifyFavorites()
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to delete favorite folder:', err)
  }
}

async function moveFavorite(storeName: string, id: string, folderId: string | undefined): Promise<boolean> {
  try {
    const db = await getDB()
    const ok = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      const req = tx.objectStore(storeName).get(id)
      req.onsuccess = () => {
        const row = req.result as { folderId?: string } | undefined
        if (row === undefined) { resolve(false); return }
        if (folderId === undefined) delete row.folderId
        else row.folderId = folderId
        tx.objectStore(storeName).put(row)
        resolve(true)
      }
      tx.onerror = () => reject(tx.error)
    })
    if (ok) notifyFavorites()
    return ok
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to move favorite:', err)
    return false
  }
}

/** File a favorite prompt into a folder (undefined unfiles it). */
export function moveFavoritePrompt(id: string, folderId: string | undefined): Promise<boolean> {
  return moveFavorite(FAV_PROMPT_STORE, id, folderId)
}

/** Rewrite a favorite prompt's text in place, keeping its id stable. */
export async function updateFavoritePrompt(id: string, text: string): Promise<boolean> {
  const trimmed = text.trim()
  if (trimmed === '') return false
  try {
    const db = await getDB()
    const ok = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(FAV_PROMPT_STORE, 'readwrite')
      const req = tx.objectStore(FAV_PROMPT_STORE).get(id)
      req.onsuccess = () => {
        const row = req.result as FavoritePrompt | undefined
        if (row === undefined) { resolve(false); return }
        row.text = trimmed
        tx.objectStore(FAV_PROMPT_STORE).put(row)
        resolve(true)
      }
      tx.onerror = () => reject(tx.error)
    })
    if (ok) notifyFavorites()
    return ok
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to update favorite prompt:', err)
    return false
  }
}
