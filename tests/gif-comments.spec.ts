import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createGifPlayer, type GifPlayer, type GifPlayerDeps } from '../src/client/gif-player.js'
import {
  GifCommentBar,
  GifCommentLayer,
  GifEditChip,
  GifEditDoneBar,
  GifEditOverlay,
  GifEditToggle,
  commentKeyAction,
  gifEditAvailability,
  gifEditModel,
} from '../src/client/gif-comments.js'
import { GifFilmstrip } from '../src/client/gif-filmstrip.js'
import { GIF_TEXT, gifT } from '../src/client/gif-i18n.js'
import { GIF_STYLE } from '../src/client/gif-style.js'
import { planGifSheet, sheetViewSize, type GifComment } from '../src/client/gif-sheet.js'
import { gifBytes } from './gif-fixture.js'

const t = gifT('zh')

function readyPlayer(frames = 8): GifPlayer {
  const deps: GifPlayerDeps = {
    decode: async () => ({ frames: Array.from({ length: frames }, () => ({ width: 16, height: 8, close: vi.fn() }) as unknown as ImageBitmap), delaysMs: Array.from({ length: frames }, () => 100) }),
    encodeFrame: async () => undefined,
    hidden: () => false,
    setTimeout: () => 1,
    clearTimeout: () => {},
  }
  const player = createGifPlayer(new Blob([gifBytes(frames)], { type: 'image/gif' }), deps)
  player.setVisible('lightbox', true)
  return player
}

const ready = (player: GifPlayer) => vi.waitFor(() => { expect(player.getSnapshot().status).toBe('ready') })

type ButtonElement = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>
const childrenOf = (node: ReactElement) => (node.props as { children?: ReactNode }).children
const textOf = (node: ReactNode): string => Array.isArray(node) ? node.map(textOf).join('') : isValidElement(node) ? textOf(childrenOf(node)) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
/** The buttons of a component made of plain elements, called directly so their handlers can be pressed without a DOM. */
const buttons = (node: ReactNode): ButtonElement[] => Array.isArray(node)
  ? node.flatMap(buttons)
  : isValidElement(node) ? [...(node.type === 'button' ? [node as ButtonElement] : []), ...buttons(childrenOf(node))] : []
const button = (node: ReactNode, label: string) => buttons(node).find(candidate => textOf(candidate) === label)

