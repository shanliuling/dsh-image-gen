/**
 * Frame comments in the GIF lightbox: whether an animation can be edited and
 * with which model, the pins and note boxes over the frame (or over the sheet
 * of every frame), the editing toggle in the player bar, the card's edit chip,
 * the edit bar under the player, and what a send in progress and a finished
 * one show. The notes and the request live in gif-edit.tsx; this file owns
 * only the interaction.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { GIF_FRAME_COUNT_MAX, GIF_FRAME_COUNT_MIN, STUDIO_ROUTE, studioModelForMode, studioModelOptionsForMode, type StudioConfigResponse } from '../shared.js'
import type { GifT } from './gif-i18n.js'
import { useGifSnapshot, type GifPlayer, type GifPlayerSnapshot } from './gif-player.js'
import { GIF_COMMENTS_MAX, GIF_COMMENT_MAX_CHARS, sheetPinPosition, sheetViewSize, type GifComment, type GifSheetPlan } from './gif-sheet.js'

export type GifEditAvailability = 'ready' | 'frame-count' | 'unsupported' | 'decoding' | 'unloaded'

/** A send in progress: the sheet and the model are being prepared, the model is redrawing, or the reply is in and the progress bar fills. */
export type GifEditPhase = 'preparing' | 'redrawing' | 'finishing'

/** An edit that came back while its editor was on screen. */
export interface GifEditDone {
  message: string
  /** The channel answered with a still, which has no frames to leave notes on. */
  still: boolean
}

/**
 * Whether the animation can be edited, and why not: only OpenAI-shaped
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

const UNAVAILABLE_TITLE = { 'frame-count': 'gifEditTooManyFrames', unsupported: 'gifEditDecodeFailed', decoding: 'gifEditDecoding', unloaded: 'gifEditNotLoaded' } as const

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

/** What a key does in a note box: Enter confirms, Escape closes, and an input method still composing keeps every key. */
export function commentKeyAction(event: { key: string; nativeEvent: { isComposing: boolean } }): 'confirm' | 'close' | undefined {
  if (event.nativeEvent.isComposing) return undefined
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter') return 'confirm'
  return undefined
}

const PENCIL = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
const SEND = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>
const TRASH = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></svg>

/** The card's edit chip, opposite the speed chip; it opens the lightbox straight in edit mode. */
export function GifEditChip({ availability, t, disabled, onOpen }: { availability: GifEditAvailability | undefined; t: GifT; disabled: boolean; onOpen(): void }) {
  if (availability === undefined) return null
  const ready = availability === 'ready'
  return <div className="dsh-ig-gif-edit-chip-slot">
    <button
      type="button"
      className="dsh-ig-gif-chip dsh-ig-gif-edit-chip"
      title={ready ? t('gifEditChipTitle') : t(UNAVAILABLE_TITLE[availability])}
      disabled={!ready || disabled}
      onClick={event => { event.stopPropagation(); onOpen() }}
    >{PENCIL}<span>{t('gifEdit')}</span></button>
  </div>
}

/** The player bar's editing switch. */
export function GifEditToggle({ availability, editing, t, onToggle }: { availability: GifEditAvailability; editing: boolean; t: GifT; onToggle(): void }) {
  const title = editing ? t('gifEditExitTitle') : availability === 'ready' ? t('gifEditEnterTitle') : t(UNAVAILABLE_TITLE[availability])
  // The label names the action, so the state is not announced as pressed too.
  return <button type="button" className={editing ? 'dsh-ig-gif-edit-toggle is-active' : 'dsh-ig-gif-edit-toggle'} title={title} disabled={!editing && availability !== 'ready'} onClick={onToggle}>{editing ? t('gifEditExitTitle') : t('gifEditToggle')}</button>
}

export interface GifCommentBarProps {
  view: 'gif' | 'sheet'
  /** One-based frame on screen. */
  current: number
  total: number
  count: number
  phase: GifEditPhase | undefined
  /** Whole seconds since the send. */
  seconds: number
  /** The answer to the request just sent. */
  error?: string | undefined
  /** What the error most likely means, when it came from the channel. */
  errorHint?: string | undefined
  t: GifT
  onView(view: 'gif' | 'sheet'): void
  onClear(): void
  onSend(): void
  onFallback(): void
}

