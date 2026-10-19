import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from 'tldraw'
import { landTlItems } from '../src/client/tl/studio-tl-canvas.js'
import { fetchAttachmentBlob } from '../src/client/image-cache.js'
import type { TlLandingItem } from '../src/client/tl/tl-canvas-bridge.js'

vi.mock('../src/client/image-cache.js', () => ({ fetchAttachmentBlob: vi.fn(), clearAttachmentCache: vi.fn() }))
vi.mock('../src/client/browser-image-utils.js', () => ({ blobToDataUrl: async (blob: Blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}` }))

const image: TlLandingItem = {
  galleryId: 'g-123', prompt: 'a cat', provider: 'google', model: 'gemini-image',
  attachment: { attachmentId: 'sha256:cat', mediaType: 'image/png', bytes: 3, width: 32, height: 24 },
}

function canvas() {
  const assets = new Map<string, any>()
  const shapes: any[] = []
  const editor = {
    store: { allRecords: () => shapes },
    getAsset: (id: string) => assets.get(id),
    createAssets: vi.fn((values: any[]) => { for (const asset of values) assets.set(asset.id, asset) }),
    createShapes: vi.fn((values: any[]) => { shapes.push(...values.map(shape => ({ ...shape, typeName: 'shape' }))) }),
    getViewportPageBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800, w: 1200, h: 800, center: { x: 600, y: 400 } }),
    getCurrentPageShapes: () => shapes.filter(s => s.page !== 'other'),
    getShapePageBounds: (id: string) => {
      const shape = shapes.find(s => s.id === id)
      return { minX: shape.x, minY: shape.y, maxX: shape.x + shape.props.w, maxY: shape.y + shape.props.h }
    },
    centerOnPoint: vi.fn(), zoomToBounds: vi.fn(),
  }
  return { editor: editor as unknown as Editor, shapes, assets }
}

beforeEach(() => vi.mocked(fetchAttachmentBlob).mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' })))
afterEach(() => vi.restoreAllMocks())

describe('history images landing in the persistent canvas', () => {
  it('creates an image with the original data and generation provenance', async () => {
    const c = canvas()
    expect(await landTlItems(c.editor, [image], () => true)).toBe(true)
    expect(c.shapes).toHaveLength(1)
    expect(c.shapes[0]).toMatchObject({ type: 'image', meta: { galleryId: image.galleryId, attachmentId: 'sha256:cat', prompt: 'a cat', provider: 'google', model: 'gemini-image', fromConversation: false } })
    expect([...c.assets.values()][0].props.src).toBe('data:image/png;base64,cG5n')
  })

  it('deduplicates repeated drops and clicks, including images moved to another page', async () => {
    const c = canvas()
    await landTlItems(c.editor, [image], () => true)
    c.shapes[0].page = 'other'
    await landTlItems(c.editor, [image], () => true)
    expect(c.shapes).toHaveLength(1)
    expect(fetchAttachmentBlob).toHaveBeenCalledTimes(1)
  })

  it('deduplicates simultaneous drops of the same image after the fetch completes', async () => {
    const c = canvas()
    await Promise.all(Array.from({ length: 10 }, () => landTlItems(c.editor, [image], () => true)))
    expect(c.shapes).toHaveLength(1)
    expect(c.assets.size).toBe(1)
  })

  it('puts later images below occupied space instead of covering earlier ones', async () => {
    const c = canvas()
    await landTlItems(c.editor, [image], () => true)
    await landTlItems(c.editor, [{ ...image, galleryId: 'g-456' }], () => true)
    expect(c.shapes).toHaveLength(2)
    expect(c.shapes[1].y).toBeGreaterThanOrEqual(c.shapes[0].y + c.shapes[0].props.h + 40)
  })

  it('does not add assets or shapes if the canvas closes or is cleared during loading', async () => {
    const c = canvas()
    let finish!: (blob: Blob) => void
    vi.mocked(fetchAttachmentBlob).mockReturnValue(new Promise(resolve => { finish = resolve }))
    let active = true
    const pending = landTlItems(c.editor, [image], () => active)
    active = false
    finish(new Blob(['png'], { type: 'image/png' }))
    expect(await pending).toBe(false)
    expect(c.shapes).toHaveLength(0)
    expect(c.assets.size).toBe(0)
  })

  it('does not fetch an image for an already closed canvas', async () => {
    const c = canvas()
    expect(await landTlItems(c.editor, [image], () => false)).toBe(false)
    expect(fetchAttachmentBlob).not.toHaveBeenCalled()
  })

  it('does not leave a broken shape behind when the original is no longer readable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetchAttachmentBlob).mockRejectedValue(new Error('404'))
    const c = canvas()
    const onUnreadable = vi.fn()
    await landTlItems(c.editor, [image], () => true, onUnreadable)
    expect(onUnreadable).toHaveBeenCalledOnce()
    expect(c.shapes).toHaveLength(0)
    expect(c.assets.size).toBe(0)
    // Retrying after the original becomes available succeeds.
    vi.mocked(fetchAttachmentBlob).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    await landTlItems(c.editor, [image], () => true)
    expect(c.shapes).toHaveLength(1)
  })

  it('allows re-importing after the user deliberately deletes the existing shape', async () => {
    const c = canvas()
    await landTlItems(c.editor, [image], () => true)
    c.shapes.length = 0
    await landTlItems(c.editor, [image], () => true)
    expect(c.shapes).toHaveLength(1)
    expect(c.assets.size).toBe(1)
    expect(fetchAttachmentBlob).toHaveBeenCalledTimes(1)
  })
})
