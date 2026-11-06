import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createGifPlayer, type GifPlayer, type GifPlayerDeps } from '../src/client/gif-player.js'
import {
  GifCommentBar,
  GifCommentLayer,
  commentKeyAction,
  forgetGifEditFailure,
  gifEditAvailability,
  gifEditFailure,
  gifEditModel,
  rememberGifEditFailure,
} from '../src/client/gif-comment-editor.js'
import { planGifSheet, sheetViewSize, type GifComment } from '../src/client/gif-sheet.js'
import { DICT, type DictKey } from '../src/client/plugin-i18n.js'
import { gifBytes } from './gif-fixture.js'

const translate = (lang: 'zh' | 'en') => (key: DictKey, params?: Record<string, string>) => {
  let text: string = DICT[lang][key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
  return text
}

function readyPlayer(frames = 8): GifPlayer {
  const deps: GifPlayerDeps = {
    decode: async () => ({ frames: Array.from({ length: frames }, () => ({ width: 16, height: 8, close: vi.fn() }) as unknown as ImageBitmap), delaysMs: Array.from({ length: frames }, () => 100) }),
    encodeFrame: async () => undefined,
    hidden: () => false,
    setTimeout: () => 1,
    clearTimeout: () => {},
  }
  const player = createGifPlayer(new Blob([gifBytes(frames)], { type: 'image/gif' }), deps)
  player.setVisible('card', true)
  return player
}

const ready = (player: GifPlayer) => vi.waitFor(() => { expect(player.getSnapshot().status).toBe('ready') })

describe('frame comment availability', () => {
  const frames = (count: number) => Array.from({ length: count }, () => ({}) as ImageBitmap)
  const info = (count: number) => ({ frames: count, width: 16, height: 8, delaysMs: [] })

  it('offers the editor only for an animated OpenAI-shaped result whose frames are decoded and within the GIF contract', () => {
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

  it('remembers a failed channel for the session, by provider and channel, until an edit on it succeeds', () => {
    expect(gifEditFailure({ provider: 'openai-compat', channel: 'relay-x' })).toBeUndefined()
    rememberGifEditFailure({ provider: 'openai-compat', channel: 'relay-x' }, 'unsupported or repeated form field')
    expect(gifEditFailure({ provider: 'openai-compat', channel: 'relay-x' })).toBe('unsupported or repeated form field')
    expect(gifEditFailure({ provider: 'openai-compat', channel: 'relay-y' })).toBeUndefined()
    expect(gifEditFailure({ provider: 'openai-compat' })).toBeUndefined()
    expect(gifEditFailure({ provider: 'openai', channel: 'relay-x' })).toBeUndefined()
    forgetGifEditFailure({ provider: 'openai-compat', channel: 'relay-y' })
    expect(gifEditFailure({ provider: 'openai-compat', channel: 'relay-x' })).toBe('unsupported or repeated form field')
    forgetGifEditFailure({ provider: 'openai-compat', channel: 'relay-x' })
    expect(gifEditFailure({ provider: 'openai-compat', channel: 'relay-x' })).toBeUndefined()
  })

  it('confirms a note on Enter and closes it on Escape, but never while an input method is composing', () => {
    const key = (key: string, shiftKey = false, isComposing = false) => commentKeyAction({ key, shiftKey, nativeEvent: { isComposing } })
    expect(key('Enter')).toBe('confirm')
    expect(key('Enter', true)).toBeUndefined()
    expect(key('Enter', false, true)).toBeUndefined()
    expect(key('Escape')).toBe('close')
    expect(key('Escape', false, true)).toBeUndefined()
    expect(key('a')).toBeUndefined()
  })
})

describe('frame comment bar', () => {
  const notes: GifComment[] = [{ id: 1, frame: 0, x: 10, y: 10, text: 'a' }, { id: 2, frame: 2, x: 50, y: 50, text: 'b' }, { id: 3, frame: 2, x: 70, y: 20, text: 'c' }]
  const render = (props: Partial<Parameters<typeof GifCommentBar>[0]> = {}, lang: 'zh' | 'en' = 'zh') =>
    renderToStaticMarkup(createElement(GifCommentBar, {
      current: 3, total: 8, comments: notes, view: 'gif', sending: false, canSend: true, t: translate(lang),
      onView() {}, onClear() {}, onCancel() {}, onSend() {}, onFallback() {}, ...props,
    }))

  it('counts the frame and the notes, toggles the view and sends the note count', () => {
    const zh = render()
    expect(zh).toContain(DICT.zh.gifEditHint)
    expect(zh).toContain('第 3/8 帧 · 3 条评论')
    expect(zh).toContain('aria-pressed="true">动图<')
    expect(zh).toContain('aria-pressed="false">拼图<')
    expect(zh).toContain('>发送 (3)<')
    expect(zh).toContain('>清空评论<')
    expect(zh).toContain('>取消<')
    expect(zh).not.toContain('dsh-ig-gif-edit-error')
    expect(zh).not.toContain('dsh-ig-gif-edit-notice')
    const en = render({ view: 'sheet' }, 'en')
    expect(en).toContain('Frame 3/8 · 3 notes')
    expect(en).toContain('aria-pressed="true">Sheet<')
    expect(en).toContain('>Send (3)<')
  })

  it('disables sending without notes or frames and while a request runs, and hides the clear button when there is nothing to clear', () => {
    const empty = render({ comments: [] })
    expect(empty).not.toContain('清空评论')
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>发送 \(0\)</)
    expect(render({ canSend: false })).toMatch(/<button[^>]*disabled[^>]*>发送 \(3\)</)
    expect(render()).not.toMatch(/<button[^>]*disabled[^>]*>发送 \(3\)</)
    const sending = render({ sending: true })
    expect(sending).toMatch(/<button[^>]*disabled[^>]*>发送 \(3\)</)
    expect(sending).toMatch(/<button[^>]*disabled[^>]*>取消</)
  })

  it('shows the relay error with the fallback, and the earlier failure of this channel with the same fallback', () => {
    const failed = render({ error: 'openai image request failed (400): unsupported or repeated form field', errorHint: DICT.zh.gifEditFailedHint })
    expect(failed).toContain('dsh-ig-gif-edit-error')
    expect(failed).toContain(DICT.zh.gifEditFailed)
    expect(failed).toContain(DICT.zh.gifEditFailedHint)
    expect(failed).toContain('unsupported or repeated form field')
    expect(failed).toContain(DICT.zh.gifEditFallbackRegenerate)
    // A failure before the request reached the relay (the sheet could not be encoded) carries no hint about the channel.
    expect(render({ error: DICT.zh.gifSheetTooLarge })).not.toContain(DICT.zh.gifEditFailedHint)
    const notice = render({ notice: 'unsupported or repeated form field' })
    expect(notice).toContain('dsh-ig-gif-edit-notice')
    expect(notice).toContain('该渠道上次改图失败：unsupported or repeated form field')
    expect(notice).toContain(DICT.zh.gifEditFallbackRegenerate)
  })
})

describe('frame comment layer', () => {
  const notes: GifComment[] = [{ id: 1, frame: 0, x: 25, y: 50, text: 'first' }, { id: 2, frame: 1, x: 50, y: 50, text: 'second' }, { id: 3, frame: 0, x: 75, y: 10, text: 'third' }]
  const plan = planGifSheet(8, 16, 8)
  const sheet = { width: plan.width, height: plan.height } as HTMLCanvasElement
  const render = (player: GifPlayer, view: 'gif' | 'sheet', comments = notes) =>
    renderToStaticMarkup(createElement(GifCommentLayer, { player, view, sheet, plan, comments, onChange() {}, t: translate('zh') }))
  const pins = (markup: string) => [...markup.matchAll(/<button[^>]*class="dsh-ig-gif-pin[^"]*"[^>]*>/g)].map(match => match[0])

  it('covers the paused frame with a crosshair layer and shows only the notes of that frame', async () => {
    const player = readyPlayer()
    await ready(player)
    const markup = render(player, 'gif')
    expect(markup).toMatch(/<div[^>]*class="dsh-ig-gif-edit-layer"[^>]*role="button"[^>]*tabindex="0"[^>]*aria-label="在当前帧上放评论"/)
    expect(markup).not.toContain('<canvas')
    const shown = pins(markup)
    expect(shown).toHaveLength(2)
    expect(shown[0]).toContain('aria-label="第 1 条评论（第 1 帧）"')
    expect(shown[0]).toContain('left:25%')
    expect(shown[0]).toContain('top:50%')
    expect(shown[0]).toContain('title="first"')
    expect(shown[1]).toContain('aria-label="第 3 条评论（第 1 帧）"')
    expect(markup).not.toContain('第 2 条评论')
    expect(markup).not.toContain('dsh-ig-gif-comment-pop')
    player.seek(1)
    const next = pins(render(player, 'gif'))
    expect(next).toHaveLength(1)
    expect(next[0]).toContain('aria-label="第 2 条评论（第 2 帧）"')
    player.dispose()
  })

  it('lays the sheet out as clickable cells with every note placed in its frame', async () => {
    const player = readyPlayer()
    await ready(player)
    const markup = render(player, 'sheet')
    const view = sheetViewSize(plan)
    expect(markup).toContain(`<canvas class="dsh-ig-gif-sheet" width="${String(view.width)}" height="${String(view.height)}"`)
    expect(markup).not.toContain('dsh-ig-gif-edit-layer')
    const cells = markup.match(/<div[^>]*class="dsh-ig-gif-sheet-cell[^"]*"[^>]*>/g) ?? []
    expect(cells).toHaveLength(9)
    expect(cells.filter(cell => cell.includes('is-blank'))).toHaveLength(1)
    expect(cells[0]).toMatch(/role="button"[^>]*tabindex="0"[^>]*aria-label="第 1 帧，共 8 帧"/)
    expect(cells[0]).toContain('is-current')
    expect(cells[8]).not.toContain('role="button"')
    expect(markup).toContain('>8<')
    expect(markup).not.toContain('>9<')
    const shown = pins(markup)
    expect(shown).toHaveLength(3)
    // Frame 1 (0-based) is the second cell of a 3-column sheet: x 50% of a cell lands at 50% of the sheet width.
    expect(shown[1]).toContain('left:50%')
    expect(shown[1]).toContain('top:16.7%')
    expect(shown[1]).toContain('is-other-frame')
    expect(shown[0]).not.toContain('is-other-frame')
    player.dispose()
  })

  it('shows the sheet at its display size, and follows the player to the frame a cell was placed on', async () => {
    const large = planGifSheet(16, 1024, 1024)
    const player = readyPlayer(16)
    await ready(player)
    const markup = renderToStaticMarkup(createElement(GifCommentLayer, { player, view: 'sheet', sheet: { width: large.width, height: large.height } as HTMLCanvasElement, plan: large, comments: [], onChange() {}, t: translate('zh') }))
    expect(markup).toContain('<canvas class="dsh-ig-gif-sheet" width="1040" height="1040"')
    player.dispose()
    // Placing a note on a cell seeks the player there, so the pin shows solid and the counter and highlight move with it.
    const seeking = readyPlayer()
    await ready(seeking)
    seeking.seek(1)
    const after = render(seeking, 'sheet')
    const cells = after.match(/<div[^>]*class="dsh-ig-gif-sheet-cell[^"]*"[^>]*>/g) ?? []
    expect(cells[1]).toContain('is-current')
    expect(cells[0]).not.toContain('is-current')
    const shown = pins(after)
    expect(shown[1]).not.toContain('is-other-frame')
    expect(shown[0]).toContain('is-other-frame')
    seeking.dispose()
  })
})
