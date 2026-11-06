/**
 * Frame-accurate GIF playback for the conversation card: a small external
 * store that owns the decoded frames and the clock, a stage that paints the
 * current frame, and a control bar. Frames are decoded only while a stage is
 * visible and only within a memory budget; otherwise the GIF plays natively in
 * an <img>, which still animates but cannot pause, seek or change speed.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent } from 'react'
import { readGifInfo, type GifInfo } from '../gif-info.js'
import type { DictKey } from './plugin-i18n.js'

const GIF_SPEEDS = [0.5, 1, 2] as const
type GifSpeed = typeof GIF_SPEEDS[number]

/** Decoded bitmap bytes one card may hold, and all cards together; beyond either the GIF plays natively. */
const DECODE_BUDGET_BYTES = 96 * 1024 * 1024
export const DECODE_TOTAL_BUDGET_BYTES = 256 * 1024 * 1024
const DECODE_MAX_FRAMES = 512
/** Shortest tick the clock schedules, so 2x on a 20 ms GIF cannot spin the timer. */
const MIN_TICK_MS = 20
/** A stage starts decoding one viewport early and releases one viewport late. */
const VISIBILITY_MARGIN = '100%'

export function nextFrameIndex(index: number, total: number, delta = 1): number {
  return total <= 0 ? 0 : (((index + delta) % total) + total) % total
}

export function scheduledDelayMs(delayMs: number, speed: number): number {
  return Math.max(MIN_TICK_MS, delayMs / speed)
}

/**
 * The delay a browser plays a frame for: its own decoder's duration when it
 * reports one, else the header delay; either way a delay of at most 10 ms is
 * shown for 100 ms, as the <img> element and the retimed download do.
 */
export function playedDelayMs(durationUs: number | null | undefined, headerMs: number): number {
  const ms = durationUs !== null && durationUs !== undefined && durationUs > 0 ? Math.round(durationUs / 1000) : headerMs
  return ms <= 10 ? 100 : ms
}

type GifKeyboardAction = 'toggle' | 'previous' | 'next' | 'first' | 'last'

/**
 * The lightbox shortcut for a key, given the element that holds focus. A
 * focused control keeps only the keys it handles itself (a button its Space
 * and Enter, the frame scrubber its arrows and Home/End), so stepping still
 * works after the mouse has clicked a button, while a text field keeps all.
 */
export function gifKeyboardAction(key: string, target: { tagName: string; type?: string | undefined } | null): GifKeyboardAction | undefined {
  const actions: Record<string, GifKeyboardAction> = { ' ': 'toggle', ArrowLeft: 'previous', ArrowRight: 'next', Home: 'first', End: 'last' }
  const action = actions[key]
  if (action === undefined || target === null) return action
  const tag = target.tagName.toUpperCase()
  if (tag === 'BUTTON') return key === ' ' || key === 'Enter' ? undefined : action
  if (tag === 'INPUT' && target.type === 'range') return action === 'toggle' ? action : undefined
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return undefined
  return action
}

/** File-name suffix for a download at a non-default speed. */
export function speedSuffix(speed: GifSpeed): string {
  return speed === 1 ? '' : `-${String(speed)}x`
}

/** "Download GIF", naming the speed only when it is not the file's own. */
export function gifDownloadLabel(t: (key: DictKey, params?: Record<string, string>) => string, speed: GifSpeed): string {
  return speed === 1 ? t('gifDownload') : t('gifDownloadSpeed', { speed: String(speed) })
}

function decodedBytesOf(info: Pick<GifInfo, 'frames' | 'width' | 'height'>): number {
  return info.frames * info.width * info.height * 4
}

/** Judged from the header before anything is decoded: the GIF alone, and together with what other cards already hold; a header without a screen size cannot be judged. */
export function withinDecodeBudget(info: Pick<GifInfo, 'frames' | 'width' | 'height'>, usedBytes: number): boolean {
  const bytes = decodedBytesOf(info)
  return info.width > 0 && info.height > 0 && info.frames <= DECODE_MAX_FRAMES && bytes <= DECODE_BUDGET_BYTES && usedBytes + bytes <= DECODE_TOTAL_BUDGET_BYTES
}

type GifPlayerStatus = 'native' | 'decoding' | 'ready' | 'fallback'

