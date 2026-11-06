/**
 * Frame comments on a paused GIF card: a crosshair layer and numbered pins
 * over the frame on screen (or over a sheet of every frame), a small popover
 * to write each note, and the bar that counts, switches views and sends. The
 * card owns the notes and sends the request; this file owns only the
 * interaction.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react'
import { GIF_FRAME_COUNT_MAX, GIF_FRAME_COUNT_MIN, STUDIO_ROUTE, studioModelForMode, studioModelOptionsForMode, type StudioConfigResponse } from '../shared.js'
import type { GifPlayer } from './gif-player.js'
import { GIF_COMMENTS_MAX, GIF_COMMENT_MAX_CHARS, sheetPinPosition, sheetViewSize, type GifComment, type GifSheetPlan } from './gif-sheet.js'
import type { DictKey } from './plugin-i18n.js'

type Translate = (key: DictKey, params?: Record<string, string>) => string
type GifPlayerSnapshot = ReturnType<GifPlayer['getSnapshot']>

export type GifEditAvailability = 'ready' | 'frame-count' | 'unsupported' | 'decoding' | 'unloaded'

/**
 * Whether the card can offer the editor, and why not: only OpenAI-shaped
 * providers take the edit request, the frames must be decoded (the sheet is
 * built from them) and their number must be one the GIF contract can ask for.
 * Once decoded, the frames themselves are counted, whatever the header says:
 * they are what the sheet and the request use.
 */
export function gifEditAvailability(input: { provider: string; animated: boolean; snapshot: Pick<GifPlayerSnapshot, 'status' | 'frames' | 'info'> | undefined }): GifEditAvailability | undefined {
  const { snapshot } = input
  if (input.provider !== 'openai' && input.provider !== 'openai-compat') return undefined
  if (!input.animated || snapshot === undefined) return undefined
  const frames = snapshot.status === 'ready' ? snapshot.frames.length : snapshot.info?.frames
  if (frames !== undefined && frames < GIF_FRAME_COUNT_MIN) return undefined
  if (frames !== undefined && frames > GIF_FRAME_COUNT_MAX) return 'frame-count'
  if (snapshot.status === 'fallback') return 'unsupported'
  if (snapshot.status === 'native') return 'unloaded'
  return snapshot.status === 'ready' ? 'ready' : 'decoding'
}

/**
 * The model for the edit: the channel's separate editing model when it has
 * one (the server takes nothing else for an edit); otherwise the model that
 * drew this animation while the channel still offers it, else the channel's
 * default; the card's own model when the channel is gone.
 */
export function gifEditModel(config: Pick<StudioConfigResponse, 'providers' | 'activeChannel'>, image: { provider: string; channel?: string | undefined; model: string }): string {
  const channel = image.provider === 'openai-compat' ? image.channel ?? config.activeChannel : undefined
  const profile = config.providers.find(candidate => candidate.provider === image.provider && (channel === undefined || candidate.channel === channel))
  if (profile === undefined) return image.model
  if (profile.editModel === undefined && studioModelOptionsForMode(profile, 'edit').some(option => option.value === image.model)) return image.model
  return studioModelForMode(profile, 'edit')
}

export async function fetchGifEditModel(image: { provider: string; channel?: string | undefined; model: string }, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(STUDIO_ROUTE, { credentials: 'same-origin', signal })
    if (!response.ok) return image.model
    return gifEditModel(await response.json() as StudioConfigResponse, image)
  } catch (cause) {
    if (signal.aborted) throw cause
    return image.model
  }
}

/** Channels whose last edit failed in this session, so the next editor opens with the reason and the fallback at hand; an edit that succeeds clears it. */
const editFailures = new Map<string, string>()
const failureKey = (image: { provider: string; channel?: string | undefined }) => `${image.provider}/${image.channel ?? ''}`

export function rememberGifEditFailure(image: { provider: string; channel?: string | undefined }, reason: string): void {
  editFailures.set(failureKey(image), reason)
}

