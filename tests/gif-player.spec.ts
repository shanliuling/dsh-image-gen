import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  DECODE_TOTAL_BUDGET_BYTES,
  createGifPlayer,
  gifKeyboardAction,
  nextFrameIndex,
  paintGifFrame,
  playedDelayMs,
  formatSpeed,
  scheduledDelayMs,
  snapSpeed,
  speedSuffix,
  withinDecodeBudget,
  type GifPlayer,
  type GifPlayerDeps,
} from '../src/client/gif-player.js'
import { GifPlayerBar } from '../src/client/gif-controls.js'
import { GIF_TEXT, gifT } from '../src/client/gif-i18n.js'
import { gifBytes } from './gif-fixture.js'

const MB = 1024 * 1024

describe('GIF player arithmetic', () => {
  it('wraps the frame index in both directions', () => {
    expect(nextFrameIndex(7, 8)).toBe(0)
    expect(nextFrameIndex(0, 8)).toBe(1)
    expect(nextFrameIndex(0, 8, -1)).toBe(7)
    expect(nextFrameIndex(3, 8, -1)).toBe(2)
  })

  it('scales the frame delay by the speed with a 20 ms floor', () => {
    expect(scheduledDelayMs(120, 2)).toBe(60)
    expect(scheduledDelayMs(30, 2)).toBe(20)
    expect(scheduledDelayMs(120, 0.5)).toBe(240)
    expect(scheduledDelayMs(0, 1)).toBe(20)
  })

  it('rounds the scheduled delay to the 10 ms ticks a downloaded GIF stores, so preview and file play alike', () => {
    expect(scheduledDelayMs(100, 1.3)).toBe(80)
    expect(scheduledDelayMs(120, 0.7)).toBe(170)
  })

  it('keeps a playback speed to one decimal within 0.2x-2x and prints it without float noise', () => {
    expect(snapSpeed(1.26)).toBe(1.3)
    expect(snapSpeed(0.05)).toBe(0.2)
    expect(snapSpeed(2.4)).toBe(2)
    expect(snapSpeed(Number.NaN)).toBe(1)
    expect(formatSpeed(1.2000000000000002)).toBe('1.2')
    expect(formatSpeed(2)).toBe('2')
    expect(formatSpeed(0.5)).toBe('0.5')
  })

  it('names downloads after a non-default speed only', () => {
    expect(speedSuffix(1)).toBe('')
    expect(speedSuffix(2)).toBe('-2x')
    expect(speedSuffix(0.5)).toBe('-0.5x')
    expect(speedSuffix(1.3)).toBe('-1.3x')
  })

  it('judges the decode budget from the header before anything is decoded', () => {
    expect(withinDecodeBudget({ frames: 16, width: 1024, height: 1024 }, 0)).toBe(true)
    expect(withinDecodeBudget({ frames: 600, width: 16, height: 16 }, 0)).toBe(false)
    expect(withinDecodeBudget({ frames: 40, width: 2048, height: 2048 }, 0)).toBe(false)
    expect(withinDecodeBudget({ frames: 8, width: 768, height: 768 }, 250 * MB)).toBe(false)
    // A header without a logical screen size cannot be budgeted; such a GIF plays natively.
    expect(withinDecodeBudget({ frames: 8, width: 0, height: 0 }, 0)).toBe(false)
  })

  it('plays a decoded frame for the browser\'s own duration and applies the 100 ms rule to very short delays either way', () => {
    expect(playedDelayMs(120_000, 0)).toBe(120)
    expect(playedDelayMs(10_000, 10)).toBe(100)
    expect(playedDelayMs(null, 10)).toBe(100)
    expect(playedDelayMs(null, 120)).toBe(120)
    expect(playedDelayMs(0, 50)).toBe(50)
  })

  it('leaves a focused control the keys it handles itself and takes the rest', () => {
    const button = { tagName: 'BUTTON' }
    const range = { tagName: 'INPUT', type: 'range' }
    expect(gifKeyboardAction(' ', null)).toBe('toggle')
    expect(gifKeyboardAction('ArrowRight', { tagName: 'BODY' })).toBe('next')
    expect(gifKeyboardAction('ArrowLeft', button)).toBe('previous')
    expect(gifKeyboardAction('Home', button)).toBe('first')
    expect(gifKeyboardAction('End', button)).toBe('last')
    expect(gifKeyboardAction(' ', button)).toBeUndefined()
    expect(gifKeyboardAction('Enter', button)).toBeUndefined()
    expect(gifKeyboardAction(' ', range)).toBe('toggle')
    expect(gifKeyboardAction('ArrowRight', range)).toBeUndefined()
    expect(gifKeyboardAction('Home', range)).toBeUndefined()
    for (const field of [{ tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'text' }]) {
      expect(gifKeyboardAction(' ', field)).toBeUndefined()
      expect(gifKeyboardAction('ArrowRight', field)).toBeUndefined()
    }
    expect(gifKeyboardAction('a', null)).toBeUndefined()
  })
})

