import { describe, expect, it } from 'vitest'
import { readGifInfo } from '../src/gif-info.js'

interface FrameSpec {
  /** Graphic Control Extension delay in centiseconds; omitted means no GCE at all. */
  delayCs?: number
  /** Raw LZW sub-block payload; defaults to a few arbitrary bytes. */
  data?: number[]
  localColors?: boolean
}

function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff]
}

/** Smallest GIF89a layout that exercises every block kind the reader must walk. */
function gifBytes(options: { frames: FrameSpec[]; extensions?: number[][]; trailer?: boolean }): Uint8Array {
  const bytes: number[] = [
    ...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    ...le16(16), ...le16(8),
    0x80, 0x00, 0x00, // global colour table of 2 entries
    0, 0, 0, 255, 255, 255,
  ]
  for (const extension of options.extensions ?? []) bytes.push(...extension)
  for (const frame of options.frames) {
    if (frame.delayCs !== undefined) bytes.push(0x21, 0xf9, 0x04, 0x00, ...le16(frame.delayCs), 0x00, 0x00)
    bytes.push(0x2c, ...le16(0), ...le16(0), ...le16(16), ...le16(8), frame.localColors ? 0x80 : 0x00)
    if (frame.localColors) bytes.push(1, 2, 3, 4, 5, 6)
    const data = frame.data ?? [0x44, 0x01]
    bytes.push(0x02, data.length, ...data, 0x00)
  }
  if (options.trailer !== false) bytes.push(0x3b)
  return Uint8Array.from(bytes)
}

const netscapeLoop = [0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', char => char.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00]
const comment = [0x21, 0xfe, 0x05, ...Array.from('hello', char => char.charCodeAt(0)), 0x00]

describe('readGifInfo', () => {
  it('counts frames and converts each delay from centiseconds', () => {
    expect(readGifInfo(gifBytes({ frames: [{ delayCs: 10 }, { delayCs: 20 }] }))).toEqual({ frames: 2, delaysMs: [100, 200] })
    expect(readGifInfo(gifBytes({ frames: Array.from({ length: 8 }, () => ({ delayCs: 12 })) })))
      .toEqual({ frames: 8, delaysMs: Array.from({ length: 8 }, () => 120) })
  })

  it('walks application and comment extensions and local colour tables without miscounting', () => {
    const info = readGifInfo(gifBytes({ extensions: [netscapeLoop, comment], frames: [{ delayCs: 5, localColors: true }, { delayCs: 5 }] }))
    expect(info).toMatchObject({ frames: 2, delaysMs: [50, 50] })
  })

  it('does not mistake a GCE-looking byte pattern inside LZW data for a frame', () => {
    const fake = [0x21, 0xf9, 0x04, 0x00, 0x64, 0x00, 0x00, 0x00, 0x2c, 0x00]
    expect(readGifInfo(gifBytes({ frames: [{ delayCs: 10, data: fake }, { delayCs: 10, data: fake }] })))
      .toMatchObject({ frames: 2, delaysMs: [100, 100] })
  })

  it('records a zero delay for a frame without a Graphic Control Extension', () => {
    expect(readGifInfo(gifBytes({ frames: [{ delayCs: 10 }, {}, { delayCs: 30 }] }))).toMatchObject({ frames: 3, delaysMs: [100, 0, 300] })
  })

  it('still reports the frames of a GIF whose trailer byte is missing, as decoders do', () => {
    expect(readGifInfo(gifBytes({ frames: [{ delayCs: 10 }, { delayCs: 20 }], trailer: false }))).toEqual({ frames: 2, delaysMs: [100, 200] })
  })

  it('returns undefined for non-GIF, empty, truncated, frameless, or malformed input', () => {
    expect(readGifInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeUndefined()
    expect(readGifInfo(new Uint8Array())).toBeUndefined()
    const whole = gifBytes({ frames: [{ delayCs: 10 }, { delayCs: 10 }] })
    expect(readGifInfo(whole.subarray(0, 20))).toBeUndefined()
    // Cut inside the last frame's image data: the sub-block length runs past the end.
    expect(readGifInfo(whole.subarray(0, whole.length - 4))).toBeUndefined()
    expect(readGifInfo(gifBytes({ frames: [] }))).toBeUndefined()
    expect(readGifInfo(gifBytes({ frames: [], trailer: false }))).toBeUndefined()
    // A byte that is neither extension, image descriptor nor trailer where a block should start.
    expect(readGifInfo(gifBytes({ extensions: [[0x00]], frames: [{ delayCs: 10 }] }))).toBeUndefined()
  })
})
