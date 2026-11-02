import { describe, expect, it } from 'vitest'
import type { GalleryItem } from '../src/client/gallery-store.js'
import { mergeGalleryItems, sameGalleryItem } from '../src/client/gallery-merge.js'

function item(id: string, overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id,
    attachment: { attachmentId: 'sha256:' + id, mediaType: 'image/png', bytes: 100, width: 64, height: 64 },
    prompt: 'prompt ' + id,
    provider: 'openai',
    model: 'gpt-image-2.5',
    createdAt: 1,
    ...overrides,
  }
}

describe('mergeGalleryItems', () => {
  it('keeps every previous reference when nothing changed', () => {
    const prev = [item('a'), item('b')]
    const next = prev.map(entry => ({ ...entry }))
    const merged = mergeGalleryItems(prev, next)
    expect(merged[0]).toBe(prev[0])
    expect(merged[1]).toBe(prev[1])
  })

  it('replaces only the record whose favourite flag changed', () => {
    const prev = [item('a'), item('b')]
    const next = [prev[0]!, { ...prev[1]!, isFavorite: true }]
    const merged = mergeGalleryItems(prev, next)
    expect(merged[0]).toBe(prev[0])
    expect(merged[1]).not.toBe(prev[1])
    expect(merged[1]?.isFavorite).toBe(true)
  })

  it('replaces the record when any attachment field changes', () => {
    const prev = [item('a')]
    const next = [{ ...prev[0]!, attachment: { ...prev[0]!.attachment, bytes: 200 } }]
    const merged = mergeGalleryItems(prev, next)
    expect(merged[0]).not.toBe(prev[0])
  })

  it('replaces the record when tags or source attachments change', () => {
    const base = item('a', { tags: ['x'], sourceAttachmentIds: ['s1'] })
    expect(sameGalleryItem(base, { ...base, tags: ['x', 'y'] })).toBe(false)
    expect(sameGalleryItem(base, { ...base, sourceAttachmentIds: ['s2'] })).toBe(false)
    expect(sameGalleryItem(base, { ...base, tags: ['x'] })).toBe(true)
  })

  it('tracks additions, removals and order', () => {
    const prev = [item('a'), item('b')]
    const next = [item('b'), item('c')]
    const merged = mergeGalleryItems(prev, next)
    expect(merged.map(entry => entry.id)).toEqual(['b', 'c'])
    expect(merged[0]).toBe(prev[1])
    expect(merged[1]).toBe(next[1])
  })

  it('handles an empty previous list', () => {
    const next = [item('a')]
    expect(mergeGalleryItems([], next)).toEqual(next)
  })
})
