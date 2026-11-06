/**
 * The contact sheet a frame-comment edit sends as its reference image, and the
 * prompt and request built around it. An edits endpoint takes a still, so
 * every frame of the animation is tiled into one near-square grid in reading
 * order; the prompt explains the grid and anchors each note inside its frame.
 * Pure except for the canvas work, which takes injectable canvas and encoder
 * stand-ins.
 */
import { GIF_FRAME_DURATION_MS_MAX, GIF_FRAME_DURATION_MS_MIN, GIF_SHEET_MAX_EDGE, type StudioGenerateRequest } from '../shared.js'
import { gifFrameDurationMs } from '../gif-info.js'
import { conversationRegenerateRequest, gifOutputRequest, type RegeneratableImage } from './conversation-regenerate.js'
import { extension } from './studio-helpers.js'

export const GIF_COMMENT_MAX_CHARS = 500
export const GIF_COMMENTS_MAX = 32
/** Longest edge of the sheet as displayed in the editor: twice the card's 520 px for high-density screens. */
const SHEET_VIEW_MAX_EDGE = 1040

/** Matches the opening line ChatGPT sends for a GIF edit, so the model reads the sheet and the coordinates by the same convention. */
const GIF_EDIT_INSTRUCTION = 'Re-animate the GIF with these changes. Coordinates are relative to each frame. Make sure all frames are equal sized.'

export interface GifComment {
  /** Creation order; also the number on the pin. */
  id: number
  /** Zero-based frame index. */
  frame: number
  /** Position inside that frame, in percent of its width and height from the top-left corner. */
  x: number
  y: number
  text: string
}

export interface GifSheetPlan {
  cols: number
  rows: number
  /** Cell size in sheet pixels; the frame size unless the sheet had to shrink. */
  cellW: number
  cellH: number
  width: number
  height: number
  /** Trailing empty cells of the grid. */
  blanks: number
  frames: number
}

export interface SheetEncodeAttempt { scale: number; type: 'image/png' | 'image/jpeg'; quality: number }
export type SheetEncoder = (canvas: HTMLCanvasElement, attempt: SheetEncodeAttempt) => Promise<Blob | undefined>
export interface EncodedSheet { blob: Blob; mediaType: 'image/png' | 'image/jpeg'; plan: GifSheetPlan }

/**
 * Near-square grid: cols = ceil(sqrt(n)). The cells shrink, snapped down to
 * 16 px, only when the sheet's longest edge would exceed the provider limit.
 */
export function planGifSheet(frames: number, frameW: number, frameH: number, maxEdge = GIF_SHEET_MAX_EDGE): GifSheetPlan {
  const cols = Math.max(1, Math.ceil(Math.sqrt(frames)))
  const rows = Math.max(1, Math.ceil(frames / cols))
  const longest = Math.max(cols * frameW, rows * frameH)
  let cellW = frameW
  let cellH = frameH
  if (longest > maxEdge) {
    const scale = maxEdge / longest
    cellW = Math.max(16, Math.floor(frameW * scale / 16) * 16)
    cellH = Math.max(16, Math.floor(frameH * scale / 16) * 16)
  }
  return { cols, rows, cellW, cellH, width: cols * cellW, height: rows * cellH, blanks: cols * rows - frames, frames }
}

/** The size to show the sheet at: the full sheet scaled into the display edge, so the editor does not hold a second full-size copy. */
export function sheetViewSize(plan: Pick<GifSheetPlan, 'width' | 'height'>, maxEdge = SHEET_VIEW_MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(plan.width, plan.height, 1))
  return { width: Math.max(1, Math.round(plan.width * scale)), height: Math.max(1, Math.round(plan.height * scale)) }
}

/** A point inside one frame, as the same point on the whole sheet (percent, one decimal). */
export function sheetPinPosition(comment: Pick<GifComment, 'frame' | 'x' | 'y'>, plan: GifSheetPlan): { x: number; y: number } {
  const col = comment.frame % plan.cols
  const row = Math.floor(comment.frame / plan.cols)
  const round = (value: number) => Math.round(value * 10) / 10
  return { x: round((col + comment.x / 100) / plan.cols * 100), y: round((row + comment.y / 100) / plan.rows * 100) }
}

