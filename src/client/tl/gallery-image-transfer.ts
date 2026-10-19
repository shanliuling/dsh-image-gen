import type { GalleryItem } from '../gallery-store.js'
import type { TlLandingItem } from './tl-canvas-bridge.js'
import { CANVAS_MAX_PROMPT_CHARS } from '../../shared.js'

export const GALLERY_IMAGE_MIME = 'application/x-dsh-image-gen-gallery-image'
const EXTENSIONS = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']])
type DragStart = { dataTransfer: DataTransfer | null; preventDefault(): void }

export function galleryLanding(item: GalleryItem): TlLandingItem {
  return { galleryId: item.id, attachment: item.attachment, prompt: item.prompt.slice(0, CANVAS_MAX_PROMPT_CHARS), provider: item.provider, model: item.model }
}

/** A real file also works when the host drops custom MIME data between containers. */
export function startGalleryImageDrag(event: DragStart, item: GalleryItem, blob: Blob | null | undefined): boolean {
  const transfer = event.dataTransfer
  const mediaType = blob?.type || item.attachment.mediaType
  const extension = EXTENSIONS.get(mediaType)
  if (!transfer || !blob?.size || !extension) { event.preventDefault(); return false }
  try {
    const name = item.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'image'
    const file = new File([blob], `${name}.${extension}`, { type: mediaType })
    // Remove the browser's URL-only payload (and any native file) before adding ours.
    transfer.items.clear()
    if (transfer.items.add(file) === null) throw new Error('Drag file unavailable')
    transfer.effectAllowed = 'copy'
    // A host may reject custom MIME while still accepting the actual file.
    try { transfer.setData(GALLERY_IMAGE_MIME, JSON.stringify(galleryLanding(item))) } catch { /* File fallback. */ }
    return true
  } catch {
    event.preventDefault()
    return false
  }
}

export function readGalleryImageDrop(transfer: Pick<DataTransfer, 'getData'>): TlLandingItem | undefined {
  try {
    const raw = transfer.getData(GALLERY_IMAGE_MIME)
    if (!raw || raw.length > 64_000) return undefined
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !text(value.galleryId) || !record(value.attachment)) return undefined
    const a = value.attachment
    if (!text(a.attachmentId) || typeof a.mediaType !== 'string' || !EXTENSIONS.has(a.mediaType)
      || !dimension(a.bytes) || !dimension(a.width) || !dimension(a.height)
      || (a.name !== undefined && (typeof a.name !== 'string' || a.name.length > 1024))) return undefined
    if (typeof value.prompt !== 'string' || value.prompt.length > CANVAS_MAX_PROMPT_CHARS
      || typeof value.provider !== 'string' || !text(value.provider)
      || typeof value.model !== 'string' || value.model.length > 1024) return undefined
    return {
      galleryId: value.galleryId,
      attachment: {
        attachmentId: a.attachmentId as GalleryItem['attachment']['attachmentId'], mediaType: a.mediaType as GalleryItem['attachment']['mediaType'],
        bytes: a.bytes, width: a.width, height: a.height,
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
      },
      prompt: value.prompt, provider: value.provider, model: value.model,
    }
  } catch { return undefined }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024 }
function dimension(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
