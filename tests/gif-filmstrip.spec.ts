import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GifFilmstrip, coverCrop, filmstripFrameAt } from '../src/client/gif-filmstrip.js'
import { createGifPlayer } from '../src/client/gif-player.js'
import { GIF_TEXT, gifT } from '../src/client/gif-i18n.js'
import { gifBytes } from './gif-fixture.js'

const t = gifT('zh')

describe('GIF filmstrip', () => {
  it('maps a pointer to the frame whose cell it is over, one equal cell per frame', () => {
    expect(filmstripFrameAt(0, 350, 8)).toBe(0)
    expect(filmstripFrameAt(43, 350, 8)).toBe(0)
    expect(filmstripFrameAt(44, 350, 8)).toBe(1)
    expect(filmstripFrameAt(349, 350, 8)).toBe(7)
    // Outside the strip, or before it has a size, the ends hold.
    expect(filmstripFrameAt(-5, 350, 8)).toBe(0)
    expect(filmstripFrameAt(400, 350, 8)).toBe(7)
    expect(filmstripFrameAt(10, 0, 8)).toBe(0)
    expect(filmstripFrameAt(10, 350, 0)).toBe(0)
  })

  it('crops each frame to fill its cell from the centre', () => {
    // A square frame in a tall cell keeps its full height and the middle columns.
    const close = (crop: Record<string, number>, expected: Record<string, number>) => {
      for (const [key, value] of Object.entries(expected)) expect(crop[key]).toBeCloseTo(value, 6)
    }
    close(coverCrop(512, 512, 22, 40), { sx: 115.2, sy: 0, sw: 281.6, sh: 512 })
    // A wide cell keeps the full width and the middle rows.
    close(coverCrop(512, 512, 175, 40), { sx: 0, sy: 197.485714, sw: 512, sh: 117.028571 })
  })

  it('renders a keyboard slider that names the frame and stays disabled until frames exist', () => {
    const player = createGifPlayer(new Blob([gifBytes(3)], { type: 'image/gif' }), { decode: async () => undefined })
    const markup = renderToStaticMarkup(createElement(GifFilmstrip, { player, t }))
    expect(markup).toContain('role="slider"')
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).toContain(`title="${GIF_TEXT.zh.gifStripHint}"`)
    expect(markup).toContain(`aria-label="${GIF_TEXT.zh.gifFrames}"`)
    player.dispose()
  })
})
