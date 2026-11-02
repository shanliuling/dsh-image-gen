import type { GalleryItem } from './gallery-store.js'

function sameStringArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Content addressing makes these five fields the complete attachment identity. */
export function sameAttachment(a: GalleryItem['attachment'], b: GalleryItem['attachment']): boolean {
  return a.attachmentId === b.attachmentId
    && a.mediaType === b.mediaType
    && a.bytes === b.bytes
    && a.width === b.width
    && a.height === b.height
}

/**
 * Field-by-field comparison for one gallery record. Keep this list in sync with
 * GalleryItem: a field added there but missing here would silently keep the old
 * object and show stale data after a reload.
 */
export function sameGalleryItem(a: GalleryItem, b: GalleryItem): boolean {
  return a.id === b.id
    && sameAttachment(a.attachment, b.attachment)
    && a.prompt === b.prompt
    && a.provider === b.provider
    && a.channel === b.channel
    && a.model === b.model
    && a.createdAt === b.createdAt
    && a.aspectRatio === b.aspectRatio
    && a.imageSize === b.imageSize
    && a.resolution === b.resolution
    && a.generationQuality === b.generationQuality
    && a.watermark === b.watermark
    && a.output === b.output
    && a.seed === b.seed
    && a.savedTo === b.savedTo
    && Boolean(a.isFavorite) === Boolean(b.isFavorite)
    && sameStringArray(a.tags, b.tags)
    && a.workspacePath === b.workspacePath
    && a.workspaceId === b.workspaceId
    && a.sessionId === b.sessionId
    && sameStringArray(a.sourceAttachmentIds, b.sourceAttachmentIds)
}

/**
 * Reuse the previous object for every unchanged record so memoized cards keep
 * their identity after a full-table reload; only changed records get new
 * objects. The order always follows the incoming list.
 */
export function mergeGalleryItems(prev: readonly GalleryItem[], next: readonly GalleryItem[]): GalleryItem[] {
  if (prev.length === 0) return [...next]
  const byId = new Map<string, GalleryItem>()
  for (const item of prev) byId.set(item.id, item)
  return next.map((item) => {
    const previous = byId.get(item.id)
    return previous !== undefined && sameGalleryItem(previous, item) ? previous : item
  })
}
