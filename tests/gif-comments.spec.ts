import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createGifPlayer, type GifPlayer, type GifPlayerDeps } from '../src/client/gif-player.js'
import {
  GifCommentBar,
  GifCommentLayer,
  GifEditChip,
  GifEditToggle,
  commentKeyAction,
  gifEditAvailability,
  gifEditModel,
} from '../src/client/gif-comments.js'
import { GifFilmstrip } from '../src/client/gif-filmstrip.js'
import { GIF_TEXT, gifT } from '../src/client/gif-i18n.js'
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
  const render = (props: Partial<Parameters<typeof GifCommentBar>[0]> = {}, lang: 'zh' | 'en' = 'zh') =>
    renderToStaticMarkup(createElement(GifCommentBar, {
      view: 'gif', current: 3, total: 8, count: 3, sending: false, t: gifT(lang),
      onView() {}, onClear() {}, onCancel() {}, onSend() {}, onFallback() {}, ...props,
    }))

  it('counts the frame and the notes, switches between the GIF and all frames, and sends the note count', () => {
    const zh = render()
    expect(zh).toContain(GIF_TEXT.zh.gifEditHint)
    expect(zh).toContain('第 3 帧 · 共 3 条评论')
    expect(zh).toContain('aria-pressed="true">动图<')
    expect(zh).toContain('aria-pressed="false">全部帧<')
    expect(zh).toContain('>发送 (3)<')
    expect(zh).toContain('>清空<')
    expect(zh).toContain('>取消<')
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

  it('disables sending without notes or a sheet and while a request runs, when the cancel button stays live to stop it', () => {
    const empty = render({ count: 0 })
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>清空</)
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>发送 \(0\)</)
    expect(render({ total: 0 })).toMatch(/<button[^>]*disabled[^>]*>发送 \(3\)</)
    expect(render()).not.toMatch(/<button[^>]*disabled[^>]*>发送 \(3\)</)
    const sending = render({ sending: true })
    expect(sending).toMatch(/<button[^>]*disabled[^>]*>发送中…</)
    expect(sending).not.toMatch(/<button[^>]*disabled[^>]*>取消</)
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