/** Paint the frames into their cells on a white sheet; blank cells stay white. */
export function drawGifSheet(frames: readonly CanvasImageSource[], plan: GifSheetPlan, createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')): HTMLCanvasElement {
  const canvas = createCanvas()
  canvas.width = plan.width
  canvas.height = plan.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('sheet-canvas-unavailable')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, plan.width, plan.height)
  frames.forEach((frame, index) => {
    context.drawImage(frame, (index % plan.cols) * plan.cellW, Math.floor(index / plan.cols) * plan.cellH, plan.cellW, plan.cellH)
  })
  return canvas
}

/** Same ladder as the canvas selection preview: PNG, then JPEG at falling quality and scale. */
const SHEET_ENCODE_ATTEMPTS: readonly SheetEncodeAttempt[] = [
  { scale: 1, type: 'image/png', quality: 1 },
  { scale: 1, type: 'image/jpeg', quality: 0.85 },
  { scale: 0.75, type: 'image/jpeg', quality: 0.7 },
  { scale: 0.5, type: 'image/jpeg', quality: 0.6 },
  { scale: 0.25, type: 'image/jpeg', quality: 0.5 },
]

/**
 * First attempt that fits both the host limit and a modest request budget.
 * The returned plan is scaled with the attempt, so the prompt can name the
 * cell size that was actually sent.
 */
export async function encodeSheetWithinLimit(canvas: HTMLCanvasElement, plan: GifSheetPlan, maxBytes: number, encode: SheetEncoder = encodeCanvas): Promise<EncodedSheet> {
  const budget = Math.min(maxBytes, 4_000_000)
  for (const attempt of SHEET_ENCODE_ATTEMPTS) {
    const blob = await encode(canvas, attempt)
    if (blob === undefined || blob.size > budget) continue
    return { blob, mediaType: attempt.type, plan: scaledPlan(plan, attempt.scale) }
  }
  throw new Error('sheet-too-large')
}

function scaledPlan(plan: GifSheetPlan, scale: number): GifSheetPlan {
  if (scale === 1) return plan
  const cellW = Math.round(plan.cellW * scale)
  const cellH = Math.round(plan.cellH * scale)
  return { ...plan, cellW, cellH, width: plan.cols * cellW, height: plan.rows * cellH }
}

async function encodeCanvas(canvas: HTMLCanvasElement, attempt: SheetEncodeAttempt): Promise<Blob | undefined> {
  let source = canvas
  if (attempt.scale !== 1) {
    source = document.createElement('canvas')
    source.width = Math.max(1, Math.round(canvas.width * attempt.scale))
    source.height = Math.max(1, Math.round(canvas.height * attempt.scale))
    const context = source.getContext('2d')
    if (context === null) return undefined
    context.drawImage(canvas, 0, 0, source.width, source.height)
  }
  return new Promise(resolve => { source.toBlob(blob => { resolve(blob ?? undefined) }, attempt.type, attempt.quality) })
}

/** Notes by frame, then by creation order; a note's line breaks become spaces so each note stays one line. */
function orderedNotes(comments: readonly GifComment[]): GifComment[] {
  return [...comments]
    .filter(comment => comment.text.trim().length > 0)
    .sort((a, b) => a.frame - b.frame || a.id - b.id)
    .map(comment => ({ ...comment, text: comment.text.trim().replace(/\s*\n\s*/g, ' ') }))
}

/**
 * The edit prompt: the opening instruction, the sheet layout as sent (its
 * cells may be smaller than the frames), the frames to produce at the
 * animation's own size, then one line per note.
 */
