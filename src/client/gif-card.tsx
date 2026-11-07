import { useEffect, useRef, useState, type DragEvent } from 'react'
import { readGifInfo, retimeGif, type GifInfo } from '../gif-info.js'
import { vaultUrlFor } from '../shared.js'
import { downloadBlobUrl } from './browser-image-utils.js'
import { GifPlayerBar } from './gif-controls.js'
import { gifT, type GifT } from './gif-i18n.js'
import { GifDownloadMenu, GifSpeedControl, type GifDownloadKind } from './gif-menus.js'
import { GifStage, gifKeyboardAction, speedSuffix, useGifPlayer, useGifSpeed, useGifStatus, type GifPlayer } from './gif-player.js'
import { copyImageBlob } from './gallery-view.js'

export interface GifCardInput {
  lang: 'zh' | 'en'
  /** The vault copy of the version on display, when the host normalized its attachment. */
  original: { key: string; mediaType: string } | undefined
  /** The attachment on display; a GIF attachment is itself the raw file. */
  attachmentMediaType: string | undefined
  attachmentBlob: Blob | undefined
  /** The vault says the file is gone (deleted from the gallery): the record should drop its reference. */
  onOriginalGone(): void
}

export interface GifCard {
  t: GifT
  /** Whether the version on display is an animation, before its bytes are at hand. */
  animated: boolean
  /** Defined once the raw GIF is at hand. */
  player: GifPlayer | undefined
  /** Frame facts for a regeneration that asks for an animation again. */
  info(): Promise<GifInfo | undefined>
  /** The GIF as it plays now: retimed to the playback speed once its bytes are read. */
  file(): Blob | undefined
  download(kind: GifDownloadKind): void
  /** Copy the frame on display as a still; resolves the message to show. */
  copyFrame(): Promise<string | undefined>
}

function downloadFile(file: Blob, name: string): void {
  const objectUrl = URL.createObjectURL(file)
  downloadBlobUrl(objectUrl, name)
  setTimeout(() => { URL.revokeObjectURL(objectUrl) }, 10_000)
}

/** The GIF as it plays: retimed to the playback speed once its bytes are read. */
function gifAtSpeed(player: GifPlayer, speed: number): Blob {
  const bytes = player.bytes()
  if (bytes === undefined) return player.blob
  return new Blob([(retimeGif(bytes, speed) ?? bytes) as BlobPart], { type: 'image/gif' })
}

/** Save the GIF at its speed, at its original timing, or the frame on display, named after `stem`. */
export function downloadGif(player: GifPlayer, kind: GifDownloadKind, speed: number, stem: string): void {
  if (kind === 'frame') {
    const frame = player.getSnapshot().index + 1
    void player.captureFrame().then(still => {
      if (still !== undefined) downloadFile(still, `${stem}-frame${String(frame)}.png`)
    })
    return
  }
  if (kind === 'original') downloadFile(player.blob, `${stem}.gif`)
  else downloadFile(gifAtSpeed(player, speed), `${stem}${speedSuffix(speed)}.gif`)
}

/** The animation behind a conversation card: its raw bytes, the player over them, and what a card does with them. */
export function useGifCard({ lang, original, attachmentMediaType, attachmentBlob, onOriginalGone }: GifCardInput): GifCard {
  const t = gifT(lang)
  const gifKey = original?.mediaType === 'image/gif' ? original.key : undefined
  const attachmentIsGif = attachmentMediaType === 'image/gif'
  const [vaultBlob, setVaultBlob] = useState<Blob>()
  const [vaultGone, setVaultGone] = useState(false)
  /** The vault fetch in flight, for a regeneration that starts before it lands. */
  const vaultBlobRef = useRef<Promise<Blob | undefined>>()
  const goneRef = useRef(onOriginalGone)
  goneRef.current = onOriginalGone

  useEffect(() => {
    if (gifKey === undefined) {
      vaultBlobRef.current = undefined
      return
    }
    let canceled = false
    const loading = fetch(vaultUrlFor(gifKey, 'image/gif'), { credentials: 'same-origin' }).then(async response => {
      if (response.ok) return response.blob()
      // Only the vault saying the file is gone makes this a still card and
      // drops the gallery record's reference; any other failure keeps both
      // and the next mount tries again.
      if (response.status === 404) return undefined
      throw new Error(`Original unavailable (${String(response.status)})`)
    })
    vaultBlobRef.current = loading.catch(() => undefined)
    void loading.then(blob => {
      if (canceled) return
      if (blob !== undefined) {
        setVaultBlob(blob)
        return
      }
      setVaultGone(true)
      goneRef.current()
    }, () => undefined)
    return () => {
      canceled = true
      setVaultBlob(undefined)
      setVaultGone(false)
    }
  }, [gifKey])

  const player = useGifPlayer(gifKey !== undefined ? vaultBlob : attachmentIsGif ? attachmentBlob : undefined)
  const speed = useGifSpeed(player) ?? 1

  return {
    t,
    animated: (gifKey !== undefined && !vaultGone) || attachmentIsGif,
    player,
    info: async () => {
      if (player !== undefined) return player.getSnapshot().info ?? readGifInfo(new Uint8Array(await player.blob.arrayBuffer()))
      const source = gifKey !== undefined ? await vaultBlobRef.current : attachmentIsGif ? attachmentBlob : undefined
      return source === undefined ? undefined : readGifInfo(new Uint8Array(await source.arrayBuffer()))
    },
    file: () => (player === undefined ? undefined : gifAtSpeed(player, speed)),
    download: kind => {
      if (player !== undefined) downloadGif(player, kind, speed, `dsh-image-${String(Date.now())}`)
    },
    // The clipboard takes only still images: a decoded card copies the frame
    // on screen, one without frames yet copies the still first frame.
    copyFrame: async () => {
      if (player === undefined) return undefined
      // Read before encoding: a playing card has moved on by the time the copy lands.
      const { index, frames } = player.getSnapshot()
      const frame = await player.captureFrame()
      const target = frame ?? attachmentBlob
      if (target === undefined) return undefined
      if (!(await copyImageBlob(target))) return t('gifCopyFailed')
      return frame === undefined ? t('gifCopiedFirstFrame') : t('gifCopiedFrame', { current: String(index + 1), total: String(frames.length) })
    },
  }
}

