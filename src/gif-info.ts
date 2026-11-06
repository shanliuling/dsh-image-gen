/**
 * Frame count, timing and size of a GIF, read from its block structure, plus
 * a speed change that rewrites only the frame delays: no decoding, no node
 * imports, so the browser bundle shares it.
 */

export interface GifInfo {
  frames: number
  /** Per-frame delay in milliseconds; 0 when a frame carries no Graphic Control Extension. */
  delaysMs: number[]
  /** Logical screen size from the header. */
  width: number
  height: number
}

/**
 * Read every frame's delay. Returns undefined for anything that is not a GIF
 * with at least one intact frame: callers only decorate a successful result
 * with these facts, so a parse failure must never fail the image.
 */
export function readGifInfo(bytes: Uint8Array): GifInfo | undefined {
  const delaysMs: number[] = []
  const intact = walkGif(bytes, delayMs => { delaysMs.push(delayMs) })
  return intact && delaysMs.length > 0
    ? { frames: delaysMs.length, delaysMs, width: u16(bytes, 6), height: u16(bytes, 8) }
    : undefined
}

/** The most common frame delay (the first one on a tie); 0 without frames. */
export function gifFrameDurationMs(delaysMs: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const delay of delaysMs) counts.set(delay, (counts.get(delay) ?? 0) + 1)
  let winner = delaysMs[0] ?? 0
  for (const [delay, count] of counts) if (count > (counts.get(winner) ?? 0)) winner = delay
  return winner
}

/**
 * Play a GIF faster or slower by rewriting the delay of every Graphic Control
 * Extension in place: same length, same pixels, so the result is still the
 * provider's file. 1x returns the input itself. A delay the browser treats as
 * "too short" (0 or 1 tick plays as 100 ms) is scaled from that effective
 * value, and the result never goes below 2 ticks, where it would fall back
 * into that same 100 ms rule and play slower instead of faster. Returns
 * undefined for anything the walker cannot trust, or a speed that is not a
 * positive number.
 */
export function retimeGif(bytes: Uint8Array, speed: number): Uint8Array | undefined {
  if (!(speed > 0) || !Number.isFinite(speed)) return undefined
  if (speed === 1) return bytes
  const offsets: number[] = []
  if (!walkGif(bytes, (_delayMs, delayOffset) => { if (delayOffset !== undefined) offsets.push(delayOffset) })) return undefined
  const out = Uint8Array.from(bytes)
  for (const offset of offsets) {
    const ticks = u16(bytes, offset)
    const effective = ticks <= 1 ? 10 : ticks
    const next = Math.min(65535, Math.max(2, Math.round(effective / speed)))
    out[offset] = next & 0xff
    out[offset + 1] = next >> 8
  }
  return out
}

/**
 * Walk the block sequence after the header and report each image descriptor
 * with the delay of the Graphic Control Extension that precedes it (and the
 * byte offset of that delay field, when there is one). The walk follows block
 * lengths instead of scanning for byte patterns because the LZW payload can
 * contain anything, including a fake `0x21 0xF9`. Returns true when every
 * block was intact: a missing trailer byte is tolerated, as decoders tolerate
 * it, but a cut block or an unknown block id is not.
 */
function walkGif(bytes: Uint8Array, onFrame: (delayMs: number, delayOffset: number | undefined) => void): boolean {
  if (bytes.length < 13) return false
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return false
  let offset = 13 + colorTableBytes(bytes[10]!)
  let pendingDelayMs = 0
  let pendingDelayOffset: number | undefined
  while (offset < bytes.length) {
    const block = bytes[offset]!
    if (block === 0x3b) return true
    if (block === 0x21) {
      const label = bytes[offset + 1]
      if (label === undefined) return false
      let cursor = offset + 2
      let first = true
      while (true) {
        const size = bytes[cursor]
        if (size === undefined) return false
        if (size === 0) break
        if (first && label === 0xf9 && size >= 3) {
          pendingDelayOffset = cursor + 2
          pendingDelayMs = u16(bytes, pendingDelayOffset) * 10
        }
        first = false
        cursor += 1 + size
      }
      offset = cursor + 1
      continue
    }
    if (block === 0x2c) {
      if (offset + 10 > bytes.length) return false
      let cursor = offset + 10 + colorTableBytes(bytes[offset + 9]!)
      cursor += 1 // LZW minimum code size
      while (true) {
        const size = bytes[cursor]
        if (size === undefined) return false
        if (size === 0) break
        cursor += 1 + size
      }
      onFrame(pendingDelayMs, pendingDelayOffset)
      pendingDelayMs = 0
      pendingDelayOffset = undefined
      offset = cursor + 1
      continue
    }
    return false
  }
  return true
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

/** Byte length of a colour table announced by a packed descriptor byte, 0 when absent. */
function colorTableBytes(packed: number): number {
  return (packed & 0x80) === 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1))
}
