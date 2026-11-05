import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudioTlCanvas } from '../src/client/tl/studio-tl-canvas.js'
import { GalleryCanvasButton } from '../src/client/tl/gallery-canvas-button.js'
import { GALLERY_IMAGE_MIME, startGalleryImageDrag } from '../src/client/tl/gallery-image-transfer.js'
import { RecentItem } from '../src/client/studio-helpers.js'
import { GalleryCard } from '../src/client/gallery-card.js'
import { fetchAttachmentBlob } from '../src/client/image-cache.js'
import { clearTlLandings, registerTlLandingConsumer } from '../src/client/tl/tl-canvas-bridge.js'

// Execute the actual component event callbacks without a browser or a DSH host.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  memo: (fn: unknown) => fn, useId: () => 'test-canvas', useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }), useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: vi.fn(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))
vi.mock('tldraw', () => ({ Tldraw: () => null, DefaultToolbar: () => null, createShapeId: (id: string) => `shape:${id}` }))
vi.mock('../src/client/tl/tl-brand-theme.js', () => ({ applyBrandTheme: vi.fn(), syncTldrawThemeWithHost: () => vi.fn() }))
vi.mock('../src/client/tl/canvas-sync.js', () => ({ startCanvasSync: () => Object.assign(vi.fn(), { retry: vi.fn() }) }))
vi.mock('../src/client/image-cache.js', () => ({ fetchAttachmentBlob: vi.fn(), clearAttachmentCache: vi.fn() }))
vi.mock('../src/client/browser-image-utils.js', () => ({ blobToDataUrl: async () => 'data:image/png;base64,cG5n' }))

const item = { id: 'g-123', prompt: 'a cat', provider: 'google' as const, model: 'gemini', createdAt: 1,
  attachment: { attachmentId: 'sha256:cat', mediaType: 'image/png' as const, bytes: 3, width: 32, height: 24 } }
const stops: Array<() => void> = []
beforeEach(() => vi.mocked(fetchAttachmentBlob).mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' })))
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); clearTlLandings() })

function mountedCanvas() {
  const component: any = (StudioTlCanvas as any)({ lang: 'zh' })
  const shapes: any[] = [], assets = new Map()
  const editor = {
    id: 'test', run: (fn: () => void) => fn(), selectNone() {}, updateInstanceState() {},
    store: { allRecords: () => shapes }, getAsset: (id: string) => assets.get(id),
    createAssets: (values: any[]) => { for (const asset of values) assets.set(asset.id, asset) },
    createShapes: (values: any[]) => { shapes.push(...values.map(shape => ({ ...shape, typeName: 'shape' }))) },
    getViewportPageBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800, w: 1200, h: 800, center: { x: 600, y: 400 } }),
    getCurrentPageShapes: () => shapes, getShapePageBounds: () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 }),
  }
  stops.push(component.props.children[0].props.onMount(editor))
  return { component, shapes }
}