describe('frame comment availability', () => {
  const frames = (count: number) => Array.from({ length: count }, () => ({}) as ImageBitmap)
  const info = (count: number) => ({ frames: count, width: 16, height: 8, delaysMs: [] })

  it('offers editing only for an animated OpenAI-shaped result whose frames are decoded and within the GIF contract', () => {
    const base = { provider: 'openai-compat', animated: true, snapshot: { status: 'ready' as const, frames: frames(8), info: info(8) } }
    expect(gifEditAvailability(base)).toBe('ready')
    expect(gifEditAvailability({ ...base, provider: 'openai' })).toBe('ready')
    expect(gifEditAvailability({ ...base, provider: 'google' })).toBeUndefined()
    expect(gifEditAvailability({ ...base, animated: false })).toBeUndefined()
    expect(gifEditAvailability({ ...base, snapshot: undefined })).toBeUndefined()
    expect(gifEditAvailability({ ...base, snapshot: { status: 'fallback', frames: [], info: info(8) } })).toBe('unsupported')
    expect(gifEditAvailability({ ...base, snapshot: { status: 'fallback', frames: [], info: info(600) } })).toBe('frame-count')
    expect(gifEditAvailability({ ...base, snapshot: { status: 'native', frames: [], info: info(8) } })).toBe('unloaded')
    expect(gifEditAvailability({ ...base, snapshot: { status: 'native', frames: [], info: info(17) } })).toBe('frame-count')
    expect(gifEditAvailability({ ...base, snapshot: { status: 'decoding', frames: [], info: undefined } })).toBe('decoding')
  })

  it('judges the frame count by the frames that were decoded, which are the ones the sheet and the request use', () => {
    const base = { provider: 'openai-compat', animated: true }
    expect(gifEditAvailability({ ...base, snapshot: { status: 'ready', frames: frames(8), info: info(17) } })).toBe('ready')
    expect(gifEditAvailability({ ...base, snapshot: { status: 'ready', frames: frames(17), info: info(8) } })).toBe('frame-count')
    expect(gifEditAvailability({ ...base, snapshot: { status: 'ready', frames: frames(1), info: info(8) } })).toBeUndefined()
  })

  it('picks the editing model of the channel the card came from, falling back to the card model', () => {
    const config = {
      activeChannel: 'b',
      providers: [
        { provider: 'openai-compat' as const, channel: 'default', model: 'relay', editModel: 'relay-edit', modelOptions: [{ value: 'relay', label: 'relay' }, { value: 'flare', label: 'flare' }] },
        { provider: 'openai-compat' as const, channel: 'b', model: 'relay-b', modelOptions: [{ value: 'relay-b', label: 'relay-b' }, { value: 'flare', label: 'flare' }] },
        { provider: 'openai' as const, model: 'gpt-image-2' },
      ].map(profile => ({ label: '', configured: true, supportsEditing: true, ratioOptions: [], qualityOptions: [], defaultRatio: '1:1', defaultQuality: 'auto', ...profile })),
    }
    // A separate editing model always wins: the server accepts nothing else for an edit.
    expect(gifEditModel(config, { provider: 'openai-compat', channel: 'default', model: 'flare' })).toBe('relay-edit')
    // Without one, the model that drew this animation is kept while the channel still offers it.
    expect(gifEditModel(config, { provider: 'openai-compat', channel: 'b', model: 'flare' })).toBe('flare')
    expect(gifEditModel(config, { provider: 'openai-compat', channel: 'b', model: 'old' })).toBe('relay-b')
    // A card without a channel runs on the active channel, as the server would resolve it.
    expect(gifEditModel(config, { provider: 'openai-compat', model: 'old' })).toBe('relay-b')
    expect(gifEditModel(config, { provider: 'openai-compat', model: 'flare' })).toBe('flare')
    expect(gifEditModel(config, { provider: 'openai-compat', channel: 'gone', model: 'old' })).toBe('old')
    expect(gifEditModel(config, { provider: 'openai', model: 'old' })).toBe('gpt-image-2')
    expect(gifEditModel(config, { provider: 'openai', model: 'gpt-image-2' })).toBe('gpt-image-2')
    expect(gifEditModel({ providers: [] }, { provider: 'openai', model: 'old' })).toBe('old')
  })

  it('maps Enter to posting and Escape to closing a box, and no key while an input method is composing', () => {
    const key = (key: string, isComposing = false) => commentKeyAction({ key, nativeEvent: { isComposing } })
    expect(key('Enter')).toBe('confirm')
    expect(key('Enter', true)).toBeUndefined()
    expect(key('Escape')).toBe('close')
    expect(key('Escape', true)).toBeUndefined()
    expect(key('a')).toBeUndefined()
  })
})

describe('editing entry points', () => {
  it('offers the card chip only where editing applies, with the reason when it is not ready yet', () => {
    const chip = (availability: Parameters<typeof GifEditChip>[0]['availability'], disabled = false) => renderToStaticMarkup(createElement(GifEditChip, { availability, t, disabled, onOpen() {} }))
    expect(chip(undefined)).toBe('')
    const live = chip('ready')
    expect(live).toContain('>编辑<')
    expect(live).toContain(`title="${GIF_TEXT.zh.gifEditChipTitle}"`)
    expect(live).not.toContain('disabled')
    expect(chip('decoding')).toContain(`title="${GIF_TEXT.zh.gifEditDecoding}"`)
    expect(chip('decoding')).toContain('disabled')
    expect(chip('ready', true)).toContain('disabled')
  })

  it('switches editing from the player bar and names what the switch does', () => {
    const toggle = (availability: Parameters<typeof GifEditToggle>[0]['availability'], editing: boolean) => renderToStaticMarkup(createElement(GifEditToggle, { availability, editing, t, onToggle() {} }))
    expect(toggle('ready', false)).toContain('class="dsh-ig-gif-edit-toggle"')
    expect(toggle('ready', false)).not.toContain('aria-pressed')
    expect(toggle('ready', false)).toContain(`title="${GIF_TEXT.zh.gifEditEnterTitle}"`)
    expect(toggle('ready', true)).toContain('class="dsh-ig-gif-edit-toggle is-active"')
    expect(toggle('ready', true)).toContain(`title="${GIF_TEXT.zh.gifEditExitTitle}"`)
    expect(toggle('frame-count', false)).toContain('disabled')
    expect(toggle('ready', false)).toContain('>编辑帧<')
    expect(toggle('ready', true)).toContain('>退出编辑<')
  })
})

