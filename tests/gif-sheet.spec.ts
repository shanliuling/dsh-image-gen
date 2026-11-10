import { describe, expect, it, vi } from 'vitest'
import {
  GIF_COMMENTS_MAX,
  GIF_COMMENT_MAX_CHARS,
  composeFallbackPrompt,
  composeGifEditPrompt,
  drawGifSheet,
  encodeSheetWithinLimit,
  gifEditFrameDurationMs,
  gifEditRequest,
  planGifSheet,
  sheetPinPosition,
  sheetViewSize,
  type GifComment,
  type GifSheetPlan,
  type SheetEncoder,
} from '../src/client/gif-sheet.js'

const OFFICIAL_FIRST_LINE = 'Re-animate the GIF with these changes. Coordinates are relative to each frame. Make sure all frames are equal sized.'

const comment = (id: number, frame: number, x: number, y: number, text: string): GifComment => ({ id, frame, x, y, text })

describe('contact sheet layout', () => {
  it('tiles the frames into a near-square grid in reading order and counts the blank cells', () => {
    expect(planGifSheet(2, 512, 512)).toMatchObject({ cols: 2, rows: 1, blanks: 0, cellW: 512, cellH: 512, width: 1024, height: 512, frames: 2 })
    expect(planGifSheet(5, 512, 512)).toMatchObject({ cols: 3, rows: 2, blanks: 1 })
    expect(planGifSheet(8, 512, 512)).toMatchObject({ cols: 3, rows: 3, blanks: 1, width: 1536, height: 1536 })
    expect(planGifSheet(9, 512, 512)).toMatchObject({ cols: 3, rows: 3, blanks: 0 })
    expect(planGifSheet(16, 512, 512)).toMatchObject({ cols: 4, rows: 4, blanks: 0 })
  })

  it('shrinks the cells to keep the longest sheet edge within the provider limit, snapping to 16 px', () => {
    expect(planGifSheet(16, 1024, 1024)).toMatchObject({ cols: 4, rows: 4, cellW: 960, cellH: 960, width: 3840, height: 3840 })
    // 4 × 1100 = 4400 > 3840: scale 0.8727 → 960 × 610.9 → both snapped down to a multiple of 16.
    expect(planGifSheet(16, 1100, 700)).toMatchObject({ cellW: 960, cellH: 608, width: 3840, height: 2432 })
    // Within the limit, the frames keep their own pixel size even when it is not a multiple of 16.
    expect(planGifSheet(8, 1000, 600)).toMatchObject({ cellW: 1000, cellH: 600, width: 3000, height: 1800 })
    expect(planGifSheet(4, 100, 100, 150)).toMatchObject({ cols: 2, rows: 2, cellW: 64, cellH: 64, width: 128 })
  })

  it('shows the sheet at a display size instead of copying the full sheet, keeping the aspect ratio', () => {
    expect(sheetViewSize(planGifSheet(8, 16, 8))).toEqual({ width: 48, height: 24 })
    expect(sheetViewSize(planGifSheet(16, 1024, 1024))).toEqual({ width: 1040, height: 1040 })
    expect(sheetViewSize(planGifSheet(16, 1100, 700))).toEqual({ width: 1040, height: 659 })
    expect(sheetViewSize(planGifSheet(2, 400, 1200), 600)).toEqual({ width: 400, height: 600 })
  })

  it('maps a point inside one frame to the same point on the sheet', () => {
    const plan = planGifSheet(8, 512, 512)
    expect(sheetPinPosition(comment(1, 4, 50, 50, ''), plan)).toEqual({ x: 50, y: 50 })
    expect(sheetPinPosition(comment(1, 0, 50, 50, ''), plan)).toEqual({ x: 16.7, y: 16.7 })
    expect(sheetPinPosition(comment(1, 2, 0, 0, ''), plan)).toEqual({ x: 66.7, y: 0 })
    expect(sheetPinPosition(comment(1, 7, 100, 100, ''), plan)).toEqual({ x: 66.7, y: 100 })
  })

  it('paints every frame into its cell on a white sheet', () => {
    const calls: Array<[unknown, number, number, number, number]> = []
    const fills: Array<[string, number, number, number, number]> = []
    const context = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) { fills.push([this.fillStyle, x, y, w, h]) },
      drawImage(image: unknown, x: number, y: number, w: number, h: number) { calls.push([image, x, y, w, h]) },
    }
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) }
    const frames = Array.from({ length: 5 }, (_, index) => ({ id: index }))
    const plan = planGifSheet(5, 200, 100)
    const result = drawGifSheet(frames as unknown as ImageBitmap[], plan, () => canvas as unknown as HTMLCanvasElement)
    expect(result).toBe(canvas)
    expect(canvas).toMatchObject({ width: 600, height: 200 })
    expect(fills).toEqual([['#fff', 0, 0, 600, 200]])
    expect(calls).toEqual([
      [frames[0], 0, 0, 200, 100], [frames[1], 200, 0, 200, 100], [frames[2], 400, 0, 200, 100],
      [frames[3], 0, 100, 200, 100], [frames[4], 200, 100, 200, 100],
    ])
  })
})

