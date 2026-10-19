import { afterEach, describe, expect, it, vi } from 'vitest'
import { GALLERY_IMAGE_MIME, startGalleryImageDrag, readGalleryImageDrop } from '../src/client/tl/gallery-image-transfer.js'
import type { GalleryItem } from '../src/client/gallery-store.js'
import { CANVAS_MAX_PROMPT_CHARS } from '../src/shared.js'
import { clearTlLandings, hasTlLandingConsumer, registerTlLandingConsumer, sendTlLandingToOpenCanvas, subscribeTlLandingAvailability } from '../src/client/tl/tl-canvas-bridge.js'

const item: GalleryItem = {
  id: 'g-123', prompt: 'a cat', provider: 'google', model: 'gemini-image', createdAt: 1,
  attachment: { attachmentId: 'sha256:cat', mediaType: 'image/png', bytes: 3, width: 32, height: 24 },
}

/** Drag store semantics, including the Files type; no URL fallback is invented. */
function dragStore() {
  const strings = new Map<string, string>()
  const files: File[] = []
  const dataTransfer = {
    effectAllowed: 'none', files,
    get types() { return [...strings.keys(), ...(files.length ? ['Files'] : [])] },
    setData: (type: string, value: string) => { strings.set(type, value) },
    getData: (type: string) => strings.get(type) ?? '',
    items: { clear: () => { strings.clear(); files.length = 0 }, add: (file: File) => { files.push(file) } },
  }
  return { dataTransfer: dataTransfer as unknown as DataTransfer, preventDefault: vi.fn() }
}