describe('frame comment bar', () => {
  const props = (overrides: Partial<Parameters<typeof GifCommentBar>[0]> = {}, lang: 'zh' | 'en' = 'zh'): Parameters<typeof GifCommentBar>[0] => ({
    view: 'gif', current: 3, total: 8, count: 3, phase: undefined, seconds: 0, t: gifT(lang),
    onView() {}, onClear() {}, onSend() {}, onFallback() {}, ...overrides,
  })
  const render = (overrides: Partial<Parameters<typeof GifCommentBar>[0]> = {}, lang: 'zh' | 'en' = 'zh') =>
    renderToStaticMarkup(createElement(GifCommentBar, props(overrides, lang)))
  const labels = (overrides: Partial<Parameters<typeof GifCommentBar>[0]> = {}, lang: 'zh' | 'en' = 'zh') =>
    buttons(GifCommentBar(props(overrides, lang))).map(textOf)

  it('counts the frame and the notes, switches between the GIF and all frames, and sends the note count', () => {
    const zh = render()
    expect(zh).toContain(GIF_TEXT.zh.gifEditHint)
    expect(zh).toContain('第 3 帧 · 共 3 条评论')
    expect(zh).toContain('aria-pressed="true">动图<')
    expect(zh).toContain('aria-pressed="false">全部帧<')
    expect(zh).toContain('>发送 (3)<')
    expect(zh).toContain('>清空<')
    expect(zh).not.toContain('dsh-ig-gif-edit-error')
    expect(zh).not.toContain('dsh-ig-gif-edit-notice')
    const sheet = render({ view: 'sheet' })
    expect(sheet).toContain(GIF_TEXT.zh.gifEditSheetHint)
    expect(sheet).toContain('共 8 帧 · 3 条评论')
    const en = render({ view: 'sheet' }, 'en')
    expect(en).toContain('8 frames · 3 notes')
    expect(en).toContain('aria-pressed="true">All frames<')
    expect(en).toContain('>Send (3)<')
  })

  it('disables sending without notes or a sheet', () => {
    const empty = render({ count: 0 })
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>清空</)
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>发送 \(0\)</)
    expect(render({ total: 0 })).toMatch(/<button[^>]*disabled[^>]*>发送 \(3\)</)
    expect(render()).not.toMatch(/<button[^>]*disabled[^>]*>发送 \(3\)</)
  })

  it('has no cancel of its own, sending or not: the player bar\'s switch leaves editing and the overlay stops a send', () => {
    expect(labels()).toEqual(['动图', '全部帧', '清空', '发送 (3)'])
    expect(labels({ phase: 'preparing' })).toEqual(['动图', '全部帧', '清空', '准备中…'])
    expect(labels({ phase: 'redrawing', seconds: 12 })).toEqual(['动图', '全部帧', '清空', '正在修改… 12 秒'])
    expect(labels({ phase: 'finishing', seconds: 30 })).toEqual(['动图', '全部帧', '清空', '正在修改… 30 秒'])
    expect(labels({ phase: 'redrawing', seconds: 12 }, 'en')).toEqual(['GIF', 'All frames', 'Clear', 'Editing… 12s'])
  })

  it('while preparing, says the notes are being turned into a sheet and shows the send busy', () => {
    const preparing = render({ phase: 'preparing' })
    expect(preparing).toContain(`<p class="dsh-ig-gif-edit-hint">${GIF_TEXT.zh.gifEditPreparingHint}</p>`)
    expect(preparing).toContain('<button type="button" class="dsh-ig-gif-edit-send is-busy" disabled=""><span class="dsh-ig-gif-edit-spinner" aria-hidden="true"></span>准备中…</button>')
    expect(preparing).toMatch(/<button[^>]*disabled[^>]*>清空</)
    expect(render({ phase: 'preparing' }, 'en')).toContain('</span>Preparing…</button>')
  })

  it('while redrawing, says it may take a while and counts the seconds on the disabled send button', () => {
    const redrawing = render({ phase: 'redrawing', seconds: 12 })
    expect(redrawing).toContain(`<p class="dsh-ig-gif-edit-hint">${GIF_TEXT.zh.gifEditRedrawingHint}</p>`)
    expect(redrawing).toContain('<button type="button" class="dsh-ig-gif-edit-send is-busy" disabled=""><span class="dsh-ig-gif-edit-spinner" aria-hidden="true"></span>正在修改… 12 秒</button>')
    // The seconds come from the edit's clock; each tick renders the next count.
    expect(render({ phase: 'redrawing', seconds: 13 })).toContain('>正在修改… 13 秒</button>')
    const en = render({ phase: 'redrawing', seconds: 12 }, 'en')
    expect(en).toContain(GIF_TEXT.en.gifEditRedrawingHint)
    expect(en).toContain('</span>Editing… 12s</button>')
    // Once the reply is in, the count stops where it was.
    expect(render({ phase: 'finishing', seconds: 30 })).toContain('>正在修改… 30 秒</button>')
  })

  it('shows the relay error with the fallback to a plain regeneration', () => {
    const failed = render({ error: 'openai image request failed (400): unsupported or repeated form field', errorHint: GIF_TEXT.zh.gifEditFailedHint })
    expect(failed).toContain('dsh-ig-gif-edit-error')
    expect(failed).toContain(GIF_TEXT.zh.gifEditFailed)
    expect(failed).toContain(GIF_TEXT.zh.gifEditFailedHint)
    expect(failed).toContain('unsupported or repeated form field')
    expect(failed).toContain(GIF_TEXT.zh.gifEditFallbackRegenerate)
    // A failure before the request reached the relay (the sheet could not be encoded) carries no hint about the channel.
    expect(render({ error: GIF_TEXT.zh.gifSheetTooLarge })).not.toContain(GIF_TEXT.zh.gifEditFailedHint)
    // A failed edit leaves the bar as it was before the send, ready to send again.
    expect(failed).toContain(GIF_TEXT.zh.gifEditHint)
    expect(failed).toContain('<button type="button" class="dsh-ig-gif-edit-send">发送 (3)</button>')
  })
})