describe('contact sheet encoding', () => {
  const canvas = { width: 1536, height: 1536 } as HTMLCanvasElement
  const plan: GifSheetPlan = planGifSheet(8, 512, 512)
  const blobOf = (bytes: number, type: string) => new Blob([new Uint8Array(bytes)], { type })
  /** Fake encoder: PNG is 5 MB, JPEG shrinks with quality and scale. */
  const encoder: SheetEncoder = vi.fn(async (_canvas, attempt) => attempt.type === 'image/png'
    ? blobOf(5_000_000, 'image/png')
    : blobOf(Math.round(3_000_000 * attempt.quality * attempt.scale * attempt.scale), 'image/jpeg'))

  it('tries PNG first and takes the first attempt under the smaller of the host limit and 4 MB', async () => {
    const result = await encodeSheetWithinLimit(canvas, plan, 10_000_000, encoder)
    expect(result.mediaType).toBe('image/jpeg')
    expect(result.blob.size).toBe(2_550_000)
    expect(result.plan).toEqual(plan)
    expect(vi.mocked(encoder).mock.calls.map(call => call[1])).toEqual([
      { scale: 1, type: 'image/png', quality: 1 },
      { scale: 1, type: 'image/jpeg', quality: 0.85 },
    ])
  })

  it('keeps PNG when it fits and scales the plan down with the attempt that finally fits', async () => {
    const png = await encodeSheetWithinLimit(canvas, plan, 10_000_000, async () => blobOf(1_000, 'image/png'))
    expect(png.mediaType).toBe('image/png')
    expect(png.plan).toEqual(plan)
    const small = await encodeSheetWithinLimit(canvas, plan, 600_000, encoder)
    // 3 MB × 0.6 × 0.5² = 450 000 is the first attempt under 600 000.
    expect(small.blob.size).toBe(450_000)
    expect(small.plan).toMatchObject({ cols: 3, rows: 3, blanks: 1, cellW: 256, cellH: 256, width: 768, height: 768 })
  })

  it('skips attempts the browser could not encode and reports a sheet that never fits', async () => {
    const result = await encodeSheetWithinLimit(canvas, plan, 10_000_000, async (_canvas, attempt) => attempt.type === 'image/png' ? undefined : blobOf(10, 'image/jpeg'))
    expect(result.mediaType).toBe('image/jpeg')
    await expect(encodeSheetWithinLimit(canvas, plan, 10_000_000, async () => blobOf(9_000_000, 'image/png'))).rejects.toThrow('sheet-too-large')
  })
})

describe('frame comment prompts', () => {
  const plan = planGifSheet(8, 512, 512)
  const notes = [
    comment(1, 6, 50, 50, '笑容再大一点'),
    comment(2, 2, 42.4, 60.6, '爪子被截掉了，把左前爪完整画在画面里'),
    comment(3, 2, 80, 20, '去掉这行\n多余的文字'),
  ]

  const frame = { width: 512, height: 512 }

  it('opens with the official instruction, explains the sheet, then groups the notes by frame the way ChatGPT writes them', () => {
    const prompt = composeGifEditPrompt(notes, plan, frame)
    const lines = prompt.split('\n')
    expect(lines[0]).toBe(OFFICIAL_FIRST_LINE)
    expect(lines[1]).toBe('The reference image is a contact sheet of the original animation: 8 frames of 512x512 pixels, arranged in 3 columns x 3 rows in reading order (left to right, top to bottom); frame 1 is the top-left cell and the last cell is intentionally blank. The notes below are grouped by frame; each point is given as (x, y) in percent of that frame\'s width and height from its top-left corner.')
    expect(lines[2]).toBe('Produce a 8-frame looping GIF with frames of 512x512 pixels, keep the character, style, motion and every frame unchanged except for the requested changes, and keep the animation continuous across frames.')
    expect(lines.slice(3)).toEqual([
      '',
      'Frame #3:',
      '(x: 42.4%, y: 60.6%): 爪子被截掉了，把左前爪完整画在画面里',
      '(x: 80%, y: 20%): 去掉这行 多余的文字',
      '',
      'Frame #7:',
      '(x: 50%, y: 50%): 笑容再大一点',
    ])
  })

  it('names the cell size actually sent and the frame size asked for, pluralizes the blank cells and omits the clause for a full grid', () => {
    // A sheet scaled down to fit the provider limit still asks for frames of the original size.
    const scaled = { ...planGifSheet(16, 1024, 1024) }
    const prompt = composeGifEditPrompt([comment(1, 0, 10, 10, 'x')], scaled, { width: 1024, height: 1024 })
    expect(prompt).toContain('16 frames of 960x960 pixels, arranged in 4 columns x 4 rows')
    expect(prompt).toContain('Produce a 16-frame looping GIF with frames of 1024x1024 pixels')
    expect(prompt).not.toContain('blank')
    expect(composeGifEditPrompt([comment(1, 0, 10, 10, 'x')], planGifSheet(10, 64, 64), { width: 64, height: 64 })).toContain('and the last 2 cells are intentionally blank.')
  })

  it('rewrites the notes as timing hints for a plain regeneration, without coordinates or a previous version', () => {
    const prompt = composeFallbackPrompt('  a cat waving  ', notes, 8)
    expect(prompt).toBe([
      'a cat waving',
      '',
      'Additional requirements for this animation (8 frames):',
      '- Early in the animation (around frame 3 of 8): 爪子被截掉了，把左前爪完整画在画面里',
      '- Early in the animation (around frame 3 of 8): 去掉这行 多余的文字',
      '- Late in the animation (around frame 7 of 8): 笑容再大一点',
    ].join('\n'))
    expect(prompt).not.toMatch(/%|previous/i)
    expect(composeFallbackPrompt('p', [comment(1, 4, 0, 0, 'mid')], 8)).toContain('- Midway through the animation (around frame 5 of 8): mid')
  })

  it('retimes the frame delay by the playback speed within the provider range, and leaves an unknown delay out', () => {
    expect(gifEditFrameDurationMs(120, 2)).toBe(60)
    expect(gifEditFrameDurationMs(120, 0.5)).toBe(240)
    expect(gifEditFrameDurationMs(30, 2)).toBe(20)
    expect(gifEditFrameDurationMs(1500, 0.5)).toBe(2000)
    expect(gifEditFrameDurationMs(125, 1)).toBe(130)
    expect(gifEditFrameDurationMs(0, 1)).toBeUndefined()
    expect(gifEditFrameDurationMs(Number.NaN, 1)).toBeUndefined()
  })

  it('bounds the number and length of notes', () => {
    expect(GIF_COMMENTS_MAX).toBe(32)
    expect(GIF_COMMENT_MAX_CHARS).toBe(500)
  })
})