describe('gallery image transfer into the canvas', () => {
  it('replaces native URL dragging with one real image file and its generation provenance', async () => {
    const event = dragStore()
    event.dataTransfer.setData('text/uri-list', 'blob:old-url')
    expect(startGalleryImageDrag(event, item, new Blob(['png'], { type: 'image/png' }))).toBe(true)
    expect(event.dataTransfer.files).toHaveLength(1)
    expect(event.dataTransfer.files[0]?.name).toBe('g-123.png')
    expect(await event.dataTransfer.files[0]?.text()).toBe('png')
    expect(event.dataTransfer.types).toContain('Files')
    expect(event.dataTransfer.getData('text/uri-list')).toBe('')
    expect(event.dataTransfer.getData(GALLERY_IMAGE_MIME)).not.toBe('')
    expect(readGalleryImageDrop(event.dataTransfer)).toEqual({
      galleryId: 'g-123', attachment: item.attachment, prompt: 'a cat', provider: 'google', model: 'gemini-image',
    })
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it.each([['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']])('keeps %s bytes and uses the proper extension', async (type, extension) => {
    const event = dragStore()
    expect(startGalleryImageDrag(event, item, new Blob(['original'], { type }))).toBe(true)
    expect(event.dataTransfer.files[0]?.name).toBe(`g-123.${extension}`)
    expect(event.dataTransfer.files[0]?.type).toBe(type)
    expect(await event.dataTransfer.files[0]?.text()).toBe('original')
  })

  it.each([null, undefined, new Blob(), new Blob(['x'], { type: 'text/plain' }), new Blob(['x'], { type: 'constructor' })])('cancels an unloaded, empty or unsupported image instead of starting a fake drag', blob => {
    const event = dragStore()
    expect(startGalleryImageDrag(event, item, blob)).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.dataTransfer.files).toHaveLength(0)
  })

  it('uses the attachment MIME when the cached Blob has no MIME', () => {
    const event = dragStore()
    expect(startGalleryImageDrag(event, item, new Blob(['png']))).toBe(true)
    expect(event.dataTransfer.files[0]?.type).toBe('image/png')
  })

  it('cancels safely if a host rejects adding files', () => {
    const event = dragStore()
    event.dataTransfer.items.add = () => null
    expect(startGalleryImageDrag(event, item, new Blob(['png']))).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('retains the file fallback when the host strips custom MIME', () => {
    const event = dragStore()
    event.dataTransfer.setData = () => { throw new Error('unsupported') }
    expect(startGalleryImageDrag(event, item, new Blob(['png']))).toBe(true)
    expect(event.dataTransfer.files).toHaveLength(1)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(readGalleryImageDrop(event.dataTransfer)).toBeUndefined()
  })

  it('bounds prompts and sanitizes file names without changing gallery identity', () => {
    const event = dragStore()
    const other = { ...item, id: '../cat:photo', prompt: 'a'.repeat(CANVAS_MAX_PROMPT_CHARS + 10) }
    startGalleryImageDrag(event, other, new Blob(['png']))
    expect(event.dataTransfer.files[0]?.name).toBe('___cat_photo.png')
    expect(readGalleryImageDrop(event.dataTransfer)?.galleryId).toBe('../cat:photo')
    expect(readGalleryImageDrop(event.dataTransfer)?.prompt).toHaveLength(CANVAS_MAX_PROMPT_CHARS)
  })

  it.each(['', 'not json', 'null', '[]', '{}', 'x'.repeat(64_001)])('leaves non-plugin or malformed drops to the default handler', raw => {
    expect(readGalleryImageDrop({ getData: () => raw })).toBeUndefined()
  })

  it.each([
    { galleryId: '' }, { attachment: { ...item.attachment, attachmentId: '' } },
    { attachment: { ...item.attachment, mediaType: 'constructor' } },
    { attachment: { ...item.attachment, mediaType: 'image/svg+xml' } },
    { attachment: { ...item.attachment, bytes: -1 } }, { attachment: { ...item.attachment, width: 1.5 } },
    { attachment: { ...item.attachment, height: '24' } }, { prompt: 3 }, { model: {} }, { provider: '' },
  ])('rejects malformed provenance rather than fetching an arbitrary attachment', overrides => {
    const event = dragStore()
    event.dataTransfer.setData(GALLERY_IMAGE_MIME, JSON.stringify({ galleryId: item.id, ...item, ...overrides }))
    expect(readGalleryImageDrop(event.dataTransfer)).toBeUndefined()
  })

  it('ignores unknown fields and does not let a drag masquerade as a conversation event', () => {
    const event = dragStore()
    startGalleryImageDrag(event, item, new Blob(['png']))
    const value = JSON.parse(event.dataTransfer.getData(GALLERY_IMAGE_MIME))
    event.dataTransfer.setData(GALLERY_IMAGE_MIME, JSON.stringify({ ...value, fromConversation: true, extra: 'ignored' }))
    expect(readGalleryImageDrop(event.dataTransfer)).not.toHaveProperty('fromConversation')
    expect(readGalleryImageDrop(event.dataTransfer)).not.toHaveProperty('extra')
    expect(readGalleryImageDrop({ getData() { throw new Error('denied') } })).toBeUndefined()
  })
})

describe('explicit send to canvas availability', () => {
  const stops: Array<() => void> = []
  afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); clearTlLandings() })
  const landing = { galleryId: item.id, attachment: item.attachment, prompt: item.prompt, provider: item.provider, model: item.model }

  it('refuses closed canvases and never replays that click after a canvas opens', async () => {
    expect(hasTlLandingConsumer()).toBe(false)
    expect(sendTlLandingToOpenCanvas(landing)).toBe(false)
    const receive = vi.fn(async () => true)
    stops.push(registerTlLandingConsumer(receive))
    await Promise.resolve()
    expect(receive).not.toHaveBeenCalled()
  })

  it('notifies availability only when the first canvas opens or the last closes', () => {
    const notify = vi.fn()
    stops.push(subscribeTlLandingAvailability(notify))
    const first = registerTlLandingConsumer(async () => true), second = registerTlLandingConsumer(async () => true)
    stops.push(first, second)
    expect(notify).toHaveBeenCalledTimes(1)
    first()
    expect(hasTlLandingConsumer()).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    second()
    expect(hasTlLandingConsumer()).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
    second()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('preserves provenance on the explicit button route', async () => {
    const receive = vi.fn(async () => true)
    stops.push(registerTlLandingConsumer(receive))
    expect(sendTlLandingToOpenCanvas(landing)).toBe(true)
    await vi.waitFor(() => expect(receive).toHaveBeenCalledWith([{ ...landing, onlyWhileCanvasOpen: true }]))
  })

  it('does not replay an interrupted history send after the last canvas closes', async () => {
    let finish!: (value: boolean) => void
    const stop = registerTlLandingConsumer(() => new Promise(resolve => { finish = resolve }))
    expect(sendTlLandingToOpenCanvas(landing)).toBe(true)
    stop()
    finish(false)
    await Promise.resolve()
    const reopened = vi.fn(async () => true)
    stops.push(registerTlLandingConsumer(reopened))
    await Promise.resolve()
    expect(reopened).not.toHaveBeenCalled()
  })
})