/**
 * The edit bar under the player: what to do, the count, the view switch and
 * the actions. While a send runs it says what is happening and counts the
 * seconds. It has no cancel of its own: the player bar's switch leaves
 * editing, and the overlay on the picture stops a send.
 */
export function GifCommentBar({ view, current, total, count, phase, seconds, error, errorHint, t, onView, onClear, onSend, onFallback }: GifCommentBarProps) {
  const sending = phase !== undefined
  const fallback = <button type="button" className="dsh-ig-gif-edit-ghost" disabled={sending} onClick={onFallback}>{t('gifEditFallbackRegenerate')}</button>
  const hint = phase === 'preparing' ? t('gifEditPreparingHint') : sending ? t('gifEditRedrawingHint') : view === 'sheet' ? t('gifEditSheetHint') : t('gifEditHint')
  return <div className="dsh-ig-gif-edit" onClick={event => { event.stopPropagation() }}>
    <p className="dsh-ig-gif-edit-hint">{hint}</p>
    <div className="dsh-ig-gif-edit-row">
      <span className="dsh-ig-gif-edit-counter">{view === 'sheet' ? t('gifSheetComments', { total: String(total), count: String(count) }) : t('gifFrameComments', { current: String(current), count: String(count) })}</span>
      <div className="dsh-ig-gif-view" role="group" aria-label={t('gifEditView')}>
        <button type="button" aria-pressed={view === 'gif'} onClick={() => { onView('gif') }}>{t('gifGifView')}</button>
        <button type="button" aria-pressed={view === 'sheet'} onClick={() => { onView('sheet') }}>{t('gifSheetView')}</button>
      </div>
      <button type="button" className="dsh-ig-gif-edit-ghost" disabled={sending || count === 0} onClick={onClear}>{t('gifCommentsClear')}</button>
      <button type="button" className={sending ? 'dsh-ig-gif-edit-send is-busy' : 'dsh-ig-gif-edit-send'} disabled={sending || count === 0 || total === 0} onClick={onSend}>
        {sending ? <><span className="dsh-ig-gif-edit-spinner" aria-hidden="true" />{phase === 'preparing' ? t('gifEditPreparing') : t('gifEditingSeconds', { seconds: String(seconds) })}</> : t('gifSend', { count: String(count) })}
      </button>
    </div>
    {error !== undefined ? <div className="dsh-ig-gif-edit-error" role="alert"><strong>{t('gifEditFailed')}</strong>{errorHint !== undefined ? <span>{errorHint}</span> : null}<span>{error}</span>{fallback}</div> : null}
  </div>
}

/**
 * Over the picture while a send runs, until its new version is filed; its
 * cancel is the one way to stop a send in the preview (the card has its own
 * once the preview is closed). It names the step but never a frame
 * (a note may ask to change every frame after it) and shows no number: the
 * redraw reports no progress, so the bar is an estimate that only the reply
 * fills.
 */
export function GifEditOverlay({ phase, progress, t, onCancel }: { phase: GifEditPhase; progress: number; t: GifT; onCancel(): void }) {
  const finishing = phase === 'finishing'
  return <div className={finishing ? 'dsh-ig-gif-edit-busy is-finishing' : 'dsh-ig-gif-edit-busy'} onClick={event => { event.stopPropagation() }}>
    <span className="dsh-ig-gif-edit-busy-spinner" aria-hidden="true" />
    <span className="dsh-ig-gif-edit-busy-text" role="status">{phase === 'preparing' ? t('gifEditPreparing') : t('gifEditRedrawing')}</span>
    {phase === 'preparing' ? null : <span className="dsh-ig-gif-edit-busy-track" aria-hidden="true"><span className="dsh-ig-gif-edit-busy-fill" style={{ transform: `scaleX(${String(progress)})` }} /></span>}
    {finishing ? null : <button type="button" className="dsh-ig-gif-edit-ghost" onClick={onCancel}>{t('gifEditCancelSend')}</button>}
  </div>
}

/**
 * Where the edit bar was, once an edit came back while it was watched: what
 * came of it, going on from the new version, or closing the preview. A new
 * animation takes notes once its frames are decoded; a still takes none.
 */
