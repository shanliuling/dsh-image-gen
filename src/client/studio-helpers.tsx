import { memo, useCallback, useEffect, useRef, useState, type FC } from 'react'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { Check, ImagePlus, LoaderCircle, X } from 'lucide-react'
import { thumbUrlFor } from '../shared.js'
import { startGalleryImageDrag } from './tl/gallery-image-transfer.js'
import { GalleryCanvasButton } from './tl/gallery-canvas-button.js'
import { fetchAttachmentBlob } from './image-cache.js'
import { formatRelativeTime } from './browser-image-utils.js'
import { PROVIDER_DEFAULT_QUALITY } from '../openai-output.js'
import type { FavoriteFolder, GalleryItem } from './gallery-store.js'

export const BatchCanvasItem: FC<{
  item: GalleryItem
  index: number
  badge?: string | undefined
  isActive: boolean
  isChecked: boolean
  onSelect(): void
}> = ({ item, index, badge, isActive, isChecked, onSelect }) => {
  const image = useAttachmentImage(item.attachment, true)
  return (
    <div
      className={`dsh-ig-canvas-item ${isActive ? 'is-active' : ''} ${isChecked ? 'is-checked' : ''}`}
      onClick={onSelect}
    >
      <span className={`dsh-ig-canvas-badge ${badge ? 'is-model' : ''}`} title={badge}>{badge ?? `#${index + 1}`}</span>
      <span className="dsh-ig-canvas-check" aria-hidden="true">{isChecked ? <Check size={14} /> : null}</span>
      {image.url !== null ? (
        <img src={image.url} alt={item.prompt} draggable={false} />
      ) : image.loading ? (
        <div className="dsh-ig-canvas-item-loading">
          <LoaderCircle className="dsh-ig-spin" size={24} />
        </div>
      ) : (
        <div className="dsh-ig-canvas-item-loading">
          <ImagePlus size={24} />
        </div>
      )}
    </div>
  )
}

export function hasSubscriptionRatioMismatch(item: GalleryItem): boolean {
  if (item.provider !== 'chatgpt-sub' || item.aspectRatio === 'auto') return false
  const width = item.attachment.width
  const height = item.attachment.height
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return false
  const parts = item.aspectRatio?.split(':').map(Number)
  if (parts === undefined || parts.length !== 2 || !(parts[0]! > 0) || !(parts[1]! > 0)) return false
  return Math.abs((width / height) / (parts[0]! / parts[1]!) - 1) > 0.12
}

export const FieldSelect: FC<{ label: string; value: string; options: Array<{ value: string; label: string }>; onChange(value: string): void }> = ({ label, value, options, onChange }) => <label className="dsh-ig-field-select"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>

const LOCALIZED_RATIOS: Record<string, { zh: string; en: string }> = {
  auto: { zh: '自动', en: 'Auto' },
  '1:1': { zh: '1:1 方形', en: '1:1 Square' },
  '3:2': { zh: '3:2 横向', en: '3:2 Landscape' },
  '2:3': { zh: '2:3 肖像', en: '2:3 Portrait' },
  '4:3': { zh: '4:3 横向', en: '4:3 Landscape' },
  '3:4': { zh: '3:4 竖向', en: '3:4 Portrait' },
  '4:5': { zh: '4:5 肖像', en: '4:5 Portrait' },
  '5:4': { zh: '5:4 横向', en: '5:4 Landscape' },
  '16:9': { zh: '16:9 宽屏', en: '16:9 Widescreen' },
  '9:16': { zh: '9:16 竖屏', en: '9:16 Portrait' },
  '21:9': { zh: '21:9 超宽', en: '21:9 Ultrawide' },
}

const LOCALIZED_QUALITIES: Record<string, { zh: string; en: string }> = {
  standard: { zh: '标准（推荐）', en: 'Standard (Recommended)' },
  auto: { zh: '自动', en: 'Auto' },
  low: { zh: '低（快速）', en: 'Low (Fast)' },
  medium: { zh: '中', en: 'Medium' },
  high: { zh: '高', en: 'High' },
  xhigh: { zh: '超高', en: 'Extra High' },
  max: { zh: '最高', en: 'Max' },
  hd: { zh: '高清', en: 'HD' },
}

export function localizeRatioOptions(options: Array<{ value: string; label: string }>, lang: 'zh' | 'en'): Array<{ value: string; label: string }> {
  return options.map(opt => ({
    value: opt.value,
    label: LOCALIZED_RATIOS[opt.value]?.[lang] ?? opt.label,
  }))
}

