import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STUDIO_ROUTE } from '../src/shared.js'
import type { GifCard } from '../src/client/gif-card.js'
import {
  GIF_EDIT_FINISH_MS,
  GIF_EDIT_PREFETCH_WAIT_MS,
  GifEditDoneDock,
  createGifEditStatus,
  gifEditProgressAt,
  useGifEdit,
  waitAtMost,
  type GifEdit,
  type GifEditInput,
} from '../src/client/gif-edit.js'
import { GIF_TEXT, gifT } from '../src/client/gif-i18n.js'
import type { GifPlayer } from '../src/client/gif-player.js'
import { planGifSheet, type GifSheetPlan } from '../src/client/gif-sheet.js'

// The send's browser-only steps: the canvas route, encoding the sheet and reading it back.
vi.mock('../src/client/tl/canvas-selection.js', () => ({ readCanvasImageLimit: async () => 4_000_000 }))
vi.mock('../src/client/browser-image-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/browser-image-utils.js')>(),
  blobToDataUrl: async () => 'data:image/png;base64,AAAA',
}))
vi.mock('../src/client/gif-sheet.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/gif-sheet.js')>(),
  encodeSheetWithinLimit: async (_canvas: unknown, plan: GifSheetPlan) => ({ blob: new Blob(['sheet'], { type: 'image/png' }), mediaType: 'image/png', plan }),
}))

const t = gifT('zh')

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('edit progress', () => {
  it('estimates the redraw toward 90% and never past it', () => {
    expect(gifEditProgressAt(0)).toBe(0)
    expect(gifEditProgressAt(25_000)).toBeCloseTo(0.9 * (1 - Math.exp(-1)), 6)
    const samples = [1_000, 10_000, 60_000, 300_000, 3_600_000].map(gifEditProgressAt)
    expect([...samples].sort((a, b) => a - b)).toEqual(samples)
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.9)
    expect(gifEditProgressAt(300_000)).toBeGreaterThan(0.89)
  })

  it('counts the seconds every second through both phases, moves the bar only while redrawing, and fills it when the reply is in', () => {
    const status = createGifEditStatus()
    const changed = vi.fn()
    status.subscribe(changed)
    const run = status.start()
    expect(status.getSnapshot()).toEqual({ phase: 'preparing', seconds: 0, progress: 0, done: undefined })
    vi.advanceTimersByTime(1_000)
    expect(status.getSnapshot()).toMatchObject({ phase: 'preparing', seconds: 1, progress: 0 })
    vi.advanceTimersByTime(1_000)
    expect(status.getSnapshot().seconds).toBe(2)
    run.redraw()
    expect(status.getSnapshot()).toMatchObject({ phase: 'redrawing', seconds: 2, progress: 0 })
    vi.advanceTimersByTime(25_000)
    expect(status.getSnapshot().seconds).toBe(27)
    expect(status.getSnapshot().progress).toBeCloseTo(gifEditProgressAt(25_000), 6)
    vi.advanceTimersByTime(20 * 60_000)
    expect(status.getSnapshot().progress).toBeLessThanOrEqual(0.9)
    expect(changed.mock.calls.length).toBeGreaterThan(1_200)
    run.finish()
    expect(status.getSnapshot()).toMatchObject({ phase: 'finishing', seconds: 1_227, progress: 1 })
    // The seconds stop with the reply: they are what the finished edit reports.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(status.getSnapshot().seconds).toBe(1_227)
    run.succeed({ message: 'done', still: false })
    expect(status.getSnapshot()).toEqual({ phase: undefined, seconds: 0, progress: 0, done: { message: 'done', still: false } })
    status.dismiss()
    expect(status.getSnapshot().done).toBeUndefined()
  })

  it('leaves no clock running once a run stops, and a stopped or replaced run can no longer move the status', () => {
    const status = createGifEditStatus()
    const first = status.start()
    vi.advanceTimersByTime(3_000)
    first.stop()
    expect(status.getSnapshot()).toEqual({ phase: undefined, seconds: 0, progress: 0, done: undefined })
    expect(vi.getTimerCount()).toBe(0)
    const second = status.start()
    first.redraw()
    first.finish()
    first.succeed({ message: 'late', still: false })
    first.stop()
    expect(status.getSnapshot()).toEqual({ phase: 'preparing', seconds: 0, progress: 0, done: undefined })
    expect(vi.getTimerCount()).toBe(1)
    second.redraw()
    expect(status.getSnapshot().phase).toBe('redrawing')
    // The card unmounting stops whatever is running.
    status.stop()
    expect(status.getSnapshot().phase).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    second.finish()
    expect(status.getSnapshot().phase).toBeUndefined()
  })
})