export function GifEditDoneBar({ done, availability, t, onContinue, onFinish }: { done: GifEditDone; availability: GifEditAvailability | undefined; t: GifT; onContinue?: (() => void) | undefined; onFinish(): void }) {
  const ready = availability === 'ready' && onContinue !== undefined
  return <div className="dsh-ig-gif-edit is-done" onClick={event => { event.stopPropagation() }}>
    <p className="dsh-ig-gif-edit-done-text" role="status">{done.message}</p>
    <div className="dsh-ig-gif-edit-row is-end">
      {done.still ? null : <button type="button" className="dsh-ig-gif-edit-ghost" disabled={!ready} title={availability === undefined || availability === 'ready' ? undefined : t(UNAVAILABLE_TITLE[availability])} onClick={onContinue}>{t('gifEditContinue')}</button>}
      <button type="button" className="dsh-ig-gif-edit-send" onClick={onFinish}>{t('gifEditFinish')}</button>
    </div>
  </div>
}

export interface GifCommentLayerProps {
  player: GifPlayer
  editing: boolean
  view: 'gif' | 'sheet'
  /** Every frame tiled when editing began; shown scaled in the sheet view. */
  sheet: { canvas: HTMLCanvasElement; plan: GifSheetPlan } | undefined
  comments: readonly GifComment[]
  onChange(comments: GifComment[]): void
  t: GifT
}

/** A note box: a new note (no id yet), one being changed, or one being read outside editing. */
interface NoteBox {
  mode: 'new' | 'edit' | 'view'
  id?: number | undefined
  frame: number
  x: number
  y: number
  text: string
  /** The box opens on the side of the pin with room for it, and above the pin near the bottom. */
  left: boolean
  up: boolean
}

const NOTE_BOX_WIDTH = 292
const clampPercent = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10

/** Which side of a point a note box fits on, judged against the window: it may overhang the picture into the backdrop. */
function noteSide(clientX: number, clientY: number): { left: boolean; up: boolean } {
  const width = typeof window === 'undefined' ? Infinity : window.innerWidth
  const height = typeof window === 'undefined' ? Infinity : window.innerHeight
  return { left: clientX + 30 + NOTE_BOX_WIDTH > width - 16, up: clientY > height * 0.62 }
}

/**
 * Over the frame on screen: in editing, a layer that places a note on the
 * frame (pausing first), and that frame's pins; outside editing, the pins of a
 * paused frame, which open to read. In the sheet view every cell is a click
 * target and every pin is shown in its cell. Keys typed in a box stay in it:
 * Enter posts or saves, Escape closes only the box.
 */
