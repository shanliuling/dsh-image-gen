import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImageThumbnail } from '../src/client/browser-image-utils.js'

afterEach(() => vi.unstubAllGlobals())

describe('browser thumbnail encoding', () => {
  it('uses DOM Canvas when OffscreenCanvas is unavailable', async () => {
    const original = new Blob(['original'], { type: 'image/png' })
    const thumb = new Blob(['thumbnail'], { type: 'image/webp' })
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', async () => ({ width: 320, height: 180, close }))
    vi.stubGlobal('OffscreenCanvas', undefined)
    vi.stubGlobal('document', { createElement: () => ({
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (done: (value: Blob) => void) => done(thumb),
    }) })
    expect(await createImageThumbnail(original, 320)).toBe(thumb)
    expect(close).toHaveBeenCalledOnce()
  })

  it('falls back to the original when decoding is unavailable', async () => {
    const original = new Blob(['original'], { type: 'image/png' })
    vi.stubGlobal('createImageBitmap', undefined)
    expect(await createImageThumbnail(original, 320)).toBe(original)
  })
})