describe('sending a frame edit', () => {
  const sheet = { canvas: {} as HTMLCanvasElement, plan: planGifSheet(8, 16, 8), frame: { width: 16, height: 8, delaysMs: Array.from({ length: 8 }, () => 100) } }
  const player = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', frames: [], delaysMs: [], info: undefined, index: 0, playing: false, speed: 1 }),
  } as unknown as GifPlayer
  const gif: GifCard = { t, animated: true, player, info: async () => undefined, file: () => undefined, download() {}, copyFrame: async () => undefined }
  const image = { provider: 'openai-compat', model: 'relay', prompt: 'a cat waving', output: '' }
  let versions = 0

  /** The card's edit hook, rendered once with notes on its version; its handlers run outside React, which is all a send needs. */
  function mount(filing: () => Promise<boolean> = async () => true) {
    const busy = { running: false, setRunning: vi.fn(), controller: { current: undefined as AbortController | undefined } }
    const input = {
      gif,
      image,
      versionKey: `version-${String(++versions)}`,
      busy,
      addRevision: vi.fn(filing),
      onSent: vi.fn(),
      onFallback: vi.fn(),
    } satisfies GifEditInput
    let edit: GifEdit | undefined
    const Probe = () => {
      edit = useGifEdit(input)
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    edit?.setComments([{ id: 1, frame: 2, x: 40, y: 60, text: 'raise the left arm' }])
    // Notes are kept per version outside the card, so the next render starts with them.
    renderToStaticMarkup(createElement(Probe))
    if (edit === undefined) throw new Error('the probe did not render')
    return { edit, input, busy }
  }

  /** Filing a version (the gallery record, the new picture) that finishes when the test says so. */
  function heldFiling() {
    let finish: (saved: boolean) => void = () => {}
    return {
      filing: () => new Promise<boolean>(resolve => { finish = resolve }),
      release: () => { finish(true) },
    }
  }

  const idle = { phase: undefined, seconds: 0, progress: 0, done: undefined }
  const json = (ok: boolean, body: unknown) => ({ ok, json: async () => body }) as Response
  const reply = (mediaType: string) => json(true, {
    attachment: { attachmentId: 'sha256:edited', mediaType, bytes: 2_048 },
    output: '1024x1024', provider: 'openai-compat', model: 'relay', prompt: 'sheet instructions', createdAt: 1, elapsedMs: 1,
  })

  /** The workbench: the config answers at once; the edit request waits for the test, or for its abort. */
  function studio() {
    let answer: (response: Response) => void = () => {}
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Promise.resolve(json(true, { providers: [] }))
      return new Promise<Response>((resolve, reject) => {
        answer = resolve
        init.signal?.addEventListener('abort', () => { reject(new DOMException('The operation was aborted.', 'AbortError')) }, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    return {
      posts: () => fetchMock.mock.calls.filter(([url, init]) => url === STUDIO_ROUTE && init?.method === 'POST'),
      answer: (response: Response) => { answer(response) },
    }
  }
  const settle = () => vi.advanceTimersByTimeAsync(0)

  /** Sends the notes and lets the workbench answer, which leaves the edit finishing. */
  async function sendAndAnswer(edit: GifEdit, server: ReturnType<typeof studio>, answer = reply('image/gif')) {
    edit.send(sheet)
    await settle()
    server.answer(answer)
    await settle()
  }

  it('prepares until the request goes out, redraws while it is out, keeps the full overlay until the new version is filed, then says in the editor how long it took', async () => {
    const server = studio()
    const filing = heldFiling()
    const { edit, input, busy } = mount(filing.filing)
    edit.setEditorOpen(true)
    edit.send(sheet)
    expect(edit.status.getSnapshot()).toMatchObject({ phase: 'preparing', seconds: 0 })
    expect(busy.setRunning).toHaveBeenLastCalledWith(true)
    await settle()
    expect(server.posts()).toHaveLength(1)
    expect(edit.status.getSnapshot()).toMatchObject({ phase: 'redrawing', progress: 0 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(edit.status.getSnapshot().seconds).toBe(30)
    expect(edit.status.getSnapshot().progress).toBeGreaterThan(0.5)
    expect(edit.status.getSnapshot().progress).toBeLessThan(0.9)
    server.answer(reply('image/gif'))
    await settle()
    // The bar fills before the new version is filed.
    expect(edit.status.getSnapshot()).toMatchObject({ phase: 'finishing', seconds: 30, progress: 1 })
    expect(input.addRevision).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(GIF_EDIT_FINISH_MS)
    expect(input.addRevision).toHaveBeenCalledOnce()
    // Filing takes a while; the overlay stays, full, over the old version meanwhile.
    await vi.advanceTimersByTimeAsync(300)
    expect(edit.status.getSnapshot()).toEqual({ phase: 'finishing', seconds: 30, progress: 1, done: undefined })
    filing.release()
    await settle()
    expect(edit.status.getSnapshot()).toEqual({
      ...idle,
      done: { message: '改好了：已按评论逐帧修改，存为新版本，用了 30 秒。旧版本保留，可以切回。', still: false },
    })
    expect(input.onSent).not.toHaveBeenCalled()
    expect(busy.setRunning).toHaveBeenLastCalledWith(false)
    expect(busy.controller.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a still reply in the preview too, with the still notice and no frames to go on with', async () => {
    const server = studio()
    const { edit, input } = mount()
    edit.setEditorOpen(true)
    await sendAndAnswer(edit, server, reply('image/png'))
    await vi.advanceTimersByTimeAsync(GIF_EDIT_FINISH_MS)
    expect(input.addRevision).toHaveBeenCalledOnce()
    expect(edit.status.getSnapshot().done).toEqual({ message: GIF_TEXT.zh.gifEditStill, still: true })
    expect(input.onSent).not.toHaveBeenCalled()
  })

  it('hands a reply that came back after the editor was left to the card\'s onSent', async () => {
    const server = studio()
    const { edit, input } = mount()
    edit.setEditorOpen(true)
    edit.send(sheet)
    await settle()
    // The user left editing (or closed the preview) while waiting.
    edit.setEditorOpen(false)
    server.answer(reply('image/gif'))
    await settle()
    await vi.advanceTimersByTimeAsync(GIF_EDIT_FINISH_MS)
    expect(input.addRevision).toHaveBeenCalledOnce()
    expect(input.onSent).toHaveBeenCalledWith(GIF_TEXT.zh.gifEditDone)
    expect(edit.status.getSnapshot()).toEqual(idle)
  })

  it('counts closing the preview while the new version is filed as leaving: the card says how it went and no outcome is left for the editor', async () => {
    const server = studio()
    const filing = heldFiling()
    const { edit, input } = mount(filing.filing)
    edit.setEditorOpen(true)
    await sendAndAnswer(edit, server)
    await vi.advanceTimersByTimeAsync(GIF_EDIT_FINISH_MS)
    expect(input.addRevision).toHaveBeenCalledOnce()
    edit.setEditorOpen(false)
    filing.release()
    await settle()
    expect(input.onSent).toHaveBeenCalledWith(GIF_TEXT.zh.gifEditDone)
    expect(edit.status.getSnapshot()).toEqual(idle)
  })

  it('the overlay\'s cancel clears the progress at once, files nothing and frees the card for editing', async () => {
    const server = studio()
    const { edit, input, busy } = mount()
    edit.setEditorOpen(true)
    edit.send(sheet)
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(edit.status.getSnapshot().phase).toBe('redrawing')
    edit.cancelSend()
    expect(edit.status.getSnapshot()).toEqual(idle)
    expect(vi.getTimerCount()).toBe(0)
    expect(busy.setRunning).toHaveBeenLastCalledWith(false)
    expect(busy.controller.current).toBeUndefined()
    await settle()
    expect(server.posts()).toHaveLength(1)
    expect(input.addRevision).not.toHaveBeenCalled()
    expect(input.onSent).not.toHaveBeenCalled()
  })

  it('a cancel while preparing never sends the request and frees the card at once, so the notes can be sent again straight away', async () => {
    const server = studio()
    const { edit, busy } = mount()
    edit.send(sheet)
    expect(edit.status.getSnapshot().phase).toBe('preparing')
    edit.cancelSend()
    expect(edit.status.getSnapshot().phase).toBeUndefined()
    expect(busy.setRunning).toHaveBeenLastCalledWith(false)
    expect(busy.controller.current).toBeUndefined()
    // Sent again before the cancelled run noticed: only the new send reaches the workbench, and the old one cannot end it.
    edit.send(sheet)
    await settle()
    expect(server.posts()).toHaveLength(1)
    expect(edit.status.getSnapshot().phase).toBe('redrawing')
    expect(busy.setRunning.mock.calls).toEqual([[true], [false], [true]])
    expect(busy.controller.current).toBeDefined()
  })

  it('a cancel after the reply came back still files the new version, which is paid for, and leaves no overlay', async () => {
    const server = studio()
    const { edit, input, busy } = mount()
    edit.setEditorOpen(true)
    await sendAndAnswer(edit, server)
    expect(edit.status.getSnapshot().phase).toBe('finishing')
    // The card's own cancel aborts the request's controller.
    busy.controller.current?.abort()
    expect(edit.status.getSnapshot()).toEqual(idle)
    await vi.advanceTimersByTimeAsync(GIF_EDIT_FINISH_MS)
    expect(input.addRevision).toHaveBeenCalledOnce()
    expect(edit.status.getSnapshot()).toEqual(idle)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a version that cannot be filed ends the progress like any failure, leaving no overlay', async () => {
    const server = studio()
    const { edit, input, busy } = mount(async () => { throw new Error('quota exceeded') })
    edit.setEditorOpen(true)
    await sendAndAnswer(edit, server)
    await vi.advanceTimersByTimeAsync(GIF_EDIT_FINISH_MS)
    expect(input.addRevision).toHaveBeenCalledOnce()
    expect(edit.status.getSnapshot()).toEqual(idle)
    expect(input.onSent).not.toHaveBeenCalled()
    expect(busy.setRunning).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a card unmounted while the new version is filed leaves nothing running and no outcome behind', async () => {
    const server = studio()
    const filing = heldFiling()
    const { edit, input, busy } = mount(filing.filing)
    edit.setEditorOpen(true)
    await sendAndAnswer(edit, server)
    await vi.advanceTimersByTimeAsync(GIF_EDIT_FINISH_MS)
    // Unmounting closes the editor, aborts the card's request and stops the edit's status.
    edit.setEditorOpen(false)
    busy.controller.current?.abort()
    edit.status.stop()
    expect(edit.status.getSnapshot()).toEqual(idle)
    filing.release()
    await settle()
    expect(input.addRevision).toHaveBeenCalledOnce()
    expect(edit.status.getSnapshot()).toEqual(idle)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a refused edit ends the progress and files nothing', async () => {
    const server = studio()
    const { edit, input, busy } = mount()
    edit.setEditorOpen(true)
    await sendAndAnswer(edit, server, json(false, { error: 'openai image request failed (400): unsupported or repeated form field' }))
    expect(edit.status.getSnapshot()).toEqual(idle)
    expect(input.addRevision).not.toHaveBeenCalled()
    expect(input.onSent).not.toHaveBeenCalled()
    expect(busy.setRunning).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('finished edit in the plain preview', () => {
  const edit = (done: GifEdit['done']) => ({ t, availability: undefined, done }) as unknown as GifEdit

  it('shows the outcome where the GIF preview has it, and nothing without one', () => {
    const markup = renderToStaticMarkup(createElement(GifEditDoneDock, { edit: edit({ message: GIF_TEXT.zh.gifEditStill, still: true }), onFinish() {} }))
    expect(markup).toMatch(/^<div class="dsh-ig-gif-dock is-plain"><div class="dsh-ig-gif-edit is-done"><p class="dsh-ig-gif-edit-done-text" role="status">/)
    expect(markup).toContain(GIF_TEXT.zh.gifEditStill)
    expect(markup).toContain('>完成</button>')
    expect(renderToStaticMarkup(createElement(GifEditDoneDock, { edit: edit(undefined), onFinish() {} }))).toBe('')
  })
})

describe('filing the new version', () => {
  it('waits for its picture only so long, leaving no timer behind when the picture is in time and ignoring one that comes late', async () => {
    await expect(waitAtMost(Promise.resolve('picture'), GIF_EDIT_PREFETCH_WAIT_MS)).resolves.toBe('picture')
    expect(vi.getTimerCount()).toBe(0)

    let arrive: (picture: string) => void = () => {}
    const settled = vi.fn()
    void waitAtMost(new Promise<string>(resolve => { arrive = resolve }), GIF_EDIT_PREFETCH_WAIT_MS).then(settled)
    await vi.advanceTimersByTimeAsync(GIF_EDIT_PREFETCH_WAIT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledWith(undefined)
    arrive('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