export function GifCommentLayer({ player, editing, view, sheet, comments, onChange, t }: GifCommentLayerProps) {
  const snapshot = useGifSnapshot(player)
  const current = snapshot.index
  const [box, setBox] = useState<NoteBox>()
  const [boxKey, setBoxKey] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The layer, cell or pin that opened the box; focus goes back there when it closes.
  const openerRef = useRef<HTMLElement | null>(null)
  // The sheet's plan while the sheet view is on; its cells are the click targets then.
  const plan = editing && view === 'sheet' ? sheet?.plan : undefined
  const sheetView = plan !== undefined

  useEffect(() => {
    const canvas = canvasRef.current
    if (!sheetView || sheet === undefined || canvas === null) return
    canvas.getContext('2d')?.drawImage(sheet.canvas, 0, 0, canvas.width, canvas.height)
  }, [sheetView, sheet])

  // A box belongs to the view and the editing state it was opened in; leaving
  // either, or the lightbox, keeps what was typed in it.
  const leaveBox = useRef(() => {})
  useEffect(() => () => { leaveBox.current() }, [editing, view])

  const boxOpen = box !== undefined && box.mode !== 'view'
  useEffect(() => {
    if (boxOpen) inputRef.current?.focus()
  }, [boxOpen, boxKey])

  const open = (next: NoteBox, opener: HTMLElement) => {
    openerRef.current = opener
    setBox(next)
    setBoxKey(key => key + 1)
  }
  const close = () => {
    setBox(undefined)
    // Back to the pin or cell that opened the box; not to the picture-wide layer, where Space would open another box instead of playing.
    if (openerRef.current?.classList.contains('dsh-ig-gif-edit-layer') === false) openerRef.current.focus()
    openerRef.current = null
  }
  const confirm = () => {
    if (box === undefined || box.mode === 'view') return
    const text = box.text.trim().slice(0, GIF_COMMENT_MAX_CHARS)
    if (text.length === 0) return
    if (box.mode === 'edit') {
      const id = box.id
      onChange(comments.map(comment => comment.id === id ? { ...comment, text } : comment))
    } else {
      onChange([...comments, { id: comments.reduce((max, comment) => Math.max(max, comment.id), 0) + 1, frame: box.frame, x: box.x, y: box.y, text }])
    }
    close()
  }
  const remove = () => {
    if (box?.id !== undefined) onChange(comments.filter(comment => comment.id !== box.id))
    close()
  }
  /** Moving on while a note is being written keeps what was typed rather than dropping it. */
  const keepTyped = () => {
    if (box !== undefined && box.mode !== 'view' && box.text.trim().length > 0) confirm()
  }
  leaveBox.current = () => {
    keepTyped()
    setBox(undefined)
  }

  /**
   * A new note where the picture was clicked: on the frame on screen once the
   * player is paused (a click while it plays stops it first), or on the cell's
   * frame, which the player moves to so the pin is seen where it was put. A
   * keyboard press has no point, so the note goes to the frame's centre. While
   * a box is on screen a click only closes it, as a click outside any popover
   * does; a box hidden by a frame change gives way, keeping what was typed.
   */
  const place = (frame: number | undefined, event: MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    let count = comments.length
    if (box !== undefined && box.mode !== 'view') {
      const typed = box.text.trim().length > 0
      if (typed) confirm()
      else close()
      if (onScreen(box.frame)) return
      if (typed && box.mode === 'new') count += 1
    }
    if (count >= GIF_COMMENTS_MAX) return
    if (frame === undefined) player.pause()
    else player.seek(frame)
    const rect = event.currentTarget.getBoundingClientRect()
    const fromKeyboard = event.detail === 0
    const clientX = fromKeyboard ? rect.left + rect.width / 2 : event.clientX
    const clientY = fromKeyboard ? rect.top + rect.height / 2 : event.clientY
    const x = clampPercent((clientX - rect.left) / rect.width * 100)
    const y = clampPercent((clientY - rect.top) / rect.height * 100)
    open({ mode: 'new', frame: frame ?? player.getSnapshot().index, x, y, text: '', ...noteSide(clientX, clientY) }, event.currentTarget)
  }

  const position = (comment: Pick<GifComment, 'frame' | 'x' | 'y'>) => plan !== undefined ? sheetPinPosition(comment, plan) : { x: comment.x, y: comment.y }
  const pin = (comment: GifComment, number: number) => {
    const at = position(comment)
    const active = box?.id === comment.id
    return <button
      key={comment.id}
      type="button"
      className={`dsh-ig-gif-pin${sheetView ? ' is-small' : ''}${active ? ' is-active' : ''}`}
      style={{ left: `${String(at.x)}%`, top: `${String(at.y)}%` }}
      title={sheetView ? t('gifCommentSheetTitle', { frame: String(comment.frame + 1), text: comment.text }) : t('gifCommentView')}
      aria-label={t('gifCommentLabel', { index: String(number), frame: String(comment.frame + 1) })}
      aria-expanded={active}
      onClick={event => {
        event.stopPropagation()
        if (active) { close(); return }
        keepTyped()
        const rect = event.currentTarget.getBoundingClientRect()
        open({ mode: editing ? 'edit' : 'view', id: comment.id, frame: comment.frame, x: comment.x, y: comment.y, text: comment.text, ...noteSide(rect.left, rect.top) }, event.currentTarget)
      }}
    >{number}</button>
  }
  // A pin and its box show only on their own frame; outside editing only while paused, as a playing frame changes too fast to read.
  const onScreen = (frame: number) => sheetView || (frame === current && (editing || !snapshot.playing))
  const pins = comments.flatMap((comment, index) => onScreen(comment.frame) ? [pin(comment, index + 1)] : [])

  const noteBox = box === undefined || !onScreen(box.frame) ? null : (() => {
    const at = position(box)
    const number = box.id === undefined ? comments.length + 1 : comments.findIndex(comment => comment.id === box.id) + 1
    const className = `dsh-ig-gif-note is-${box.mode}${box.left ? ' is-left' : ''}${box.up ? ' is-up' : ''}`
    const style = { left: `${String(at.x)}%`, top: `${String(at.y)}%` }
    if (box.mode === 'view') return <div className={className} role="dialog" aria-label={t('gifCommentLabel', { index: String(number), frame: String(box.frame + 1) })} style={style} onClick={event => { event.stopPropagation() }}><p>{box.text}</p></div>
    const empty = box.text.trim().length === 0
    const input = <input
      ref={inputRef}
      type="text"
      className="dsh-ig-gif-note-input"
      aria-label={t('gifCommentPlaceholder')}
      placeholder={t('gifCommentPlaceholder')}
      maxLength={GIF_COMMENT_MAX_CHARS}
      value={box.text}
      onChange={event => { setBox({ ...box, text: event.target.value }) }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        // An input method keeps its keys, Escape included, so none reaches the lightbox.
        if (event.nativeEvent.isComposing) { event.stopPropagation(); return }
        if (commentKeyAction(event) !== 'confirm') return
        event.preventDefault()
        event.stopPropagation()
        confirm()
      }}
    />
    return <>
      {box.mode === 'new' ? <span className={`dsh-ig-gif-pin is-draft${sheetView ? ' is-small' : ''}`} aria-hidden="true" style={style}>{number}</span> : null}
      <div
        className={className}
        role="dialog"
        aria-label={box.mode === 'new' ? t('gifCommentNew', { frame: String(box.frame + 1) }) : t('gifCommentEdit', { index: String(number) })}
        style={style}
        onClick={event => { event.stopPropagation() }}
        // Focusable, so a click inside keeps the keys here rather than handing them to the player.
        tabIndex={-1}
        onKeyDown={event => {
          event.stopPropagation()
          if (commentKeyAction(event) !== 'close') return
          event.preventDefault()
          close()
        }}
      >
        {box.mode === 'new'
          ? <>{input}<button type="button" className="dsh-ig-gif-note-post" title={t('gifCommentPublishTitle')} aria-label={t('gifCommentPublish')} disabled={empty} onClick={confirm}>{SEND}</button></>
          : <>
            <div className="dsh-ig-gif-note-field">{input}</div>
            <div className="dsh-ig-gif-note-actions">
              <button type="button" className="dsh-ig-gif-note-icon" title={t('gifCommentDelete')} aria-label={t('gifCommentDelete')} onClick={remove}>{TRASH}</button>
              <span />
              <button type="button" className="dsh-ig-gif-note-ghost" onClick={close}>{t('gifEditCancel')}</button>
              <button type="button" className="dsh-ig-gif-note-save" disabled={empty} onClick={confirm}>{t('gifCommentSave')}</button>
            </div>
          </>}
      </div>
    </>
  })()

  if (plan !== undefined) {
    const viewSize = sheetViewSize(plan)
    const cells = Array.from({ length: plan.cols * plan.rows }, (_, index) => {
      const style = { left: `${String((index % plan.cols) / plan.cols * 100)}%`, top: `${String(Math.floor(index / plan.cols) / plan.rows * 100)}%`, width: `${String(100 / plan.cols)}%`, height: `${String(100 / plan.rows)}%` }
      if (index >= plan.frames) return <div key={index} className="dsh-ig-gif-sheet-cell is-blank" style={style} />
      return <button
        key={index}
        type="button"
        className={`dsh-ig-gif-sheet-cell${index === current ? ' is-current' : ''}`}
        aria-label={t('gifEditLayerLabel', { frame: String(index + 1) })}
        style={style}
        onClick={event => { place(index, event) }}
      ><span>{index + 1}</span></button>
    })
    return <>
      <canvas ref={canvasRef} className="dsh-ig-gif-sheet" width={viewSize.width} height={viewSize.height} role="img" aria-label={t('gifSheetView')} />
      {cells}
      {pins}
      {noteBox}
    </>
  }
  return <>
    {editing ? <button
      type="button"
      className="dsh-ig-gif-edit-layer"
      aria-label={t('gifEditLayerLabel', { frame: String(current + 1) })}
      // A mouse click leaves focus alone, so Space still plays rather than activating the layer again.
      onMouseDown={event => { event.preventDefault() }}
      onClick={event => { place(undefined, event) }}
    /> : null}
    {pins}
    {noteBox}
  </>
}
