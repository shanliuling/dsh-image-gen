import type { GalleryItem } from './gallery-store.js'
import { VAULT_DELETE_ROUTE, VAULT_REFS_ROUTE, ZIP_ROUTE, vaultUrlFor } from '../shared.js'
import { fetchAttachmentBlob } from './image-cache.js'

/** Hover prefetch stops pulling raw originals above this size; drag-out then uses the attachment. */
export const GALLERY_PREFETCH_ORIGINAL_MAX_BYTES = 4 * 1024 * 1024

/** Drop vault files the gallery no longer references; failures are non-fatal. */
const VAULT_PROFILE_KEY = 'dsh-ig-vault-profile-v1'

/** Stable per-browser-profile identity; the vault registry unions all profiles. */
export function vaultProfileId(): string {
  try {
    const existing = localStorage.getItem(VAULT_PROFILE_KEY)
    if (existing !== null && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing
    const created = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem(VAULT_PROFILE_KEY, created)
    return created
  } catch {
    return 'profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
}

/** Sync this profile's references; the server never deletes originals here. */
export function syncVaultRefs(keys: string[]): void {
  void fetch(VAULT_REFS_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId: vaultProfileId(), keys }),
  }).catch(() => undefined)
}

/** Manual gallery deletion: remove originals only after the server checks every profile. */
export function deleteVaultOriginals(deleteKeys: string[], remainingKeys: string[]): void {
  if (deleteKeys.length === 0) return
  void fetch(VAULT_DELETE_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: vaultProfileId(),
      keys: remainingKeys,
      deleteKeys: Array.from(new Set(deleteKeys)),
      confirm: true,
    }),
  }).catch(() => undefined)
}

export function vaultKeysOf(items: readonly GalleryItem[]): string[] {
  return items.flatMap(item => (item.original === undefined ? [] : [item.original.key]))
}

/** Full bytes for copy/download/drag: raw vault first, normalized attachment fallback. */
export async function fetchGalleryItemBlob(item: GalleryItem): Promise<Blob> {
  if (item.original !== undefined) {
    try {
      const response = await fetch(vaultUrlFor(item.original.key, item.original.mediaType), { credentials: 'same-origin' })
      if (response.ok) return await response.blob()
    } catch {
      // Fall back to the attachment copy below.
    }
  }
  return fetchAttachmentBlob(item.attachment)
}

export interface GalleryStorageStats {
  attachments: { count: number; bytes: number }
  requestImages: { count: number; bytes: number }
  thumbs: { count: number; bytes: number }
  orphans: { count: number; bytes: number; ids: string[] }
  scannedAt: number
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 ** 3) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 ** 3)).toFixed(2) + ' GB'
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** Desktop pickers can omit `File.type` for UNC/temp paths; fall back to the extension. */
export function imageMediaTypeOf(file: File): string | undefined {
  if (file.type.startsWith('image/')) return file.type
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  return IMAGE_MIME_BY_EXTENSION[extension]
}

let zipRouteProbe: Promise<boolean> | undefined

/** Probe once whether this host can stream ZIP exports (older hosts 404 the route). */
export function canUseServerZip(): Promise<boolean> {
  zipRouteProbe ??= fetch(ZIP_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  })
    .then(response => response.status !== 404)
    .catch(() => false)
  return zipRouteProbe
}

export function extensionFor(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

/**
 * Ask the host to stream the archive through a hidden form post.
 * A real form navigation would replace the SPA, so the response lands in an
 * off-screen iframe and the browser download manager owns the transfer.
 */
export function postZipDownload(items: GalleryItem[], token: string): void {
  const payload = items.map(item => ({
    name: `dsh-${item.provider}-${item.id.slice(0, 8)}.${extensionFor(item.original?.mediaType ?? item.attachment.mediaType)}`,
    attachment: item.attachment,
    ...(item.original === undefined ? {} : { originalKey: item.original.key, originalMediaType: item.original.mediaType }),
  }))
  const sink = document.createElement('iframe')
  // Unique target per export: a reused name would make a second form submit
  // into the first (possibly still downloading) frame.
  sink.name = 'dsh-ig-zip-sink-' + String(Date.now())
  sink.hidden = true
  document.body.appendChild(sink)
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = ZIP_ROUTE
  form.target = sink.name
  form.style.display = 'none'
  const field = document.createElement('input')
  field.type = 'hidden'
  field.name = 'items'
  field.value = JSON.stringify(payload)
  form.appendChild(field)
  if (token !== '') {
    const tokenField = document.createElement('input')
    tokenField.type = 'hidden'
    tokenField.name = 'token'
    tokenField.value = token
    form.appendChild(tokenField)
  }
  document.body.appendChild(form)
  form.submit()
  form.remove()
  // The download manager owns the transfer once the attachment headers
  // arrive; keep the frame well past the slowest large export instead of the
  // old 60 s timer, which could cancel a still-streaming archive.
  window.setTimeout(() => sink.remove(), 30 * 60_000)
}