export function forgetGifEditFailure(image: { provider: string; channel?: string | undefined }): void {
  editFailures.delete(failureKey(image))
}

export function gifEditFailure(image: { provider: string; channel?: string | undefined }): string | undefined {
  return editFailures.get(failureKey(image))
}

/** What a key does in the note popover: Enter confirms, Escape closes, Shift+Enter breaks the line, and an input method still composing keeps every key. */
export function commentKeyAction(event: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean } }): 'confirm' | 'close' | undefined {
  if (event.nativeEvent.isComposing) return undefined
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter' && !event.shiftKey) return 'confirm'
  return undefined
}

export interface GifCommentBarProps {
  /** One-based frame on screen. */
  current: number
  total: number
  comments: readonly GifComment[]
  view: 'gif' | 'sheet'
  sending: boolean
  /** The sheet is drawn, so the notes can be sent. */
  canSend: boolean
  /** Reason the last edit on this channel failed, shown before trying again. */
  notice?: string | undefined
  /** The answer to the request just sent. */
  error?: string | undefined
  /** What the error most likely means, when it came from the channel. */
  errorHint?: string | undefined
  t: Translate
  onView(view: 'gif' | 'sheet'): void
  onClear(): void
  onCancel(): void
  onSend(): void
  onFallback(): void
}

export function GifCommentBar({ current, total, comments, view, sending, canSend, notice, error, errorHint, t, onView, onClear, onCancel, onSend, onFallback }: GifCommentBarProps) {
  const count = String(comments.length)
  const fallback = <button type="button" className="dsh-ig-gif-edit-btn" disabled={sending} onClick={onFallback}>{t('gifEditFallbackRegenerate')}</button>
  return <div className="dsh-ig-gif-edit">
    <p className="dsh-ig-gif-edit-hint">{t('gifEditHint')}</p>
    {notice !== undefined && error === undefined ? <div className="dsh-ig-gif-edit-notice" role="status"><span>{t('gifEditFailedBefore', { reason: notice })}</span>{fallback}</div> : null}
    <div className="dsh-ig-gif-edit-bar">
      <span className="dsh-ig-gif-edit-counter">{t('gifFrameComments', { current: String(current), total: String(total), count })}</span>
      <div className="dsh-ig-gif-view" role="group" aria-label={t('gifEditView')}>
        <button type="button" aria-pressed={view === 'gif'} onClick={() => { onView('gif') }}>{t('gifGifView')}</button>
        <button type="button" aria-pressed={view === 'sheet'} onClick={() => { onView('sheet') }}>{t('gifSheetView')}</button>
      </div>
      {comments.length > 0 ? <button type="button" className="dsh-ig-gif-edit-btn" disabled={sending} onClick={onClear}>{t('gifCommentsClear')}</button> : null}
      <button type="button" className="dsh-ig-gif-edit-btn" disabled={sending} onClick={onCancel}>{t('cancel')}</button>
      <button type="button" className="dsh-ig-gif-edit-send" disabled={sending || !canSend || comments.length === 0} onClick={onSend}>{t('gifSend', { count })}</button>
    </div>
    {error !== undefined ? <div className="dsh-ig-gif-edit-error" role="alert"><strong>{t('gifEditFailed')}</strong>{errorHint !== undefined ? <span>{errorHint}</span> : null}<span>{error}</span>{fallback}</div> : null}
  </div>
}

export interface GifCommentLayerProps {
  player: GifPlayer
  view: 'gif' | 'sheet'
  /** Every frame tiled by the card when the editor opened; shown scaled in the sheet view. */
  sheet: HTMLCanvasElement
  plan: GifSheetPlan
  comments: readonly GifComment[]
  onChange(comments: GifComment[]): void
  t: Translate
}

/** A note being written or changed; a new one has no id until confirmed. */
interface Draft { id?: number | undefined; frame: number; x: number; y: number; text: string }

const clampPercent = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10