function dropEvent(raw = '') {
  return { dataTransfer: { getData: (type: string) => type === GALLERY_IMAGE_MIME ? raw : '' }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
}

describe('history canvas action wiring', () => {
  it('accepts a cold reference drag and reads the original only after the drop', async () => {
    const c = mountedCanvas(), strings = new Map<string, string>()
    let finish!: (blob: Blob) => void
    vi.mocked(fetchAttachmentBlob).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const transfer = {
      get types() { return [...strings.keys()] }, effectAllowed: 'none', dropEffect: 'none',
      getData: (type: string) => strings.get(type) ?? '',
      setData: (type: string, value: string) => { strings.set(type, value) },
      items: { clear: () => strings.clear(), add: vi.fn() },
    }
    expect(startGalleryImageDrag({ dataTransfer: transfer as unknown as DataTransfer, preventDefault: vi.fn() }, item, null)).toBe(true)
    expect(fetchAttachmentBlob).not.toHaveBeenCalled()
    const event = { dataTransfer: transfer, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    c.component.props.onDragOverCapture(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(transfer.dropEffect).toBe('copy')
    c.component.props.onDropCapture(event)
    expect(fetchAttachmentBlob).toHaveBeenCalledWith(item.attachment)
    expect(c.shapes).toHaveLength(0)
    finish(new Blob(['png'], { type: 'image/png' }))
    await vi.waitFor(() => expect(c.shapes).toHaveLength(1))
    expect(c.shapes[0].meta.galleryId).toBe(item.id)
    expect(transfer.items.add).not.toHaveBeenCalled()
  })

  it.each([[], ['Files'], ['text/uri-list']].map(types => ({ types })))('does not intercept external drag-over types $types', ({ types }) => {
    const c = mountedCanvas()
    const event = { dataTransfer: { types, dropEffect: 'none' }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    c.component.props.onDragOverCapture(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('does not accept reference drags after the canvas unmounts', () => {
    const c = mountedCanvas()
    stops.pop()!()
    const event = { dataTransfer: { types: [GALLERY_IMAGE_MIME] }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    c.component.props.onDragOverCapture(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('keeps cold recent thumbnails draggable and the send action available', () => {
    const recent: any = (RecentItem as any)({ item, active: false, mode: 'select', lang: 'zh', actions: { select: vi.fn(), favorite: vi.fn(), toast: vi.fn() } })
    expect(recent.props.children[0].props.draggable).toBe(true)
    expect(recent.props.children[1].type).toBe(GalleryCanvasButton)
    expect(recent.props.children[1].props.disabled).toBeFalsy()
    expect(fetchAttachmentBlob).not.toHaveBeenCalled()
  })

  it.each([false, true])('only disables cold gallery dragging in manage mode (%s)', isManageMode => {
    const card: any = (GalleryCard as any)({ item, index: 0, lang: 'zh', isManageMode, isSelected: false, t: (key: string) => key,
      actions: { click: vi.fn(), toggleSelect: vi.fn(), requestDelete: vi.fn(), preview: vi.fn(), toast: vi.fn() } })
    const image = card.props.children[0].props.children.find((child: any) => child?.type === 'img')
    expect(image.props.draggable).toBe(!isManageMode)
    expect(fetchAttachmentBlob).not.toHaveBeenCalled()
  })

  it('intercepts plugin image drops before tldraw can interpret them as a URL or a duplicate file', async () => {
    const c = mountedCanvas()
    const event = dropEvent(JSON.stringify({ galleryId: item.id, ...item }))
    c.component.props.onDropCapture(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(c.shapes).toHaveLength(1))
    expect(c.shapes[0].meta).toMatchObject({ galleryId: item.id, prompt: item.prompt, model: item.model })
    c.component.props.onDropCapture(event)
    await Promise.resolve()
    expect(c.shapes).toHaveLength(1)
  })

  it.each(['', 'bad json', '{}'])('leaves external files and non-plugin drops to the original tldraw handler', raw => {
    const c = mountedCanvas(), event = dropEvent(raw)
    c.component.props.onDropCapture(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(c.shapes).toHaveLength(0)
  })

  it.each(['close', 'clear'])('does not finish a drop if the canvas is %s during loading', async action => {
    const c = mountedCanvas()
    let finish!: (value: Blob) => void
    vi.mocked(fetchAttachmentBlob).mockReturnValue(new Promise(resolve => { finish = resolve }))
    c.component.props.onDropCapture(dropEvent(JSON.stringify({ galleryId: item.id, ...item })))
    if (action === 'close') stops.pop()!()
    else clearTlLandings()
    finish(new Blob(['png']))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(c.shapes).toHaveLength(0)
  })

  it('disables the send button with a clear explanation when no canvas is mounted', () => {
    const button: any = GalleryCanvasButton({ item, lang: 'zh', onToast: vi.fn() })
    expect(button.props.disabled).toBe(true)
    expect(button.props.title).toBe('请先打开无限画布')
  })

  it('disables the action while the image is loading even if the canvas is ready', () => {
    mountedCanvas()
    const button: any = GalleryCanvasButton({ item, lang: 'en', disabled: true, onToast: vi.fn() })
    expect(button.props.disabled).toBe(true)
    expect(button.props.title).toBe('Wait for the image to load')
  })

  it('sends without triggering the card selection or preview click', async () => {
    const c = mountedCanvas(), onToast = vi.fn(), stopPropagation = vi.fn()
    const button: any = GalleryCanvasButton({ item, lang: 'zh', onToast })
    expect(button.props.disabled).toBeFalsy()
    button.props.onClick({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(c.shapes).toHaveLength(1))
    expect(onToast).toHaveBeenCalledWith('已发送到画布')
  })

  it('rechecks availability if the canvas closes between rendering the button and clicking', () => {
    const stop = registerTlLandingConsumer(async () => true)
    const onToast = vi.fn()
    const button: any = GalleryCanvasButton({ item, lang: 'zh', onToast })
    stop()
    button.props.onClick({ stopPropagation: vi.fn() })
    expect(onToast).toHaveBeenCalledWith('请先打开无限画布')
  })
})