/** Frames the fake decoder hands out; `close` is what the player must call on release. */
function fakeFrame(width = 16, height = 8): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap
}

interface Harness {
  player: GifPlayer
  deps: GifPlayerDeps
  decoded: () => ImageBitmap[]
  /** Delays of the timers currently armed by the player; at most one is expected. */
  pending: () => number[]
  /** Run the armed timer, as the browser would after its delay. */
  fire: () => void
  hidden: { value: boolean }
}

function harness(options: { frames?: number; width?: number; height?: number; decode?: GifPlayerDeps['decode'] } = {}): Harness {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextTimer = 1
  let decoded: ImageBitmap[] = []
  const hidden = { value: false }
  const frames = options.frames ?? 3
  const deps: GifPlayerDeps = {
    decode: options.decode ?? vi.fn(async () => {
      decoded = Array.from({ length: frames }, () => fakeFrame(options.width, options.height))
      return { frames: decoded, delaysMs: decoded.map(() => 100) }
    }),
    encodeFrame: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    hidden: () => hidden.value,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
  }
  const player = createGifPlayer(new Blob([gifBytes(frames, 10, options.width, options.height)], { type: 'image/gif' }), deps)
  return {
    player, deps, hidden,
    decoded: () => decoded,
    pending: () => [...timers.values()].map(timer => timer.ms),
    fire: () => {
      const [id, timer] = [...timers.entries()][0]!
      timers.delete(id)
      timer.fn()
    },
  }
}

const ready = (player: GifPlayer) => vi.waitFor(() => { expect(player.getSnapshot().status).toBe('ready') })
const closedCount = (frames: ImageBitmap[]) => frames.filter(frame => vi.mocked(frame.close).mock.calls.length > 0).length

