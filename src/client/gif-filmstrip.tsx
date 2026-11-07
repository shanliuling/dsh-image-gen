import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { GifT } from './gif-i18n.js'
import { useGifSnapshot, type GifPlayer } from './gif-player.js'

/** The frame under a pointer: one equal cell per frame across the strip; the ends hold outside it. */
export function filmstripFrameAt(x: number, width: number, total: number): number {
  if (total <= 0 || width <= 0) return 0
  return Math.min(total - 1, Math.max(0, Math.floor(x / width * total)))
}

/** The centred source rectangle that fills a cell without stretching the frame. */
export function coverCrop(frameW: number, frameH: number, cellW: number, cellH: number): { sx: number; sy: number; sw: number; sh: number } {
  const scale = Math.max(cellW / frameW, cellH / frameH)
  const sw = cellW / scale
  const sh = cellH / scale
  return { sx: (frameW - sw) / 2, sy: (frameH - sh) / 2, sw, sh }
}

function paintStrip(canvas: HTMLCanvasElement, frames: readonly ImageBitmap[], width: number, height: number): void {
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const context = canvas.getContext('2d')
  if (context === null) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  const cell = canvas.width / frames.length
  frames.forEach((frame, index) => {
    // A bitmap released between render and effect has zero size; drawing it would throw.
    if (frame.width === 0) return
    const x = Math.round(index * cell)
    const w = Math.round((index + 1) * cell) - x
    const { sx, sy, sw, sh } = coverCrop(frame.width, frame.height, w, canvas.height)
    context.drawImage(frame, sx, sy, sw, sh, x, 0, w, canvas.height)
  })
}

/**
 * The frame timeline, as ChatGPT draws it: every frame in an equal cell and a
 * playhead on the current one. Hovering previews a frame on the stage without
 * changing play state; a press stops on it, and a drag keeps choosing. Keys
 * are handled here and kept from the page, whose arrows turn gallery pages.
 */
export function GifFilmstrip({ player, t, hint, marks }: { player: GifPlayer; t: GifT; hint?: string | undefined; marks?: ReadonlySet<number> | undefined }) {
  const snapshot = useGifSnapshot(player)
  const stripRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ width: number; height: number }>()
  const ready = snapshot.status === 'ready'
  const total = snapshot.frames.length || snapshot.info?.frames || 0
  const index = Math.min(snapshot.index, Math.max(total - 1, 0))

  useEffect(() => {
    const element = stripRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || size === undefined || snapshot.frames.length === 0) return
    paintStrip(canvas, snapshot.frames, size.width, size.height)
  }, [snapshot.frames, size])

  // A strip that unmounts under the pointer (Escape closes the lightbox) gets
  // no pointerleave; the shared player would stay frozen on the hovered frame.
  useEffect(() => () => { player.endScrub() }, [player])

  const frameAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return filmstripFrameAt(event.clientX - rect.left, rect.width, total)
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready) return
    event.currentTarget.setPointerCapture(event.pointerId)
    player.seek(frameAt(event))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) player.seek(frameAt(event))
    else if (event.pointerType === 'mouse') player.scrub(frameAt(event))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ready) return
    const actions: Record<string, () => void> = {
      ArrowLeft: () => { player.step(-1) },
      ArrowRight: () => { player.step(1) },
      Home: () => { player.first() },
      End: () => { player.last() },
      ' ': () => { player.toggle() },
    }
    const action = actions[event.key]
    if (action === undefined) return
    event.preventDefault()
    event.stopPropagation()
    action()
  }

  return <div
    ref={stripRef}
    className="dsh-ig-gif-strip"
    role="slider"
    tabIndex={ready ? 0 : -1}
    aria-disabled={!ready}
    aria-label={t('gifFrames')}
    aria-valuemin={1}
    aria-valuemax={Math.max(total, 1)}
    aria-valuenow={index + 1}
    aria-valuetext={t('gifFrameOf', { current: String(index + 1), total: String(total) })}
    title={hint ?? t('gifStripHint')}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerLeave={() => { player.endScrub() }}
    onPointerCancel={() => { player.endScrub() }}
    onKeyDown={onKeyDown}
  >
    <canvas ref={canvasRef} aria-hidden="true" />
    {total > 0 ? [...marks ?? []].filter(frame => frame < total).map(frame => <span key={frame} className="dsh-ig-gif-strip-mark" aria-hidden="true" style={{ left: `${String((frame + 0.5) / total * 100)}%` }} />) : null}
    {ready && total > 0 ? <span className="dsh-ig-gif-strip-head" aria-hidden="true" style={{ left: `${String((index + 0.5) / total * 100)}%` }} /> : null}
  </div>
}
