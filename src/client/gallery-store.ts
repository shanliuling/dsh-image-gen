/**
 * Lightweight IndexedDB persistence layer for Image Generation Gallery.
 * Stores lightweight metadata indexes; image binaries remain managed by DSH Attachment service.
 * Supports tombstones to ensure deleted items are never resurrected when revisiting conversations.
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageProvider } from '../shared.js'

export interface GalleryItem {
  id: string
  attachment: ImageAttachmentRef
  prompt: string
  provider: ImageProvider
  model: string
  createdAt: number
  aspectRatio?: string | undefined
  imageSize?: string | undefined
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
}

const DB_NAME = 'dsh_image_gen_db'
const DB_VERSION = 2
const STORE_NAME = 'gallery_history'
const TOMBSTONE_STORE = 'gallery_tombstones'

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
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error)
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
 */
export async function saveGalleryItem(
  item: Omit<GalleryItem, 'createdAt'> & { createdAt?: number }
): Promise<void> {
  try {
    const db = await getDB()
    const tombstones = await loadTombstones(db)
    if (tombstones.has(item.id)) {
      return
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
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to save gallery item to IndexedDB:', err)
  }
}

/**
 * Retrieve all gallery records sorted by createdAt descending.
 */
export async function getGalleryItems(): Promise<GalleryItem[]> {
  try {
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
  } catch (err) {
    console.warn('[dsh-image-gen] Failed to read gallery items from IndexedDB:', err)
    return []
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
 * Delete a single gallery record by ID and record a tombstone.
 */
export async function deleteGalleryItem(id: string): Promise<void> {
  const db = await getDB()
  const tombstones = await loadTombstones(db)
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
  notifyListeners()
}

/**
 * Bulk delete multiple gallery records by IDs and record tombstones in a single transaction.
 */
export async function bulkDeleteGalleryItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getDB()
  const tombstones = await loadTombstones(db)
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