describe('edit overlay', () => {
  const overlay = (phase: 'preparing' | 'redrawing' | 'finishing', progress = 0, lang: 'zh' | 'en' = 'zh') =>
    renderToStaticMarkup(createElement(GifEditOverlay, { phase, progress, t: gifT(lang), onCancel() {} }))
  const text = (markup: string) => markup.replace(/<[^>]*>/g, '')

  it('names the step over the picture, with an estimated bar only while redrawing, and never seconds, a percentage or a frame', () => {
    const preparing = overlay('preparing')
    expect(preparing).toContain('<span class="dsh-ig-gif-edit-busy-text" role="status">准备中…</span>')
    expect(preparing).not.toContain('dsh-ig-gif-edit-busy-track')
    const redrawing = overlay('redrawing', 0.42)
    expect(redrawing).toContain('<span class="dsh-ig-gif-edit-busy-text" role="status">正在逐帧修改…</span>')
    expect(redrawing).toContain('style="transform:scaleX(0.42)"')
    expect(overlay('redrawing', 0.42, 'en')).toContain('>Redrawing frame by frame…</span>')
    for (const markup of [preparing, redrawing]) expect(text(markup)).not.toMatch(/\d|%/)
  })

  it('fills the bar once the reply is in and stays until the new version is filed, with nothing left to cancel', () => {
    const finishing = overlay('finishing', 1)
    expect(finishing).toContain('class="dsh-ig-gif-edit-busy is-finishing"')
    expect(finishing).toContain('style="transform:scaleX(1)"')
    expect(finishing).not.toContain(GIF_TEXT.zh.gifEditCancelSend)
    // No fade of its own: the overlay goes when the edit's phase ends, so the old version never shows through it as if it were the new one.
    expect(GIF_STYLE).not.toMatch(/\.dsh-ig-gif-edit-busy\.is-finishing\{[^}]*animation/)
  })

  it('cancels the edit from the picture while it runs, the one way to stop a send in the preview', () => {
    const onCancel = vi.fn()
    for (const phase of ['preparing', 'redrawing'] as const) {
      const cancel = button(GifEditOverlay({ phase, progress: 0.3, t, onCancel }), '取消修改')
      expect(cancel?.props.disabled).toBeUndefined()
      cancel?.props.onClick?.()
    }
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(button(GifEditOverlay({ phase: 'redrawing', progress: 0.3, t: gifT('en'), onCancel }), 'Cancel edit')).toBeDefined()
  })
})