export function composeGifEditPrompt(comments: readonly GifComment[], plan: GifSheetPlan, frame: { width: number; height: number }): string {
  const blanks = plan.blanks === 0 ? '' : plan.blanks === 1 ? ' and the last cell is intentionally blank' : ` and the last ${String(plan.blanks)} cells are intentionally blank`
  const lines = [
    GIF_EDIT_INSTRUCTION,
    `The reference image is a contact sheet of the original animation: ${String(plan.frames)} frames of ${String(plan.cellW)}x${String(plan.cellH)} pixels, arranged in ${String(plan.cols)} columns x ${String(plan.rows)} rows in reading order (left to right, top to bottom); frame 1 is the top-left cell${blanks}. Each note below is anchored at a point inside one frame, given as (x%, y%) of that frame's width and height from its top-left corner.`,
    `Produce a ${String(plan.frames)}-frame looping GIF with frames of ${String(frame.width)}x${String(frame.height)} pixels, keep the character, style, motion and every frame unchanged except for the requested changes, and keep the animation continuous across frames.`,
    ...orderedNotes(comments).map(note => `Frame ${String(note.frame + 1)} at (${String(Math.round(note.x))}%, ${String(Math.round(note.y))}%): ${note.text}`),
  ]
  return lines.join('\n')
}

export interface GifEditRequestInput {
  /** The version being edited: its channel, model, output and the description it was drawn from. */
  image: RegeneratableImage & { prompt: string }
  /** The editing model of the channel, as the workbench would pick it. */
  model: string
  comments: readonly GifComment[]
  /** The encoded sheet and the plan it was encoded at (scaled with the encoding attempt). */
  sheet: { mediaType: 'image/png' | 'image/jpeg'; data: string; plan: GifSheetPlan }
  /** The decoded frames: their size and the delays they play at, as captured when the editor opened. */
  frame: { width: number; height: number; delaysMs: readonly number[] }
  /** Playback speed; the delay asked for follows it, like a download does. */
  speed: number
}

/**
 * The workbench edit that redraws the animation from the notes: the sheet as
 * the only reference, and a GIF with the sheet's frame count, the delay the
 * frames play at retimed by the speed, and the frame size the contract takes.
 * The prompt is the sheet instruction; the card files the new version under
 * the animation's own description instead.
 */
export function gifEditRequest({ image, model, comments, sheet, frame, speed }: GifEditRequestInput): StudioGenerateRequest {
  const delay = gifEditFrameDurationMs(gifFrameDurationMs(frame.delaysMs), speed)
  const { size } = gifOutputRequest({ frames: sheet.plan.frames, delaysMs: [...frame.delaysMs], width: frame.width, height: frame.height })
  return {
    ...conversationRegenerateRequest(image, composeGifEditPrompt(comments, sheet.plan, frame)),
    mode: 'edit',
    model,
    output: { format: 'gif', frameCount: sheet.plan.frames, ...(delay === undefined ? {} : { frameDurationMs: delay }), ...(size === undefined ? {} : { size }) },
    references: [{ mediaType: sheet.mediaType, data: sheet.data, name: `gif-frames-sheet.${extension(sheet.mediaType)}` }],
  }
}

/**
 * The same notes for a plain regeneration, which sees neither the previous
 * animation nor the sheet: no coordinates, the frame only as a time hint.
 */
export function composeFallbackPrompt(originalPrompt: string, comments: readonly GifComment[], frameTotal: number): string {
  const position = (frame: number) => {
    const at = frame / Math.max(frameTotal, 1)
    return at < 1 / 3 ? 'Early in' : at < 2 / 3 ? 'Midway through' : 'Late in'
  }
  const lines = [
    originalPrompt.trim(),
    '',
    `Additional requirements for this animation (${String(frameTotal)} frames):`,
    ...orderedNotes(comments).map(note => `- ${position(note.frame)} the animation (around frame ${String(note.frame + 1)} of ${String(frameTotal)}): ${note.text}`),
  ]
  return lines.join('\n')
}

/** The frame delay to ask for: the animation's own delay retimed by the playback speed, within the provider range, in 10 ms steps. */
export function gifEditFrameDurationMs(baseMs: number, speed: number): number | undefined {
  if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(speed) || speed <= 0) return undefined
  const retimed = Math.round(baseMs / speed / 10) * 10
  return Math.min(GIF_FRAME_DURATION_MS_MAX, Math.max(GIF_FRAME_DURATION_MS_MIN, retimed))
}
