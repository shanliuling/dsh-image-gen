import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GalleryItem } from '../src/client/gallery-store.js'
import { GalleryGifTile, galleryGifUrl } from '../src/client/gif-gallery.js'
import { imageUrlFor, vaultUrlFor } from '../src/shared.js'

const still: GalleryItem = {
  id: 'g-1', prompt: 'a cat', provider: 'openai', model: 'gpt-image', createdAt: 1,
  attachment: { attachmentId: 'sha256:cat', mediaType: 'image/png', bytes: 3, width: 32, height: 24 },
}
const normalized: GalleryItem = { ...still, original: { key: 'b2/cat', bytes: 9, mediaType: 'image/gif' } }
const gifAttachment: GalleryItem = { ...still, attachment: { ...still.attachment, mediaType: 'image/gif' } }

describe('gallery GIF tiles', () => {
  it('finds the animation in the vault original, else in a GIF attachment', () => {
    expect(galleryGifUrl(normalized)).toBe(vaultUrlFor('b2/cat', 'image/gif'))
    expect(galleryGifUrl(gifAttachment)).toBe(imageUrlFor(gifAttachment.attachment))
    expect(galleryGifUrl(still)).toBeUndefined()
    expect(galleryGifUrl({ ...still, original: { key: 'b2/big', bytes: 9, mediaType: 'image/png' } })).toBeUndefined()
  })

  it('badges an animated tile and loads the animation only while hovered', () => {
    const render = (item: GalleryItem, hovered: boolean) => renderToStaticMarkup(createElement(GalleryGifTile, { item, lang: 'zh', hovered }))
    expect(render(normalized, false)).toBe('<span class="dsh-ig-gallery-gif-badge" title="GIF 动图">GIF</span>')
    const hovered = render(normalized, true)
    expect(hovered).toContain('class="dsh-ig-gallery-card-img dsh-ig-gallery-gif-hover"')
    expect(hovered).toContain(`src="${vaultUrlFor('b2/cat', 'image/gif').replace(/&/g, '&amp;')}"`)
    expect(render(still, true)).toBe('')
  })
})