interface GifPlayerSnapshot {
  readonly status: GifPlayerStatus
  readonly info: GifInfo | undefined
  readonly index: number
  readonly playing: boolean
  readonly speed: GifSpeed
  /** Composited frames while `ready`; empty otherwise. */
  readonly frames: readonly ImageBitmap[]
  readonly delaysMs: readonly number[]
}

interface DecodedGif {
  frames: ImageBitmap[]
  delaysMs: number[]
}

/** Browser services the store relies on; tests inject stand-ins. */
export interface GifPlayerDeps {
  /** Resolves undefined when this environment cannot decode frame by frame. */
  decode(blob: Blob, info: GifInfo): Promise<DecodedGif | undefined>
  encodeFrame(frame: ImageBitmap): Promise<Blob | undefined>
  hidden(): boolean
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface GifPlayer {
  readonly blob: Blob
  /** Object URL of the raw GIF for native playback and "open in new tab". */
  readonly url: string | undefined
  /** The raw bytes once read; a drag-out needs them synchronously. */
  bytes(): Uint8Array | undefined
  subscribe(listener: () => void): () => void
  getSnapshot(): GifPlayerSnapshot
  /** Each stage reports its own viewport state; frames exist while any stage is visible. */
  setVisible(stage: unknown, visible: boolean): void
  play(): void
  pause(): void
  toggle(): void
  /** Seeking and stepping pause playback, so the chosen frame stays. */
  seek(index: number): void
  step(delta: number): void
  first(): void
  last(): void
  /** Takes effect on the next tick; nothing is re-decoded. */
  setSpeed(speed: GifSpeed): void
  /** Pause on the frame on screen and encode it as PNG, so what was copied stays visible; undefined until frames are decoded. */
  captureFrame(): Promise<Blob | undefined>
  dispose(): void
}

/** Bitmap bytes currently held by every player, so cards share one budget. */
let decodedBytesInUse = 0
/** Visible players the shared budget turned away; a release wakes them, as no visibility event would. */
const waitingForBudget = new Set<() => void>()

export function createGifPlayer(blob: Blob, overrides: Partial<GifPlayerDeps> = {}): GifPlayer {
  const deps: GifPlayerDeps = { ...browserDeps(), ...overrides }
  const listeners = new Set<() => void>()
  const visibleStages = new Set<unknown>()
  let snapshot: GifPlayerSnapshot = { status: 'native', info: undefined, index: 0, playing: true, speed: 1, frames: [], delaysMs: [] }
  let bytes: Uint8Array | undefined
  let timer: unknown
  let heldBytes = 0
  let decodeToken = 0
  let disposed = false
  const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : undefined

  const set = (patch: Partial<GifPlayerSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const frameCount = () => snapshot.frames.length || snapshot.info?.frames || 0

  const stopClock = () => {
    if (timer === undefined) return
    deps.clearTimeout(timer)
    timer = undefined
  }
  const schedule = () => {
    stopClock()
    if (disposed || snapshot.status !== 'ready' || !snapshot.playing || visibleStages.size === 0 || deps.hidden()) return
    timer = deps.setTimeout(() => {
      timer = undefined
      set({ index: nextFrameIndex(snapshot.index, snapshot.frames.length) })
      schedule()
    }, scheduledDelayMs(snapshot.delaysMs[snapshot.index] ?? 100, snapshot.speed))
  }
  const returnBudget = () => {
    if (heldBytes === 0) return
    decodedBytesInUse -= heldBytes
    heldBytes = 0
    for (const retry of [...waitingForBudget]) retry()
  }
  /** Drop the frames (and any decode in flight) but keep index, speed and playing for the next decode. */
  const release = () => {
    stopClock()
    decodeToken += 1
    for (const frame of snapshot.frames) frame.close()
    returnBudget()
    set({ status: snapshot.status === 'fallback' ? 'fallback' : 'native', frames: [], delaysMs: [] })
  }
  const maybeDecode = () => {
    waitingForBudget.delete(maybeDecode)
    if (disposed || visibleStages.size === 0 || snapshot.status !== 'native') return
    const info = snapshot.info
    if (info === undefined) return
    // Too big on its own: never decode. Too big only together with the other
    // cards: stay native until one of them releases its share.
    if (!withinDecodeBudget(info, 0)) { set({ status: 'fallback' }); return }
    if (!withinDecodeBudget(info, decodedBytesInUse)) { waitingForBudget.add(maybeDecode); return }
    const token = ++decodeToken
    heldBytes = decodedBytesOf(info)
    decodedBytesInUse += heldBytes
    set({ status: 'decoding' })
    deps.decode(blob, info).then(decoded => {
      if (token !== decodeToken) {
        for (const frame of decoded?.frames ?? []) frame.close()
        return
      }
      if (decoded === undefined || decoded.frames.length === 0) {
        returnBudget()
        set({ status: 'fallback' })
        return
      }
      set({ status: 'ready', frames: decoded.frames, delaysMs: decoded.delaysMs, index: Math.min(snapshot.index, decoded.frames.length - 1) })
      schedule()
    }, () => {
      if (token !== decodeToken) return
      returnBudget()
      set({ status: 'fallback' })
    })
  }

  void blob.arrayBuffer().then(buffer => {
    if (disposed) return
    bytes = new Uint8Array(buffer)
    set({ info: readGifInfo(bytes) })
    maybeDecode()
  }, () => undefined)

  const onVisibilityChange = () => { if (deps.hidden()) stopClock(); else schedule() }
  const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : undefined
  doc?.addEventListener('visibilitychange', onVisibilityChange)

  const pause = () => {
    if (!snapshot.playing) return
    stopClock()
    set({ playing: false })
  }
  const play = () => {
    if (snapshot.playing) return
    set({ playing: true })
    schedule()
  }
  const seek = (index: number) => {
    const total = frameCount()
    if (total === 0) return
    stopClock()
    set({ playing: false, index: Math.min(Math.max(Math.trunc(index), 0), total - 1) })
  }

  return {
    blob,
    url,
    bytes: () => bytes,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    setVisible: (stage, visible) => {
      if (disposed) return
      if (visible) visibleStages.add(stage)
      else visibleStages.delete(stage)
      if (visibleStages.size === 0) {
        waitingForBudget.delete(maybeDecode)
        if (snapshot.status === 'ready' || snapshot.status === 'decoding') release()
        return
      }
      if (snapshot.status === 'ready') schedule()
      else maybeDecode()
    },
    play,
    pause,
    toggle: () => { if (snapshot.playing) pause(); else play() },
    seek,
    step: delta => {
      const total = frameCount()
      if (total === 0) return
      stopClock()
      set({ playing: false, index: nextFrameIndex(snapshot.index, total, delta) })
    },
    first: () => { seek(0) },
    last: () => { seek(frameCount() - 1) },
    setSpeed: speed => { set({ speed }) },
    captureFrame: async () => {
      const frame = snapshot.frames[snapshot.index]
      if (frame === undefined) return undefined
      pause()
      return deps.encodeFrame(frame)
    },
    dispose: () => {
      if (disposed) return
      waitingForBudget.delete(maybeDecode)
      release()
      disposed = true
      listeners.clear()
      doc?.removeEventListener('visibilitychange', onVisibilityChange)
      if (url !== undefined) URL.revokeObjectURL(url)
    },
  }
}

function browserDeps(): GifPlayerDeps {
  return {
    decode: decodeWithWebCodecs,
    encodeFrame: encodeFramePng,
    hidden: () => typeof document !== 'undefined' && document.hidden,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}

/**
 * WebCodecs hands out frames already composited by disposal method. Each
 * VideoFrame is closed as soon as its bitmap exists.
 */
async function decodeWithWebCodecs(blob: Blob, info: GifInfo): Promise<DecodedGif | undefined> {
  if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported('image/gif'))) return undefined
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif' })
  const frames: ImageBitmap[] = []
  const delaysMs: number[] = []
  try {
    await decoder.completed
    await decoder.tracks.ready
    const count = decoder.tracks.selectedTrack?.frameCount ?? info.frames
    for (let index = 0; index < count; index += 1) {
      const { image } = await decoder.decode({ frameIndex: index })
      try {
        frames.push(await createImageBitmap(image))
        delaysMs.push(playedDelayMs(image.duration, info.delaysMs[index] ?? 100))
      } finally {
        image.close()
      }
    }
    return { frames, delaysMs }
  } catch (error) {
    for (const frame of frames) frame.close()
    throw error
  } finally {
    decoder.close()
  }
}

async function encodeFramePng(frame: ImageBitmap): Promise<Blob | undefined> {
  if (typeof document === 'undefined') return undefined
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const context = canvas.getContext('2d')
  if (context === null) return undefined
  context.drawImage(frame, 0, 0)
  return new Promise(resolve => { canvas.toBlob(result => { resolve(result ?? undefined) }, 'image/png') })
}

/**
 * Paint one composited frame on the stage canvas. The canvas is cleared first:
 * a frame can hold transparent pixels after disposal compositing, and
 * source-over would leave the previous frame showing through them. A bitmap
 * released between render and effect has zero size; drawing it would throw,
 * so it is skipped.
 */
export function paintGifFrame(canvas: HTMLCanvasElement, frame: ImageBitmap): void {
  if (frame.width === 0) return
  const context = canvas.getContext('2d')
  if (context === null) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(frame, 0, 0)
}

/** Own a player for the current GIF blob; a new blob replaces and disposes the previous player. */
export function useGifPlayer(blob: Blob | undefined): GifPlayer | undefined {
  const [player, setPlayer] = useState<GifPlayer>()
  useEffect(() => {
    if (blob === undefined) {
      setPlayer(undefined)
      return
    }
    const next = createGifPlayer(blob)
    setPlayer(next)
    return () => { next.dispose() }
  }, [blob])
  return player
}

const noSubscription = () => () => {}

/** Status alone, so the card re-renders on readiness rather than on every frame. */
export function useGifStatus(player: GifPlayer | undefined): GifPlayerStatus | undefined {
  const status = () => player?.getSnapshot().status
  return useSyncExternalStore(player?.subscribe ?? noSubscription, status, status)
}

export function useGifSpeed(player: GifPlayer | undefined): GifSpeed | undefined {
  const speed = () => player?.getSnapshot().speed
  return useSyncExternalStore(player?.subscribe ?? noSubscription, speed, speed)
}

/** The frame on screen for a view that follows it; while not enabled it reads 0, so the card is not re-rendered on every frame. */
export function useGifIndex(player: GifPlayer | undefined, enabled: boolean): number {
  const index = () => enabled ? player?.getSnapshot().index ?? 0 : 0
  return useSyncExternalStore(player?.subscribe ?? noSubscription, index, () => 0)
}

function useGifSnapshot(player: GifPlayer): GifPlayerSnapshot {
  return useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot)
}