/** The card's speed chip; its panel opens over the image, so the card unclips while it is open. */
export function GifCardOverlay({ gif, onOpenChange }: { gif: GifCard; onOpenChange(open: boolean): void }) {
  if (gif.player === undefined) return null
  return <div className="dsh-ig-gif-chip-slot">
    <GifSpeedControl player={gif.player} t={gif.t} variant="chip" onOpenChange={onOpenChange} />
  </div>
}

/** The card's hover-toolbar download, as a menu of the GIF, its original timing and the frame on screen. */
export function GifToolbarDownload({ gif, onOpenChange }: { gif: GifCard; onOpenChange(open: boolean): void }) {
  if (gif.player === undefined) return null
  return <GifDownloadMenu player={gif.player} t={gif.t} variant="toolbar" onDownload={gif.download} onOpenChange={onOpenChange} />
}

const COPY_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
const CLOSE_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>

export interface GifLightboxProps {
  gif: GifCard
  player: GifPlayer
  alt: string
  /** Still image for a paused player whose frames were released. */
  poster: string | undefined
  onClose(): void
  onDragStart(event: DragEvent<HTMLElement>): void
}

/** The GIF lightbox: the stage, the player bar, and copy, download and close at the top right. */
export function GifLightbox({ gif, player, alt, poster, onClose, onDragStart }: GifLightboxProps) {
  const t = gif.t
  const ready = useGifStatus(player) === 'ready'
  const [toast, setToast] = useState<string>()

  // Space and the arrows drive the player; a focused control keeps the keys it
  // handles itself, and the frame strip stops the ones it takes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (player.getSnapshot().status !== 'ready') return
      const action = gifKeyboardAction(event.key, event.target as { tagName: string; type?: string } | null)
      if (action === undefined) return
      event.preventDefault()
      const run = { toggle: () => { player.toggle() }, previous: () => { player.step(-1) }, next: () => { player.step(1) }, first: () => { player.first() }, last: () => { player.last() } }
      run[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [player])

  // The card has no play button: a pause made here stays here, while the speed carries over.
  useEffect(() => () => { player.play() }, [player])

  useEffect(() => {
    if (toast === undefined) return
    const timer = setTimeout(() => { setToast(undefined) }, 3500)
    return () => { clearTimeout(timer) }
  }, [toast])

  return <div className="dsh-ig-lightbox-backdrop" onClick={onClose}>
    <div className="dsh-ig-gif-actions" onClick={event => { event.stopPropagation() }}>
      <button type="button" className="dsh-ig-gif-action" title={ready ? t('gifCopyFrame') : t('gifCopyFirstFrame')} aria-label={ready ? t('gifCopyFrame') : t('gifCopyFirstFrame')} onClick={() => { void gif.copyFrame().then(setToast) }}>{COPY_ICON}</button>
      <GifDownloadMenu player={player} t={t} variant="lightbox" onDownload={gif.download} />
      <button type="button" className="dsh-ig-gif-action" title={t('gifClose')} aria-label={t('gifClose')} onClick={onClose}>{CLOSE_ICON}</button>
    </div>
    {toast !== undefined ? <div className="dsh-ig-gif-toast" role="status">{toast}</div> : null}
    <div className="dsh-ig-lightbox-img-wrap dsh-ig-gif-wrap" onClick={event => { event.stopPropagation() }}>
      <GifStage player={player} stage="lightbox" className="dsh-ig-lightbox-img" alt={alt} poster={poster} onDragStart={onDragStart} />
    </div>
    <div className="dsh-ig-gif-dock" onClick={event => { event.stopPropagation() }}>
      <GifPlayerBar player={player} t={t} />
    </div>
  </div>
}
