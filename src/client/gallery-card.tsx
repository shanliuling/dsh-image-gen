import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Check, Copy, Download, FileText, Heart, Trash2 } from 'lucide-react'
import type { GalleryItem } from './gallery-store.js'
import {
  galleryThumbKey,
  getGalleryThumb,
  putGalleryThumb,
  toggleFavoriteGalleryItem,
  GALLERY_THUMB_WIDTH,
} from './gallery-store.js'
import { useInView } from './studio-helpers.js'
import { thumbUrlFor } from '../shared.js'
import { fetchAttachmentBlob } from './image-cache.js'
import { copyImageBlob, createImageThumbnail, downloadBlobUrl } from './browser-image-utils.js'
import { startGalleryImageDrag } from './tl/gallery-image-transfer.js'
import { GalleryCanvasButton } from './tl/gallery-canvas-button.js'
import type { DictKey } from './gallery-i18n.js'
import { fetchGalleryItemBlob, galleryDownloadName, shouldPrefetchOriginal } from './gallery-media.js'
import { formatCardMeta, formatRelativeTime } from './gallery-format.js'
import { GalleryGifTile } from './gif-gallery.js'

/** Stable dispatchers shared by every card, so memoized cards never re-render for selection changes. */
export interface GalleryCardActions {
  click: (item: GalleryItem, index: number, event: MouseEvent) => void
  toggleSelect: (item: GalleryItem, index: number, event: MouseEvent) => void
  requestDelete: (item: GalleryItem) => void
  preview: (item: GalleryItem, blob?: Blob) => void
  toast: (message: string) => void
}

export interface GalleryCardProps {
  lang: 'zh' | 'en'
  item: GalleryItem
  index: number
  isManageMode: boolean
  isSelected: boolean
  t: (key: DictKey, params?: Record<string, string>) => string
  actions: GalleryCardActions
}