/**
 * In the GIF view the layer covers the frame on screen and shows that frame's
 * pins; in the sheet view every cell is a click target and every pin is
 * shown. Notes go on a still frame: a click pauses the player (or seeks to the
 * cell's frame) before the pin is placed. A click opens the popover; Enter
 * confirms, Escape closes only the popover, and the key never leaves it, so
 * the card's own Escape (which leaves the editor) does not see it.
 */
export function GifCommentLayer({ player, view, sheet, plan, comments, onChange, t }: GifCommentLayerProps) {
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot)
  const current = snapshot.index
  const [draft, setDraft] = useState<Draft>()
  const [draftKey, setDraftKey] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The layer, cell or pin that opened the popover; focus goes back there when it closes.
  const openerRef = useRef<HTMLElement | null>(null)
  const viewSize = sheetViewSize(plan)

  useEffect(() => {
    if (view !== 'sheet') return
    const canvas = canvasRef.current
    if (canvas === null) return
    canvas.getContext('2d')?.drawImage(sheet, 0, 0, canvas.width, canvas.height)
  }, [view, sheet])

  const draftOpen = draft !== undefined
  useEffect(() => {
    if (draftOpen) textareaRef.current?.focus()
  }, [draftOpen, draftKey])

  const open = (next: Draft, opener: HTMLElement | null) => {
    openerRef.current = opener
    setDraft(next)
    setDraftKey(key => key + 1)
  }
  const close = () => {
    setDraft(undefined)
    openerRef.current?.focus()
    openerRef.current = null
  }
  const remove = (id: number | undefined) => {
    if (id !== undefined) onChange(comments.filter(comment => comment.id !== id))
    close()
  }
  const confirm = () => {
    if (draft === undefined) return
    const text = draft.text.trim().slice(0, GIF_COMMENT_MAX_CHARS)
    if (text.length === 0) { remove(draft.id); return }
    if (draft.id !== undefined) {
      const id = draft.id
      onChange(comments.map(comment => comment.id === id ? { ...comment, text } : comment))
    } else {
      onChange([...comments, { id: comments.reduce((max, comment) => Math.max(max, comment.id), 0) + 1, frame: draft.frame, x: draft.x, y: draft.y, text }])
    }
    close()
  }
  /** A click elsewhere while a note is being written keeps what was typed rather than dropping it. */
  const keepDraft = () => {
    if (draft !== undefined && draft.text.trim().length > 0) confirm()
  }
  /**
   * A new note at a point inside a frame: the frame on screen once the player
   * is paused (a click while it plays stops it first), or the cell's frame,
   * which the player is moved to so the pin is seen where it was put.
   */
  const place = (frame: number | undefined, point: { x: number; y: number }, opener: HTMLElement | null) => {
    keepDraft()
    if (comments.length >= GIF_COMMENTS_MAX) return
    if (frame === undefined) player.pause()
    else player.seek(frame)
    open({ frame: frame ?? player.getSnapshot().index, x: clampPercent(point.x), y: clampPercent(point.y), text: '' }, opener)
  }
  const placeAtPointer = (frame: number | undefined, event: MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    place(frame, { x: (event.clientX - rect.left) / rect.width * 100, y: (event.clientY - rect.top) / rect.height * 100 }, event.currentTarget)
  }
  /** Keyboard: Enter or Space puts the note at the centre of the frame. */
  const placeByKey = (frame: number | undefined, event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    place(frame, { x: 50, y: 50 }, event.currentTarget)
  }

  const position = (comment: Pick<GifComment, 'frame' | 'x' | 'y'>) => view === 'sheet' ? sheetPinPosition(comment, plan) : { x: comment.x, y: comment.y }
  const pin = (comment: Pick<GifComment, 'frame' | 'x' | 'y'> & { id?: number | undefined; text?: string }, number: number, extra = '') => {
    const at = position(comment)
    const other = view === 'sheet' && comment.frame !== current
    return <button
      key={comment.id ?? 'draft'}
      type="button"
      className={`dsh-ig-gif-pin${other ? ' is-other-frame' : ''}${comment.id !== undefined && draft?.id === comment.id ? ' is-active' : ''}${extra}`}
      style={{ left: `${String(at.x)}%`, top: `${String(at.y)}%` }}
      title={comment.text}
      aria-label={comment.id === undefined ? t('gifCommentNew', { frame: String(comment.frame + 1) }) : t('gifCommentLabel', { index: String(number), frame: String(comment.frame + 1) })}
      onClick={event => {
        event.stopPropagation()
        if (comment.id === undefined || draft?.id === comment.id) return
        keepDraft()
        open({ id: comment.id, frame: comment.frame, x: comment.x, y: comment.y, text: comment.text ?? '' }, event.currentTarget)
      }}
    >{number}</button>
  }
  const pins = comments.flatMap((comment, index) => view === 'sheet' || comment.frame === current ? [pin(comment, index + 1)] : [])
  const popover = draft === undefined ? null : (() => {
    const at = position(draft)
    return <div
      className={`dsh-ig-gif-comment-pop${at.x > 60 ? ' is-left' : ''}${at.y > 65 ? ' is-up' : ''}`}
      role="dialog"
      aria-label={t('gifCommentPlaceholder')}
      style={{ left: `${String(at.x)}%`, top: `${String(at.y)}%` }}
      onClick={event => { event.stopPropagation() }}
      onKeyDown={event => {
        if (commentKeyAction(event) !== 'close') return
        event.stopPropagation()
        close()
      }}
    >
      <textarea
        ref={textareaRef}
        rows={2}
        maxLength={GIF_COMMENT_MAX_CHARS}
        placeholder={t('gifCommentPlaceholder')}
        value={draft.text}
        onChange={event => { setDraft({ ...draft, text: event.target.value }) }}
        onKeyDown={event => {
          if (commentKeyAction(event) !== 'confirm') return
          event.preventDefault()
          confirm()
        }}
      />
      <div className="dsh-ig-gif-comment-pop-actions">
        {draft.id !== undefined ? <button type="button" className="dsh-ig-gif-edit-btn" onClick={() => { remove(draft.id) }}>{t('gifCommentDelete')}</button> : null}
        <button type="button" className="dsh-ig-gif-edit-send" onClick={confirm}>{t('gifCommentConfirm')}</button>
      </div>
    </div>
  })()

  if (view === 'sheet') {
    const cells = Array.from({ length: plan.cols * plan.rows }, (_, index) => {
      const blank = index >= plan.frames
      const style = { left: `${String((index % plan.cols) / plan.cols * 100)}%`, top: `${String(Math.floor(index / plan.cols) / plan.rows * 100)}%`, width: `${String(100 / plan.cols)}%`, height: `${String(100 / plan.rows)}%` }
      if (blank) return <div key={index} className="dsh-ig-gif-sheet-cell is-blank" style={style} />
      return <div
        key={index}
        className={`dsh-ig-gif-sheet-cell${index === current ? ' is-current' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={t('gifFrameOf', { current: String(index + 1), total: String(plan.frames) })}
        style={style}
        onClick={event => { placeAtPointer(index, event) }}
        onKeyDown={event => { placeByKey(index, event) }}
      ><span>{index + 1}</span></div>
    })
    return <>
      <canvas ref={canvasRef} className="dsh-ig-gif-sheet" width={viewSize.width} height={viewSize.height} role="img" aria-label={t('gifSheetView')} />
      {cells}
      {pins}
      {draft !== undefined && draft.id === undefined ? pin(draft, comments.length + 1, ' is-draft') : null}
      {popover}
    </>
  }
  return <>
    <div className="dsh-ig-gif-edit-layer" role="button" tabIndex={0} aria-label={t('gifEditLayerLabel')} onClick={event => { placeAtPointer(undefined, event) }} onKeyDown={event => { placeByKey(undefined, event) }} />
    {pins}
    {draft !== undefined && draft.id === undefined ? pin(draft, comments.length + 1, ' is-draft') : null}
    {popover}
  </>
}