describe('GIF player store', () => {
  it('starts with native playback and decodes only once a stage becomes visible', async () => {
    const h = harness()
    expect(h.player.getSnapshot()).toMatchObject({ status: 'native', index: 0, playing: true, speed: 1 })
    expect(h.deps.decode).not.toHaveBeenCalled()
    h.player.setVisible('card', true)
    await ready(h.player)
    expect(h.deps.decode).toHaveBeenCalledTimes(1)
    expect(h.player.getSnapshot().frames).toHaveLength(3)
    expect(h.player.getSnapshot().info).toMatchObject({ frames: 3, width: 16, height: 8 })
    expect(h.pending()).toEqual([100])
    h.player.dispose()
  })

  it('advances by the scheduled delay and applies a speed change to the next tick without re-decoding', async () => {
    const h = harness()
    h.player.setVisible('card', true)
    await ready(h.player)
    h.fire()
    expect(h.player.getSnapshot().index).toBe(1)
    h.player.setSpeed(2)
    h.fire()
    expect(h.player.getSnapshot().index).toBe(2)
    expect(h.pending()).toEqual([50])
    h.player.setSpeed(0.5)
    h.fire()
    expect(h.player.getSnapshot().index).toBe(0)
    expect(h.pending()).toEqual([200])
    expect(h.deps.decode).toHaveBeenCalledTimes(1)
    h.player.dispose()
  })

  it('previews a frame while scrubbing without changing play state, then resumes the clock', async () => {
    const h = harness()
    h.player.setVisible('card', true)
    await ready(h.player)
    h.player.scrub(2)
    expect(h.player.getSnapshot()).toMatchObject({ index: 2, playing: true, scrubbing: true })
    // The clock holds while the pointer is over the strip.
    expect(h.pending()).toEqual([])
    h.player.scrub(1)
    expect(h.player.getSnapshot().index).toBe(1)
    h.player.endScrub()
    expect(h.player.getSnapshot()).toMatchObject({ index: 1, playing: true, scrubbing: false })
    expect(h.pending()).toEqual([100])
    // A paused player returns to the frame it was paused on; the preview only looked.
    h.player.pause()
    h.player.scrub(0)
    h.player.endScrub()
    expect(h.player.getSnapshot()).toMatchObject({ index: 1, playing: false })
    expect(h.pending()).toEqual([])
    // A click while scrubbing chooses the frame that stays.
    h.player.scrub(2)
    h.player.seek(2)
    h.player.scrub(0)
    h.player.endScrub()
    expect(h.player.getSnapshot()).toMatchObject({ index: 2, playing: false, scrubbing: false })
    h.player.dispose()
  })

  it('pauses on seek and step, wraps around, and resumes from the chosen frame', async () => {
    const h = harness()
    h.player.setVisible('card', true)
    await ready(h.player)
    h.player.seek(2)
    expect(h.player.getSnapshot()).toMatchObject({ index: 2, playing: false })
    expect(h.pending()).toEqual([])
    h.player.step(1)
    expect(h.player.getSnapshot().index).toBe(0)
    h.player.step(-1)
    expect(h.player.getSnapshot().index).toBe(2)
    h.player.first()
    expect(h.player.getSnapshot().index).toBe(0)
    h.player.last()
    expect(h.player.getSnapshot().index).toBe(2)
    h.player.toggle()
    expect(h.player.getSnapshot().playing).toBe(true)
    expect(h.pending()).toEqual([100])
    h.player.toggle()
    expect(h.player.getSnapshot().playing).toBe(false)
    expect(h.pending()).toEqual([])
    h.player.dispose()
  })

  it('releases the frames when every stage has left the viewport and restores the same frame on return', async () => {
    const h = harness()
    h.player.setVisible('card', true)
    h.player.setVisible('lightbox', true)
    await ready(h.player)
    const first = h.decoded()
    h.player.seek(1)
    h.player.setVisible('lightbox', false)
    expect(h.player.getSnapshot().status).toBe('ready')
    h.player.setVisible('card', false)
    expect(h.player.getSnapshot()).toMatchObject({ status: 'native', index: 1, frames: [] })
    expect(closedCount(first)).toBe(3)
    expect(h.pending()).toEqual([])
    h.player.setVisible('card', true)
    await ready(h.player)
    expect(h.deps.decode).toHaveBeenCalledTimes(2)
    expect(h.player.getSnapshot()).toMatchObject({ index: 1, playing: false })
    h.player.dispose()
    expect(closedCount(h.decoded())).toBe(3)
  })

  it('falls back to native playback when decoding is unsupported, fails, or would exceed the budget', async () => {
    const unsupported = harness({ decode: vi.fn(async () => undefined) })
    unsupported.player.setVisible('card', true)
    await vi.waitFor(() => { expect(unsupported.player.getSnapshot().status).toBe('fallback') })
    unsupported.player.setVisible('card', false)
    unsupported.player.setVisible('card', true)
    expect(unsupported.deps.decode).toHaveBeenCalledTimes(1)
    unsupported.player.dispose()

    const failing = harness({ decode: vi.fn(async () => { throw new Error('boom') }) })
    failing.player.setVisible('card', true)
    await vi.waitFor(() => { expect(failing.player.getSnapshot().status).toBe('fallback') })
    failing.player.dispose()

    const oversized = harness({ frames: 600 })
    oversized.player.setVisible('card', true)
    await vi.waitFor(() => { expect(oversized.player.getSnapshot().status).toBe('fallback') })
    expect(oversized.deps.decode).not.toHaveBeenCalled()
    oversized.player.dispose()
  })

  it('counts decoded bitmaps across players against the shared budget and decodes a waiting visible player as soon as another releases its share', async () => {
    const perPlayer = 16 * 1024 * 1024 * 4
    const count = DECODE_TOTAL_BUDGET_BYTES / perPlayer
    const players = Array.from({ length: count }, () => harness({ frames: 16, width: 1024, height: 1024 }))
    for (const h of players) {
      h.player.setVisible('card', true)
      await ready(h.player)
    }
    const waiting = harness({ frames: 16, width: 1024, height: 1024 })
    const scrolledAway = harness({ frames: 16, width: 1024, height: 1024 })
    for (const h of [waiting, scrolledAway]) {
      h.player.setVisible('card', true)
      await vi.waitFor(() => { expect(h.player.getSnapshot().info).toBeDefined() })
      // Over budget only because of the others: stays native (not a terminal fallback) and keeps the decoder idle.
      expect(h.player.getSnapshot().status).toBe('native')
      expect(h.deps.decode).not.toHaveBeenCalled()
    }
    scrolledAway.player.setVisible('card', false)
    // No visibility event reaches the waiting player; the released budget alone must wake it.
    players[0]!.player.dispose()
    await ready(waiting.player)
    expect(waiting.deps.decode).toHaveBeenCalledTimes(1)
    expect(scrolledAway.deps.decode).not.toHaveBeenCalled()
    players[1]!.player.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(scrolledAway.deps.decode).not.toHaveBeenCalled()
    scrolledAway.player.setVisible('card', true)
    await ready(scrolledAway.player)
    for (const h of [...players, waiting, scrolledAway]) h.player.dispose()
  })

  it('clears the canvas before painting a frame, so transparent pixels do not show the previous frame', () => {
    const context = { clearRect: vi.fn(), drawImage: vi.fn() }
    const canvas = { width: 16, height: 8, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement
    const frame = fakeFrame()
    paintGifFrame(canvas, frame)
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 16, 8)
    expect(context.drawImage).toHaveBeenCalledWith(frame, 0, 0)
    expect(context.clearRect.mock.invocationCallOrder[0]!).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]!)
    // A bitmap released between render and effect has zero size; nothing is painted or cleared.
    paintGifFrame(canvas, fakeFrame(0, 0))
    expect(context.clearRect).toHaveBeenCalledTimes(1)
    expect(context.drawImage).toHaveBeenCalledTimes(1)
  })

  it('does not tick while the document is hidden and resumes when asked again', async () => {
    const h = harness()
    h.hidden.value = true
    h.player.setVisible('card', true)
    await ready(h.player)
    expect(h.pending()).toEqual([])
    h.hidden.value = false
    h.player.setVisible('card', true)
    expect(h.pending()).toEqual([100])
    h.player.dispose()
  })

  it('captures the frame on screen as PNG without changing playback, and captures nothing before frames exist', async () => {
    const h = harness()
    await expect(h.player.captureFrame()).resolves.toBeUndefined()
    h.player.setVisible('card', true)
    await ready(h.player)
    h.fire()
    expect(h.player.getSnapshot()).toMatchObject({ index: 1, playing: true })
    const blob = await h.player.captureFrame()
    expect(blob?.type).toBe('image/png')
    expect(h.deps.encodeFrame).toHaveBeenCalledWith(h.decoded()[1])
    // A card has no play button to resume with, so capturing leaves playback alone.
    expect(h.player.getSnapshot()).toMatchObject({ index: 1, playing: true })
    expect(h.pending()).toHaveLength(1)
    h.player.dispose()
  })

  it('stops the clock, closes the frames and ignores visibility after disposal', async () => {
    const h = harness()
    h.player.setVisible('card', true)
    await ready(h.player)
    h.player.dispose()
    expect(h.pending()).toEqual([])
    expect(closedCount(h.decoded())).toBe(3)
    h.player.setVisible('card', true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.deps.decode).toHaveBeenCalledTimes(1)
  })
})