interface GifStageProps {
  player: GifPlayer
  /** The card and the lightbox are separate stages of one player. */
  stage: 'card' | 'lightbox'
  className: string
  alt: string
  /** Still image for a paused player without frames (re-decoding after a scroll), instead of the natively animating GIF. */
  poster?: string | undefined
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onDragStart?: (event: DragEvent<HTMLElement>) => void
}

/** Paints the current frame on a canvas once decoded; the raw GIF plays in an <img> until then or when decoding is not possible. */
export function GifStage({ player, stage, className, alt, poster, onClick, onDragStart }: GifStageProps) {
  const snapshot = useGifSnapshot(player)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Observe the wrapper, not the media element: the <img> and the <canvas>
  // swap with the status, and losing the observed element would read as
  // leaving the viewport and release the frames just decoded.
  useEffect(() => {
    const element = stageRef.current
    if (element === null) return
    if (typeof IntersectionObserver === 'undefined') {
      player.setVisible(stage, true)
      return () => { player.setVisible(stage, false) }
    }
    const observer = new IntersectionObserver(entries => {
      player.setVisible(stage, entries.some(entry => entry.isIntersecting))
    }, { rootMargin: VISIBILITY_MARGIN })
    observer.observe(element)
    return () => {
      observer.disconnect()
      player.setVisible(stage, false)
    }
  }, [player, stage])

  const frame = snapshot.status === 'ready' ? snapshot.frames[snapshot.index] : undefined
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || frame === undefined) return
    paintGifFrame(canvas, frame)
  }, [frame])

  const first = snapshot.frames[0]
  // A canvas is not draggable by default; an <img> is, so it keeps its default when no handler is given.
  const draggable = onDragStart === undefined ? undefined : true
  const still = !snapshot.playing && snapshot.status !== 'fallback' ? poster : undefined
  return <div ref={stageRef} className="dsh-ig-gif-stage">
    {frame !== undefined && first !== undefined
      ? <canvas ref={canvasRef} className={className} width={first.width} height={first.height} role="img" aria-label={alt} draggable={draggable} onClick={onClick} onDragStart={onDragStart} />
      : <img className={className} src={still ?? player.url} alt={alt} draggable={draggable} onClick={onClick} onDragStart={onDragStart} />}
  </div>
}