describe('finished edit bar', () => {
  const message = t('gifEditDoneHere', { seconds: '42' })
  const bar = (props: Partial<Parameters<typeof GifEditDoneBar>[0]> = {}) =>
    renderToStaticMarkup(createElement(GifEditDoneBar, { done: { message, still: false }, availability: 'ready', t, onContinue() {}, onFinish() {}, ...props }))

  it('says how long it took and that the old version is kept, and offers going on or closing', () => {
    const markup = bar()
    expect(markup).toContain('改好了：已按评论逐帧修改，存为新版本，用了 42 秒。旧版本保留，可以切回。')
    // Only the message is announced, not the buttons after it.
    expect(markup).toContain('<div class="dsh-ig-gif-edit is-done"><p class="dsh-ig-gif-edit-done-text" role="status">')
    expect(markup).toContain('<button type="button" class="dsh-ig-gif-edit-ghost">继续修改</button>')
    expect(markup).toContain('<button type="button" class="dsh-ig-gif-edit-send">完成</button>')
    const en = renderToStaticMarkup(createElement(GifEditDoneBar, { done: { message: gifT('en')('gifEditDoneHere', { seconds: '42' }), still: false }, availability: 'ready', t: gifT('en'), onContinue() {}, onFinish() {} }))
    expect(en).toContain('saved as a new version in 42s')
    expect(en).toContain('>Keep editing</button>')
    expect(en).toContain('>Done</button>')
  })

  it('goes on editing the new version or closes the preview', () => {
    const onContinue = vi.fn()
    const onFinish = vi.fn()
    const tree = GifEditDoneBar({ done: { message, still: false }, availability: 'ready', t, onContinue, onFinish })
    button(tree, '继续修改')?.props.onClick?.()
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onFinish).not.toHaveBeenCalled()
    button(tree, '完成')?.props.onClick?.()
    expect(onFinish).toHaveBeenCalledOnce()
  })

  it('lets the new animation take notes once its frames are decoded, and a still none', () => {
    expect(bar({ availability: 'decoding' })).toContain(`<button type="button" class="dsh-ig-gif-edit-ghost" disabled="" title="${GIF_TEXT.zh.gifEditDecoding}">继续修改</button>`)
    // The plain preview, while the new animation's bytes load, has no editor to go on in.
    expect(bar({ availability: undefined, onContinue: undefined })).toContain('<button type="button" class="dsh-ig-gif-edit-ghost" disabled="">继续修改</button>')
    const still = bar({ done: { message: GIF_TEXT.zh.gifEditStill, still: true }, availability: undefined })
    expect(still).toContain(GIF_TEXT.zh.gifEditStill)
    expect(still).not.toContain('继续修改')
    expect(still).toContain('>完成</button>')
  })
})