describe('frame comment edit request', () => {
  const image = { provider: 'openai-compat', channel: 'relay', model: 'gpt-image-2.6-flare', output: '768x768', prompt: '一只橘猫挥手打招呼的循环表情包' }
  const notes = [comment(1, 4, 30, 70, '左前爪画出框了，收回画面内')]
  const plan = planGifSheet(8, 768, 768)
  const sheet = { mediaType: 'image/jpeg' as const, data: 'AAAA', plan: { ...plan, cellW: 384, cellH: 384, width: 1152, height: 1152 } }
  const frame = { width: 768, height: 768, delaysMs: [100, 100, 100, 100, 100, 100, 100, 40] }

  it('builds an edit of the version shown: its channel, the editing model, the sheet as the only reference and a GIF of its frames', () => {
    const request = gifEditRequest({ image, model: 'relay-edit', comments: notes, sheet, frame, speed: 2 })
    expect(request).toMatchObject({ mode: 'edit', provider: 'openai-compat', channel: 'relay', model: 'relay-edit', ratio: '1:1', quality: 'standard' })
    expect(request.references).toEqual([{ mediaType: 'image/jpeg', data: 'AAAA', name: 'gif-frames-sheet.jpg' }])
    // The frame count is the sheet's, the delay is the one the frames play at (their mode) retimed by the speed, the size the original frame.
    expect(request.output).toEqual({ format: 'gif', frameCount: 8, frameDurationMs: 50, size: '768x768' })
    const lines = request.prompt.split('\n')
    expect(lines[0]).toBe(OFFICIAL_FIRST_LINE)
    expect(lines[1]).toContain('8 frames of 384x384 pixels')
    expect(lines[2]).toContain('with frames of 768x768 pixels')
    expect(lines.slice(3)).toEqual(['', 'Frame #5:', '(x: 30%, y: 70%): 左前爪画出框了，收回画面内'])
    expect(request.prompt).not.toContain(image.prompt)
    expect(request).not.toHaveProperty('watermark')
  })

  it('follows the playback speed for the delay and leaves out a frame size the contract would not take', () => {
    expect(gifEditRequest({ image, model: 'm', comments: notes, sheet, frame, speed: 1 }).output?.frameDurationMs).toBe(100)
    expect(gifEditRequest({ image, model: 'm', comments: notes, sheet, frame, speed: 0.5 }).output?.frameDurationMs).toBe(200)
    // Delays the player could not read: no delay, the provider's default applies.
    expect(gifEditRequest({ image, model: 'm', comments: notes, sheet, frame: { ...frame, delaysMs: [] }, speed: 1 }).output).not.toHaveProperty('frameDurationMs')
    const odd = gifEditRequest({ image, model: 'm', comments: notes, sheet: { ...sheet, mediaType: 'image/png' }, frame: { ...frame, width: 1000, height: 600 }, speed: 1 })
    expect(odd.output).toEqual({ format: 'gif', frameCount: 8, frameDurationMs: 100 })
    expect(odd.prompt).toContain('with frames of 1000x600 pixels')
    expect(odd.references?.[0]?.name).toBe('gif-frames-sheet.png')
  })
})