interface GifControlsProps {
  player: GifPlayer
  variant: 'card' | 'lightbox'
  t: (key: DictKey, params?: Record<string, string>) => string
  onDownloadGif: () => void
  onDownloadFrame: () => void
  /** The lightbox has no hover toolbar, so it carries the frame copy as a text button. */
  onCopyFrame?: () => void
  toast?: string | undefined
}

/**
 * Play/pause, frame scrubber, counter, speed, GIF download and frame download.
 * The bar is in place from the first render, so the card does not grow when
 * decoding finishes; frame controls stay disabled until frames exist, while
 * the speed and the GIF download work without them. The speed waits only for
 * the file's bytes, which a download named after the speed must retime.
 */
export function GifControls({ player, variant, t, onDownloadGif, onDownloadFrame, onCopyFrame, toast }: GifControlsProps) {
  const snapshot = useGifSnapshot(player)
  const ready = snapshot.status === 'ready'
  const speedReady = snapshot.info !== undefined
  const total = snapshot.frames.length || snapshot.info?.frames || 0
  const current = String(Math.min(snapshot.index, Math.max(total - 1, 0)) + 1)
  const playLabel = snapshot.playing ? t('gifPause') : t('gifPlay')
  const downloadLabel = gifDownloadLabel(t, snapshot.speed)
  const bar = <div className="dsh-ig-gif-bar" title={snapshot.status === 'fallback' ? t('gifControlsUnavailable') : undefined}>
    <button type="button" className="dsh-ig-gif-btn" aria-label={playLabel} title={playLabel} disabled={!ready} onClick={() => { player.toggle() }}>
      {snapshot.playing
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
        : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 7 4.5z" /></svg>}
    </button>
    <input
      type="range"
      className="dsh-ig-gif-scrub"
      min={0}
      max={Math.max(total - 1, 0)}
      step={1}
      value={snapshot.index}
      disabled={!ready}
      aria-label={t('gifFrames')}
      aria-valuetext={t('gifFrameOf', { current, total: String(total) })}
      onChange={event => { player.seek(Number(event.target.value)) }}
    />
    <span className="dsh-ig-gif-counter">{total > 0 ? `${current}/${String(total)}` : '…'}</span>
    <div className="dsh-ig-gif-speed" role="group" aria-label={t('gifSpeed')}>
      {GIF_SPEEDS.map(speed => <button key={speed} type="button" aria-pressed={snapshot.speed === speed} disabled={!speedReady} onClick={() => { player.setSpeed(speed) }}>{speed}×</button>)}
    </div>
    <button type="button" className="dsh-ig-gif-btn dsh-ig-gif-btn-file" aria-label={downloadLabel} title={downloadLabel} onClick={onDownloadGif}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
      <span>GIF{snapshot.speed === 1 ? '' : ` ${String(snapshot.speed)}×`}</span>
    </button>
    <button type="button" className="dsh-ig-gif-btn" aria-label={t('gifDownloadFrame')} title={t('gifDownloadFrame')} disabled={!ready} onClick={onDownloadFrame}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6" /><circle cx="9" cy="9" r="2" /><path d="m21 14-3.1-3.1a2 2 0 0 0-2.8 0L7 21" /><path d="M19 16v6" /><path d="m22 19-3 3-3-3" /></svg>
    </button>
  </div>
  if (variant === 'card') return bar
  return <div className="dsh-ig-lightbox-bottombar dsh-ig-lightbox-gif-bar" onClick={event => { event.stopPropagation() }}>
    {bar}
    <div className="dsh-ig-lightbox-actions">
      {onCopyFrame !== undefined ? <button type="button" className="dsh-ig-lightbox-btn" disabled={!ready} onClick={onCopyFrame}>{t('gifCopyFrame')}</button> : null}
      {toast !== undefined ? <span className="dsh-ig-lightbox-gif-toast" role="status">{toast}</span> : null}
    </div>
  </div>
}