describe('frame comment layer', () => {
  const notes: GifComment[] = [{ id: 1, frame: 0, x: 25, y: 50, text: 'first' }, { id: 2, frame: 1, x: 50, y: 50, text: 'second' }, { id: 3, frame: 0, x: 75, y: 10, text: 'third' }]
  const plan = planGifSheet(8, 16, 8)
  const sheet = { canvas: { width: plan.width, height: plan.height } as HTMLCanvasElement, plan }
  const render = (player: GifPlayer, editing: boolean, view: 'gif' | 'sheet' = 'gif', comments = notes) =>
    renderToStaticMarkup(createElement(GifCommentLayer, { player, editing, view, sheet: editing ? sheet : undefined, comments, onChange() {}, t }))
  const pins = (markup: string) => [...markup.matchAll(/<button[^>]*class="dsh-ig-gif-pin[^"]*"[^>]*>(\d+)<\/button>/g)].map(match => ({ tag: match[0], number: match[1] }))

  it('covers the frame with a placing layer while editing and shows only that frame\'s numbered pins', async () => {
    const player = readyPlayer()
    await ready(player)
    const markup = render(player, true)
    expect(markup).toMatch(/<button type="button" class="dsh-ig-gif-edit-layer" aria-label="在第 1 帧上放评论">/)
    expect(markup).not.toContain('<canvas')
    const shown = pins(markup)
    expect(shown.map(pin => pin.number)).toEqual(['1', '3'])
    expect(shown[0]?.tag).toContain('aria-label="评论 1（第 1 帧）"')
    expect(shown[0]?.tag).toContain('left:25%')
    expect(shown[0]?.tag).toContain('top:50%')
    expect(shown[0]?.tag).toContain(`title="${GIF_TEXT.zh.gifCommentView}"`)
    expect(markup).not.toContain('dsh-ig-gif-note')
    player.seek(1)
    expect(pins(render(player, true)).map(pin => pin.number)).toEqual(['2'])
    player.dispose()
  })

  it('outside editing shows a paused frame\'s pins to read, none while playing, and never the placing layer', async () => {
    const player = readyPlayer()
    await ready(player)
    expect(player.getSnapshot().playing).toBe(true)
    expect(render(player, false)).toBe('')
    player.pause()
    const paused = render(player, false)
    expect(paused).not.toContain('dsh-ig-gif-edit-layer')
    expect(pins(paused).map(pin => pin.number)).toEqual(['1', '3'])
    player.dispose()
  })

  it('lays out all frames as clickable cells with every pin in its frame, smaller', async () => {
    const player = readyPlayer()
    await ready(player)
    const markup = render(player, true, 'sheet')
    const view = sheetViewSize(plan)
    expect(markup).toContain(`<canvas class="dsh-ig-gif-sheet" width="${String(view.width)}" height="${String(view.height)}"`)
    expect(markup).not.toContain('dsh-ig-gif-edit-layer')
    const cells = markup.match(/<(?:button|div)[^>]*class="dsh-ig-gif-sheet-cell[^"]*"[^>]*>/g) ?? []
    expect(cells).toHaveLength(9)
    expect(cells.filter(cell => cell.includes('is-blank'))).toHaveLength(1)
    expect(cells[0]).toMatch(/^<button[^>]*is-current[^>]*aria-label="在第 1 帧上放评论"/)
    expect(cells[8]).toMatch(/^<div/)
    const shown = pins(markup)
    expect(shown.map(pin => pin.number)).toEqual(['1', '2', '3'])
    expect(shown.every(pin => pin.tag.includes('is-small'))).toBe(true)
    // Frame 2 is the second cell of a 3-column sheet: x 50% of a cell lands at 50% of the sheet width.
    expect(shown[1]?.tag).toContain('left:50%')
    expect(shown[1]?.tag).toContain('top:16.7%')
    expect(shown[1]?.tag).toContain('title="第 2 帧：second"')
    player.dispose()
  })

  it('shows the sheet at its display size and marks the cell of the frame on screen', async () => {
    const large = planGifSheet(16, 1024, 1024)
    const player = readyPlayer(16)
    await ready(player)
    const markup = renderToStaticMarkup(createElement(GifCommentLayer, { player, editing: true, view: 'sheet', sheet: { canvas: { width: large.width, height: large.height } as HTMLCanvasElement, plan: large }, comments: [], onChange() {}, t }))
    expect(markup).toContain('<canvas class="dsh-ig-gif-sheet" width="1040" height="1040"')
    player.seek(1)
    const after = renderToStaticMarkup(createElement(GifCommentLayer, { player, editing: true, view: 'sheet', sheet: { canvas: { width: large.width, height: large.height } as HTMLCanvasElement, plan: large }, comments: [], onChange() {}, t }))
    const cells = after.match(/<button[^>]*class="dsh-ig-gif-sheet-cell[^"]*"[^>]*>/g) ?? []
    expect(cells[1]).toContain('is-current')
    expect(cells[0]).not.toContain('is-current')
    player.dispose()
  })

  it('marks the frames with notes on the strip', async () => {
    const player = readyPlayer()
    await ready(player)
    const markup = renderToStaticMarkup(createElement(GifFilmstrip, { player, t, marks: new Set([0, 3, 99]) }))
    const marks = markup.match(/class="dsh-ig-gif-strip-mark"[^>]*style="left:([\d.]+)%"/g) ?? []
    expect(marks).toHaveLength(2)
    expect(markup).toContain('left:6.25%')
    expect(markup).toContain('left:43.75%')
    player.dispose()
  })
})
