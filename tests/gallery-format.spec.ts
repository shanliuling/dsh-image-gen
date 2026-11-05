import { describe, expect, it } from 'vitest'
import { formatCardMeta, getItemRatio } from '../src/client/gallery-format.js'
import type { GalleryItem } from '../src/client/gallery-store.js'

function imported(width: number, height: number): GalleryItem {
  return { id: 'import-photo', provider: 'import', model: '', prompt: '', createdAt: 1,
    attachment: { attachmentId: 'sha256:photo', mediaType: 'image/jpeg', bytes: 10, width, height } }
}

describe('gallery ratios and metadata for imported images', () => {
  it.each([
    [1200, 1800, '2:3'], [1800, 1200, '3:2'], [1080, 1920, '9:16'],
    [1920, 1080, '16:9'], [1200, 1600, '3:4'], [1600, 1200, '4:3'],
    [1024, 1024, '1:1'], [2000, 1100, '16:9'], [10000, 100, 'custom'],
  ] as const)('filters %i by %i by its actual %s ratio', (width, height, ratio) => {
    expect(getItemRatio(imported(width, height))).toBe(ratio)
    expect(formatCardMeta(imported(width, height))).toBe(`${width}×${height}`)
  })

  it('uses actual imported dimensions even if old requested metadata says square', () => {
    const image = { ...imported(1200, 1800), aspectRatio: '1:1', output: '1024x1024' }
    expect(getItemRatio(image)).toBe('2:3')
    expect(formatCardMeta(image)).toBe('1200×1800')
  })

  it.each([[0, 1800], [1200, 0], [-1, 1800], [NaN, 1800], [1200, Infinity]])('keeps the legacy metadata fallback for invalid dimensions (%s, %s)', (width, height) => {
    const image = { ...imported(width, height), aspectRatio: '3:2' }
    expect(getItemRatio(image)).toBe('3:2')
    expect(formatCardMeta(image)).toBe('3:2')
  })

  it('preserves declared ratios for other providers', () => {
    const image = { ...imported(1200, 1800), provider: 'google' as const, aspectRatio: '1:1' }
    expect(getItemRatio(image)).toBe('1:1')
    expect(formatCardMeta(image)).toBe('1:1')
  })

  it('preserves actual-dimension filtering for ChatGPT subscription outputs', () => {
    expect(getItemRatio({ ...imported(1536, 1024), provider: 'chatgpt-sub', aspectRatio: '1:1' })).toBe('3:2')
  })
})