export const GalleryCard = memo(function GalleryCard({
  lang,
  item,
  index,
  isManageMode,
  isSelected,
  t,
  actions,
}: GalleryCardProps) {
  const [setCardRef, inView] = useInView<HTMLDivElement>()
  const [url, setUrl] = useState<string>()
  const [blob, setBlob] = useState<Blob>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [thumbFailed, setThumbFailed] = useState(false)
  const [thumbAttempt, setThumbAttempt] = useState(0)
  const [hovered, setHovered] = useState(false)

  // The host renders a cached 320px variant, so tiles never fetch originals;
  // the in-page pipeline below only runs when that route is unavailable.
  const serverThumbUrl = thumbUrlFor(item.attachment)
  const displayUrl = url ?? (thumbFailed ? undefined : (thumbAttempt === 0 ? serverThumbUrl : serverThumbUrl + '&retry=1'))
  const originalRef = useRef<Promise<Blob> | undefined>(undefined)
  const ensureAttachment = useCallback(async (): Promise<Blob> => {
    if (blob) return blob
    const pending = originalRef.current ?? (originalRef.current = fetchAttachmentBlob(item.attachment))
    try {
      const original = await pending
      setBlob(original)
      return original
    } finally {
      originalRef.current = undefined
    }
  }, [blob, item.attachment])
  const ensureOriginal = useCallback(async (): Promise<Blob> => {
    // Copy/download always want the raw bytes; drag prefetch keeps the smaller
    // attachment because a hover must not pull a multi-megabyte original.
    if (item.original !== undefined) return fetchGalleryItemBlob(item)
    return ensureAttachment()
  }, [ensureAttachment, item])

  useEffect(() => {
    if (!inView || !thumbFailed) return
    let active = true
    let objectUrl: string | undefined

    setUrl(undefined)
    setError(undefined)
    setLoading(true)
    const thumbnailKey = galleryThumbKey(item.attachment.attachmentId)
    void (async () => {
      try {
        const cached = await getGalleryThumb(thumbnailKey)
        if (!active) return
        if (cached) {
          objectUrl = URL.createObjectURL(cached)
          setUrl(objectUrl)
          setLoading(false)
          return
        }
        const original = await fetchAttachmentBlob(item.attachment)
        if (!active) return
        const thumbnail = await createImageThumbnail(original, GALLERY_THUMB_WIDTH)
        if (!active) return
        if (thumbnail !== original) void putGalleryThumb(thumbnailKey, thumbnail)
        objectUrl = URL.createObjectURL(thumbnail)
        setUrl(objectUrl)
        setLoading(false)
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    })()

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [item.attachment.attachmentId, inView, thumbFailed])

  const copyPrompt = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(item.prompt)
      actions.toast(t('copiedPrompt'))
    } catch {
      actions.toast(t('copyFailed'))
    }
  }

  const copyImage = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      const ok = await copyImageBlob(await ensureOriginal())
      actions.toast(ok ? t('copiedImage') : t('copyFailed'))
    } catch {
      actions.toast(t('copyFailed'))
    }
  }

  const downloadImage = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      const blob = await ensureOriginal()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = galleryDownloadName(item, blob)
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objectUrl)
    } catch {
      // Nothing to download when the attachment cannot be fetched.
    }
  }

  const toggleFavorite = async (e: MouseEvent) => {
    e.stopPropagation()
    const nextStatus = await toggleFavoriteGalleryItem(item.id)
    actions.toast(nextStatus ? t('favoriteAdded') : t('favoriteRemoved'))
  }

  // Label for top badge: show model or fallback to provider
  const badgeLabel = item.model || item.provider

  return (
    <div
      ref={setCardRef}
      className={`dsh-ig-gallery-card ${isSelected ? 'is-selected' : ''} ${isManageMode ? 'is-manage-mode' : ''}`}
      onClick={(e) => actions.click(item, index, e)}
      onPointerEnter={() => {
        setHovered(true)
        // Native drag-out needs a decoded blob at dragstart, which cannot
        // await; prefetch on hover, but keep large raw originals out of it.
        if (blob !== undefined) return
        if (shouldPrefetchOriginal(item.original)) void fetchGalleryItemBlob(item).then(setBlob).catch(() => undefined)
        else void ensureAttachment().catch(() => undefined)
      }}
      onPointerLeave={() => setHovered(false)}
    >
      {/* Upper media container */}
      <div className="dsh-ig-gallery-card-media">
        {/* Selection Checkbox (Top Left) */}
        <button
          type="button"
          className={`dsh-ig-card-checkbox ${isSelected ? 'is-checked' : ''}`}
          title={isSelected ? t('clearSelect') : t('manage')}
          onClick={(e) => actions.toggleSelect(item, index, e)}
        >
          {isSelected && <Check size={11} strokeWidth={3} />}
        </button>

        {/* The server thumbnail paints as it arrives, so only the fallback
            pipeline (no URL yet) needs a placeholder; otherwise the spinner
            flashes for one frame on every tile. */}
        {loading && displayUrl === undefined && <div className="dsh-ig-gallery-card-loading">...</div>}
        {error && <div className="dsh-ig-gallery-card-error">⚠️ {error}</div>}
        {displayUrl !== undefined && (
          <img
            className="dsh-ig-gallery-card-img"
            src={displayUrl}
            alt={item.prompt}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoading(false)}
            onError={() => {
              if (url !== undefined) return
              if (thumbAttempt === 0) setThumbAttempt(1)
              else setThumbFailed(true)
            }}
            draggable={!isManageMode}
            onDragStart={event => {
              if (isManageMode) event.preventDefault()
              else startGalleryImageDrag(event, item, blob)
            }}
          />
        )}
        <GalleryGifTile item={item} lang={lang} hovered={hovered} />

        {/* Hover quick action toolbar */}
        <div className="dsh-ig-card-toolbar">
          {!isManageMode && <GalleryCanvasButton item={item} lang={lang} className="dsh-ig-tool-btn" onToast={actions.toast} />}
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('copyImg')}
            onClick={(e) => {
              void copyImage(e)
            }}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('download')}
            onClick={(e) => {
              void downloadImage(e)
            }}
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('copyPpt')}
            onClick={(e) => {
              void copyPrompt(e)
            }}
          >
            <FileText size={13} />
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn dsh-ig-tool-btn-danger"
            title={t('delete')}
            onClick={(e) => {
              e.stopPropagation()
              actions.requestDelete(item)
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Lower metadata container aligned with mockup */}
      <div className="dsh-ig-gallery-card-meta">
        {/* Top badge */}
        <div className="dsh-ig-card-badge-row">
          <span className="dsh-ig-card-badge" title={badgeLabel}>
            {badgeLabel}
          </span>
        </div>

        {/* Prompt single-line title */}
        <div className="dsh-ig-gallery-card-prompt-line" title={item.prompt}>
          {item.prompt}
        </div>

        {/* Bottom meta row: dimension/ratio + relative time + heart favorite */}
        <div className="dsh-ig-card-footer-row">
          <span className="dsh-ig-card-meta-text">
            {formatCardMeta(item)} | {formatRelativeTime(item.createdAt, t)}
          </span>

          <button
            type="button"
            className={`dsh-ig-card-fav-btn ${item.isFavorite ? 'is-favorited' : ''}`}
            title={item.isFavorite ? t('favoriteRemoved') : t('favoriteAdded')}
            onClick={(e) => {
              void toggleFavorite(e)
            }}
          >
            <Heart
              size={15}
              fill={item.isFavorite ? 'currentColor' : 'none'}
            />
          </button>
        </div>
      </div>
    </div>
  )
})
