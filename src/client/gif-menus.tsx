import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { GifT } from './gif-i18n.js'
import { GIF_SPEED_MAX, GIF_SPEED_MIN, GIF_SPEED_STEP, formatSpeed, gifDownloadLabel, useGifReadable, useGifSnapshot, useGifSpeed, type GifPlayer } from './gif-player.js'

/**
 * Close a popup on a press outside it or on Escape, returning focus to its
 * trigger. Escape is taken in the capture phase and stopped, so the lightbox
 * listening on the window stays open.
 */
function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement>, trigger: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])
}

function usePopup(onOpenChange: ((open: boolean) => void) | undefined) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const latest = useRef({ open, onOpenChange })
  latest.current = { open, onOpenChange }
  const change = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  // Unmounted while open (the card turned still): the owner still hears it closed, or it stays pinned open.
  useEffect(() => () => { if (latest.current.open) latest.current.onOpenChange?.(false) }, [])
  useDismiss(open, () => { change(false) }, root, trigger)
  return { open, root, trigger, toggle: () => { change(!open) }, close: () => { change(false) } }
}

const FASTER = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 17a8 8 0 0 1 16 0" /><path d="M12 17l4.5-5" /></svg>
const SLOWER = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 17a8 8 0 0 1 16 0" /><path d="M12 17l-4.5-5" /></svg>

/**
 * The speed slider: a native range for keys and assistive tech, drawn as a
 * vertical track. It carries no numbers; the trigger shows the value.
 */
export function GifSpeedPanel({ speed, t, onChange }: { speed: number; t: GifT; onChange(speed: number): void }) {
  const percent = (value: number) => `${String((value - GIF_SPEED_MIN) / (GIF_SPEED_MAX - GIF_SPEED_MIN) * 100)}%`
  const style = { '--dsh-ig-speed-pct': percent(speed), '--dsh-ig-speed-one': percent(GIF_SPEED_MAX + GIF_SPEED_MIN - 1) } as CSSProperties
  return <div className="dsh-ig-speed-panel" role="dialog" aria-label={t('gifSpeed')} onClick={event => { event.stopPropagation() }}>
    <span className="dsh-ig-speed-icon" title={t('gifFaster')}>{FASTER}</span>
    <div className="dsh-ig-speed-track" style={style}>
      <span className="dsh-ig-speed-rail" />
      <span className="dsh-ig-speed-fill" />
      <span className="dsh-ig-speed-one" />
      <span className="dsh-ig-speed-knob" />
      <input
        className="dsh-ig-speed-input"
        type="range"
        min={GIF_SPEED_MIN}
        max={GIF_SPEED_MAX}
        step={GIF_SPEED_STEP}
        value={speed}
        aria-label={t('gifSpeed')}
        aria-valuetext={`${formatSpeed(speed)}×`}
        title={t('gifSpeedHint')}
        autoFocus
        onChange={event => { onChange(Number(event.target.value)) }}
        onDoubleClick={() => { onChange(1) }}
      />
    </div>
    <span className="dsh-ig-speed-icon" title={t('gifSlower')}>{SLOWER}</span>
  </div>
}

/** The speed trigger and its panel: a chip on the card, a button in the lightbox bar. */
export function GifSpeedControl({ player, t, variant, onOpenChange }: { player: GifPlayer; t: GifT; variant: 'chip' | 'bar'; onOpenChange?: (open: boolean) => void }) {
  const speed = useGifSpeed(player) ?? 1
  const readable = useGifReadable(player)
  const popup = usePopup(onOpenChange)
  const label = `${formatSpeed(speed)}×`
  return <div ref={popup.root} className={`dsh-ig-speed dsh-ig-speed-${variant}`}>
    <button
      ref={popup.trigger}
      type="button"
      className={variant === 'chip' ? 'dsh-ig-gif-chip dsh-ig-speed-trigger' : 'dsh-ig-speed-trigger'}
      title={t('gifSpeed')}
      aria-label={`${t('gifSpeed')} ${label}`}
      aria-haspopup="dialog"
      aria-expanded={popup.open}
      disabled={!readable}
      onClick={event => { event.stopPropagation(); popup.toggle() }}
    >{label}</button>
    {popup.open ? <GifSpeedPanel speed={speed} t={t} onChange={value => { player.setSpeed(value) }} /> : null}
  </div>
}

