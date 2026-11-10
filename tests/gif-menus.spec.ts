import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GifDownloadMenu, GifSpeedPanel, gifDownloadItems } from '../src/client/gif-menus.js'
import { GIF_TEXT, gifT } from '../src/client/gif-i18n.js'
import { createGifPlayer } from '../src/client/gif-player.js'
import { gifBytes } from './gif-fixture.js'

const t = gifT('zh')

describe('GIF download menu', () => {
  it('offers the GIF and the current frame at 1x', () => {
    expect(gifDownloadItems(t, 1, true, 4)).toEqual([
      { kind: 'gif', label: '下载 GIF', hint: GIF_TEXT.zh.gifDownloadHintOriginal, disabled: false },
      { kind: 'frame', label: GIF_TEXT.zh.gifDownloadFrame, hint: '第 4 帧，静态图', disabled: false },
    ])
  })

  it('names the speed of a retimed GIF and adds the original-speed file only then', () => {
    expect(gifDownloadItems(t, 1.3, true, 2).map(item => [item.kind, item.label, item.hint])).toEqual([
      ['gif', '下载 GIF（1.3×）', GIF_TEXT.zh.gifDownloadHintSpeed],
      ['original', GIF_TEXT.zh.gifDownloadOriginal, GIF_TEXT.zh.gifDownloadOriginalHint],
      ['frame', GIF_TEXT.zh.gifDownloadFrame, '第 2 帧，静态图'],
    ])
    expect(gifDownloadItems(gifT('en'), 1.3, true, 1)[0]?.label).toBe('Download GIF (1.3×)')
  })

  it('disables the frame until frames are decoded', () => {
    expect(gifDownloadItems(t, 1, false, 1).find(item => item.kind === 'frame')?.disabled).toBe(true)
  })

  it('renders a closed menu trigger that announces its popup', () => {
    const player = createGifPlayer(new Blob([gifBytes(3)], { type: 'image/gif' }), { decode: async () => undefined, encodeFrame: async () => undefined, hidden: () => false, setTimeout: () => 1, clearTimeout: () => {} })
    const markup = renderToStaticMarkup(createElement(GifDownloadMenu, { player, t, variant: 'toolbar', onDownload() {} }))
    player.dispose()
    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain(`title="${GIF_TEXT.zh.gifDownloadMenu}"`)
    expect(markup).not.toContain('role="menu"')
  })
})

describe('GIF speed panel', () => {
  it('is a 0.2x-2x slider in 0.1 steps that shows no numbers of its own', () => {
    const markup = renderToStaticMarkup(createElement(GifSpeedPanel, { speed: 1.3, t, onChange() {} }))
    expect(markup).toContain('type="range"')
    expect(markup).toContain('min="0.2"')
    expect(markup).toContain('max="2"')
    expect(markup).toContain('step="0.1"')
    expect(markup).toContain('value="1.3"')
    expect(markup).toContain('aria-valuetext="1.3×"')
    expect(markup).toContain(`title="${GIF_TEXT.zh.gifSpeedHint}"`)
    // The value is shown on the trigger only.
    expect(markup.replace(/aria-valuetext="[^"]*"|value="[^"]*"/g, '')).not.toContain('1.3')
  })
})
