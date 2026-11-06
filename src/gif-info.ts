/**
 * Frame count and timing of a GIF, read from its block structure: no decoding,
 * no node imports.
 */

interface GifInfo {
  frames: number
  /** Per-frame delay in milliseconds; 0 when a frame carries no Graphic Control Extension. */
  delaysMs: number[]
}

/**
 * Read every frame's delay. Returns undefined for anything that is not a GIF
 * with at least one intact frame: callers only decorate a successful result
 * with these facts, so a parse failure must never fail the image.
 */
export function readGifInfo(bytes: Uint8Array): GifInfo | undefined {
  const delaysMs: number[] = []
  const intact = walkGif(bytes, delayMs => { delaysMs.push(delayMs) })
  return intact && delaysMs.length > 0 ? { frames: delaysMs.length, delaysMs } : undefined
}

/**
 * Walk the block sequence after the header and report each image descriptor
 * with the delay of the Graphic Control Extension that precedes it. The walk
 * follows block lengths instead of scanning for byte patterns because the LZW
 * payload can contain anything, including a fake `0x21 0xF9`. Returns true
 * when every block was intact: a missing trailer byte is tolerated, as
 * decoders tolerate it, but a cut block or an unknown block id is not.
 */
function walkGif(bytes: Uint8Array, onFrame: (delayMs: number) => void): boolean {
  if (bytes.length < 13) return false
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return false
  let offset = 13 + colorTableBytes(bytes[10]!)
  let pendingDelayMs = 0
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
        if (first && label === 0xf9 && size >= 3) pendingDelayMs = u16(bytes, cursor + 2) * 10
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
      onFrame(pendingDelayMs)
      pendingDelayMs = 0
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