export type GifDownloadKind = 'gif' | 'original' | 'frame'

export interface GifDownloadItem {
  kind: GifDownloadKind
  label: string
  hint: string
  disabled: boolean
}

/** The GIF at the speed it plays, the original timing when that differs, and the frame on screen (one-based). */
export function gifDownloadItems(t: GifT, speed: number, framesReady: boolean, frame: number): GifDownloadItem[] {
  return [
    { kind: 'gif', label: gifDownloadLabel(t, speed), hint: speed === 1 ? t('gifDownloadHintOriginal') : t('gifDownloadHintSpeed'), disabled: false },
    ...(speed === 1 ? [] : [{ kind: 'original' as const, label: t('gifDownloadOriginal'), hint: t('gifDownloadOriginalHint'), disabled: false }]),
    { kind: 'frame', label: t('gifDownloadFrame'), hint: t('gifDownloadFrameHint', { frame: String(frame) }), disabled: !framesReady },
  ]
}

const DOWNLOAD_ICON = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
const CARET = <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>

export interface GifDownloadMenuProps {
  player: GifPlayer
  t: GifT
  /** The card's hover toolbar, the lightbox's top-right actions, or the gallery preview's bottom bar. */
  variant: 'toolbar' | 'lightbox' | 'gallery'
  onDownload(kind: GifDownloadKind): void
  onOpenChange?: (open: boolean) => void
}

const DOWNLOAD_TRIGGER_CLASS = { toolbar: 'dsh-ig-tool-btn', lightbox: 'dsh-ig-gif-action', gallery: 'dsh-ig-lightbox-btn' } as const

export function GifDownloadMenu({ player, t, variant, onDownload, onOpenChange }: GifDownloadMenuProps) {
  const popup = usePopup(onOpenChange)
  return <div ref={popup.root} className={`dsh-ig-dl dsh-ig-dl-${variant}`}>
    <button
      ref={popup.trigger}
      type="button"
      className={DOWNLOAD_TRIGGER_CLASS[variant]}
      title={t('gifDownloadMenu')}
      aria-label={t('gifDownloadMenu')}
      aria-haspopup="menu"
      aria-expanded={popup.open}
      onClick={event => { event.stopPropagation(); popup.toggle() }}
    >{DOWNLOAD_ICON}{variant === 'toolbar' ? null : <span>{t('gifDownloadMenu')}</span>}{CARET}</button>
    {popup.open ? <GifDownloadList player={player} t={t} onPick={kind => { popup.close(); onDownload(kind) }} /> : null}
  </div>
}

/** The open menu; it alone follows the frame on screen, so a closed trigger never re-renders per frame. */
function GifDownloadList({ player, t, onPick }: { player: GifPlayer; t: GifT; onPick(kind: GifDownloadKind): void }) {
  const { speed, status, index } = useGifSnapshot(player)
  return <div className="dsh-ig-dl-menu" role="menu" aria-label={t('gifDownloadMenu')} onClick={event => { event.stopPropagation() }}>
    {gifDownloadItems(t, speed, status === 'ready', index + 1).map(item => <button
      key={item.kind}
      type="button"
      role="menuitem"
      className="dsh-ig-dl-item"
      disabled={item.disabled}
      onClick={() => { onPick(item.kind) }}
    >
      <span>{item.label}</span>
      <span className="dsh-ig-dl-hint">{item.hint}</span>
    </button>)}
  </div>
}