export function localizeQualityOptions(options: Array<{ value: string; label: string }>, lang: 'zh' | 'en'): Array<{ value: string; label: string }> {
  return options.map(opt => ({
    value: opt.value,
    label: opt.value === PROVIDER_DEFAULT_QUALITY ? (lang === 'en' ? 'Provider default (omit)' : '渠道默认（不发送）') : LOCALIZED_QUALITIES[opt.value]?.[lang] ?? opt.label,
  }))
}

export interface RecentItemActions {
  select(item: GalleryItem): void
  favorite(item: GalleryItem): void
  toast(message: string): void
}

export const RecentItem = memo(function RecentItem({ item, active, mode, lang, actions }: {
  item: GalleryItem
  active: boolean
  mode: 'select' | 'favorite'
  lang: 'zh' | 'en'
  actions: RecentItemActions
}) {
  const [setRef, inView] = useInView<HTMLButtonElement>()
  const [hovered, setHovered] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  const [thumbAttempt, setThumbAttempt] = useState(0)
  // The tile renders the host 320 px variant; the original is fetched only
  // while the pointer is over it, for drag-out and canvas handoff.
  const image = useAttachmentImage(item.attachment, inView && (hovered || active || thumbFailed))
  const thumbSource = thumbUrlFor(item.attachment) + (thumbAttempt === 0 ? '' : '&retry=1')
  const thumbUrl = thumbFailed ? image.url : thumbSource
  return (
    <div
      className={`dsh-ig-recent-item ${active ? 'is-active' : ''}`}
      onPointerEnter={() => setHovered(true)}
      onPointerDown={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        ref={setRef}
        type="button"
        className="dsh-ig-recent-select"
        onClick={() => { if (mode === 'favorite') actions.favorite(item); else actions.select(item) }}
        title={item.prompt}
        draggable={Boolean(image.blob?.size)}
        onDragStart={event => { startGalleryImageDrag(event, item, image.blob) }}
      >
        <div className="dsh-ig-recent-thumb">
          {thumbUrl !== null && thumbUrl !== undefined
            ? <img
                src={thumbUrl}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={() => { if (thumbAttempt === 0) setThumbAttempt(1); else setThumbFailed(true) }}
              />
            : <ImagePlus size={18} />}
        </div>
      </button>
      <GalleryCanvasButton item={item} lang={lang} disabled={!image.blob?.size} className="dsh-ig-recent-send" onToast={actions.toast} />
    </div>
  )
})

export const FavoriteFolderBar: FC<{ folders: FavoriteFolder[]; active: string; onSelect(id: string): void; onDelete(id: string): void; deleteLabel: string }> = ({ folders, active, onSelect, onDelete, deleteLabel }) => {
  if (folders.length === 0) return null
  return (
    <div className="dsh-ig-fav-folders">
      {folders.map(folder => (
        <span key={folder.id} className={`dsh-ig-fav-folder-chip ${active === folder.id ? 'is-active' : ''}`}>
          <button type="button" onClick={() => onSelect(folder.id)}>{folder.name}</button>
          <button type="button" className="dsh-ig-fav-folder-del" title={deleteLabel} onClick={() => onDelete(folder.id)}><X size={9} /></button>
        </span>
      ))}
    </div>
  )
}

export function useInView<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [inView, setInView] = useState(false)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
    }
  }, [])

  const refCallback = useCallback((el: T | null) => {
    observerRef.current?.disconnect()
    if (!el || inView) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setInView(true)
        observer.disconnect()
      }
    }, { rootMargin: '120px' })
    observerRef.current = observer
    observer.observe(el)
  }, [inView])

  return [refCallback, inView]
}

export function useAttachmentImage(attachment: ImageAttachmentRef | undefined, shouldLoad: boolean = true): { url: string | null; blob: Blob | null; loading: boolean } {
  const [value, setValue] = useState<{ url: string | null; blob: Blob | null; loading: boolean }>({ url: null, blob: null, loading: false })
  useEffect(() => {
    if (attachment === undefined || !shouldLoad) { setValue({ url: null, blob: null, loading: false }); return }
    let cancelled = false
    let objectUrl: string | null = null
    setValue({ url: null, blob: null, loading: true })
    fetchAttachmentBlob(attachment)
      .then(blob => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setValue({ url: objectUrl, blob, loading: false })
      })
      .catch(() => { if (!cancelled) setValue({ url: null, blob: null, loading: false }) })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment?.attachmentId, shouldLoad])
  return value
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const commaIndex = result.indexOf(',')
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  })
}

export function extension(mediaType: ImageMediaType): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1] ?? 'png'
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
