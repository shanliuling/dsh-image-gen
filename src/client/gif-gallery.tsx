import { useEffect, useRef, useState } from 'react'
import { imageUrlFor, vaultUrlFor } from '../shared.js'
import type { GalleryItem } from './gallery-store.js'
import { fetchGalleryItemBlob } from './gallery-media.js'
import { downloadGif } from './gif-card.js'
import { GifPlayerBar } from './gif-controls.js'
import { gifT, type GifT } from './gif-i18n.js'
import { GifDownloadMenu } from './gif-menus.js'
import { GifStage, useGifPlayer, type GifPlayer } from './gif-player.js'

/** Where a gallery item's animation is served, when it has one: its vault original, or a GIF attachment. */
export function galleryGifUrl(item: GalleryItem): string | undefined {
  if (item.original?.mediaType === 'image/gif') return vaultUrlFor(item.original.key, item.original.mediaType)
  if (item.attachment.mediaType === 'image/gif') return imageUrlFor(item.attachment)
  return undefined
}

/**
 * A grid tile's GIF badge, and its animation laid over the still thumbnail
 * while the pointer is on the tile. The thumbnail stays underneath, so a slow
 * or missing original never blanks the tile, and drags still start from it.
 */
export function GalleryGifTile({ item, lang, hovered }: { item: GalleryItem; lang: 'zh' | 'en'; hovered: boolean }) {
  const url = galleryGifUrl(item)
  const [failedUrl, setFailedUrl] = useState<string>()
  if (url === undefined) return null
  return <>
    {hovered && failedUrl !== url ? <img className="dsh-ig-gallery-card-img dsh-ig-gallery-gif-hover" src={url} alt="" aria-hidden="true" onError={() => { setFailedUrl(url) }} /> : null}
    <span className="dsh-ig-gallery-gif-badge" title={gifT(lang)('gifBadge')}>GIF</span>
  </>
}

export interface GalleryGifPreview {
  t: GifT
  player: GifPlayer
  item: GalleryItem
}

/**
 * The player behind the gallery preview of an animated item, once its bytes
 * are at hand. An original that is gone falls back to the still attachment,
 * which the gallery's own image shows.
 */
export function useGalleryGifPreview(item: GalleryItem | null, lang: 'zh' | 'en'): GalleryGifPreview | undefined {
  const [loaded, setLoaded] = useState<{ item: GalleryItem; blob: Blob }>()
  const itemRef = useRef(item)
  itemRef.current = item
  const gifUrl = item === null ? undefined : galleryGifUrl(item)

  // Keyed by the item as well as the URL: two items can share one GIF (the same file imported twice).
  useEffect(() => {
    const current = itemRef.current
    if (current === null || gifUrl === undefined) return
    let canceled = false
    void fetchGalleryItemBlob(current).then(blob => {
      if (!canceled && blob.type === 'image/gif') setLoaded({ item: current, blob })
    }, () => undefined)
    return () => {
      canceled = true
      setLoaded(undefined)
    }
  }, [gifUrl, item?.id])

  const player = useGifPlayer(loaded?.blob)
  // Until the effect drops it, the previous item's player outlives a page turn by one render.
  if (player === undefined || loaded === undefined || loaded.item.id !== item?.id) return undefined
  return { t: gifT(lang), player, item: loaded.item }
}

/** The preview's animation, in place of the gallery image; sized to leave room for the player bar. */
export function GalleryGifStage({ preview, poster }: { preview: GalleryGifPreview; poster: string | undefined }) {
  return <GifStage player={preview.player} stage="gallery" className="dsh-ig-lightbox-img dsh-ig-gallery-gif-img" alt={preview.item.prompt} poster={poster} />
}

/** The player bar, floating above the gallery's own bottom bar. */
export function GalleryGifBar({ preview }: { preview: GalleryGifPreview }) {
  return <GifPlayerBar player={preview.player} t={preview.t} className="dsh-ig-gif-bar-gallery" stripHint={preview.t('gifStripHintGallery')} />
}

/** The bottom bar's download, as a menu of the GIF at its speed, its original timing and the frame on display. */
export function GalleryGifDownload({ preview }: { preview: GalleryGifPreview }) {
  const { player, item } = preview
  return <GifDownloadMenu player={player} t={preview.t} variant="gallery" onDownload={kind => { downloadGif(player, kind, player.getSnapshot().speed, `dsh-${item.provider}-${item.id}`) }} />
}