describe('GIF player bar', () => {
  const render = (player: GifPlayer, lang: 'zh' | 'en' = 'zh') => renderToStaticMarkup(createElement(GifPlayerBar, { player, t: gifT(lang) }))
  const labels = (markup: string) => [...markup.matchAll(/aria-label="([^"]+)"/g)].map(match => match[1])
  const disabledLabels = (markup: string) => [...markup.matchAll(/<(?:button|div)[^>]*?aria-label="([^"]+)"[^>]*?disabled=""/g)].map(match => match[1])

  it('labels every control in both languages once frames are decoded', async () => {
    const h = harness()
    h.player.setVisible('lightbox', true)
    await ready(h.player)
    const zh = render(h.player)
    expect(labels(zh)).toEqual(['GIF 播放控制', '暂停 GIF', 'GIF 帧', '播放速度 1×'])
    expect(zh).toContain('aria-valuetext="第 1 帧，共 3 帧"')
    expect(zh).toContain(`title="${GIF_TEXT.zh.gifStripHint}"`)
    expect(disabledLabels(zh)).toEqual([])
    expect(zh).toContain('aria-disabled="false"')
    h.player.setSpeed(1.3)
    const en = render(h.player, 'en')
    expect(labels(en)).toEqual(['GIF playback controls', 'Pause GIF', 'GIF frames', 'Playback speed 1.3×'])
    expect(en).toContain('aria-valuetext="Frame 1 of 3"')
    h.player.pause()
    expect(labels(render(h.player))[1]).toBe('播放 GIF')
    h.player.dispose()
  })

  it('offers the speed once the file bytes are read and the frame controls once frames are decoded', async () => {
    const h = harness()
    expect(disabledLabels(render(h.player))).toEqual(['暂停 GIF', '播放速度 1×'])
    await vi.waitFor(() => { expect(h.player.getSnapshot().info).toBeDefined() })
    // Bytes read, frames not decoded: a speed-named download is already the retimed file.
    expect(h.player.getSnapshot().status).toBe('native')
    const pending = render(h.player)
    expect(disabledLabels(pending)).toEqual(['暂停 GIF'])
    expect(pending).toContain('aria-disabled="true"')
    expect(pending).toContain('aria-valuetext="第 1 帧，共 3 帧"')
    h.player.dispose()
  })

  it('explains a fallback on the bar and keeps its frame controls off', async () => {
    const h = harness({ decode: vi.fn(async () => undefined) })
    expect(render(h.player)).not.toContain(GIF_TEXT.zh.gifControlsUnavailable)
    h.player.setVisible('lightbox', true)
    await vi.waitFor(() => { expect(h.player.getSnapshot().status).toBe('fallback') })
    const fallback = render(h.player)
    expect(fallback).toContain(`title="${GIF_TEXT.zh.gifControlsUnavailable}"`)
    expect(disabledLabels(fallback)).toEqual(['暂停 GIF'])
    h.player.dispose()
  })
})
