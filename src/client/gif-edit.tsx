/**
 * Frame-comment editing of an animated card: the notes of each version, the
 * edit request that redraws the animation from them, and the lightbox that
 * hosts the editor. The card supplies its busy state, its version chain and
 * its regenerate dialog; gif-comments.tsx draws the editor.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react'
import { STUDIO_ROUTE, type StudioGenerateRequest, type StudioGenerateResponse } from '../shared.js'
import { blobToDataUrl } from './browser-image-utils.js'
import type { ConversationImageRevision } from './conversation-image-revisions.js'
import type { RegeneratableImage } from './conversation-regenerate.js'
import { GifLightbox, type GifCard, type GifLightboxProps } from './gif-card.js'
import { GifCommentBar, GifCommentLayer, GifEditChip, GifEditToggle, fetchGifEditModel, gifEditAvailability, type GifEditAvailability } from './gif-comments.js'
import { composeFallbackPrompt, drawGifSheet, encodeSheetWithinLimit, gifEditRequest, planGifSheet, type GifComment, type GifSheetPlan } from './gif-sheet.js'
import { originalFromMeta } from './image-result-node.js'
import { readCanvasImageLimit } from './tl/canvas-selection.js'

const noSubscription = () => () => {}

/**
 * The notes of each image version, by its attachment id: they outlive the card
 * (switching sessions or scrolling it away remounts it) and never mix between
 * images. Memory only; clearing a version's notes drops its entry.
 */
const notesByVersion = new Map<string, GifComment[]>()

/** The workbench answered with an error, its own or the provider's; a request that never got an answer throws a plain Error. */
class StudioReplyError extends Error {}

/** The sheet drawn when editing began, with the frame facts the request needs; it outlives frames the player releases. */
export interface DrawnSheet { canvas: HTMLCanvasElement; plan: GifSheetPlan; frame: { width: number; height: number; delaysMs: readonly number[] } }

export interface GifEditInput {
  gif: GifCard
  /** The version on display; editing is offered only for one the workbench can redraw. */
  image: (RegeneratableImage & { prompt: string }) | undefined
  /** Notes belong to the version they were made on. */
  versionKey: string | undefined
  /** The card's single busy slot, shared with regeneration: one request at a time, and the card's cancel aborts either. */
  busy: { running: boolean; setRunning(running: boolean): void; controller: MutableRefObject<AbortController | undefined> }
  /** File a new version under the card and in the gallery; resolves whether the gallery kept it. */
  addRevision(revision: ConversationImageRevision): Promise<boolean>
  /** The edit came back as a new version: close the lightbox and say how it went. */
  onSent(message: string): void
  /** Regenerate from a description instead, with the notes written into the prompt. */
  onFallback(prompt: string, hint: string): void
}

export interface GifEdit {
  t: GifCard['t']
  availability: GifEditAvailability | undefined
  comments: readonly GifComment[]
  setComments(comments: GifComment[]): void
  busy: boolean
  sending: boolean
  error: { message: string; fromChannel: boolean } | undefined
  /** Said under the card title: a failure that came back while no editor was on screen. */
  notice: string | undefined
  /** The edit chip asked the next lightbox to open in edit mode. */
  editRequested: boolean
  requestEdit(): void
  takeEditRequest(): boolean
  /** The lightbox reports whether its editor is on screen, so a late failure knows where to show. */
  setEditorOpen(open: boolean): void
  beginEditing(): void
  send(sheet: DrawnSheet): void
  cancelSend(): void
  fallback(total: number): void
}

/** The new version an edit reply describes, filed under the animation's own description rather than the sheet instructions. */
function revisionFromReply(payload: StudioGenerateResponse, request: StudioGenerateRequest, prompt: string): ConversationImageRevision {
  const original = originalFromMeta(payload.original)
  return {
    attachment: payload.attachment,
    prompt,
    provider: payload.provider,
    ...(payload.channel === undefined ? {} : { channel: payload.channel }),
    model: payload.model,
    output: payload.output,
    createdAt: payload.createdAt,
    ratio: request.ratio,
    quality: request.quality,
    ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    ...(request.generationQuality === undefined ? {} : { generationQuality: request.generationQuality }),
    ...(request.watermark === undefined ? {} : { watermark: request.watermark }),
    ...(original === undefined ? {} : { original }),
  }
}

/** The notes of the version on display and the edit request built from them. */
export function useGifEdit({ gif, image, versionKey, busy, addRevision, onSent, onFallback }: GifEditInput): GifEdit {
  const { t, player } = gif
  const [comments, setCommentsState] = useState<GifComment[]>(() => (versionKey === undefined ? [] : notesByVersion.get(versionKey) ?? []))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<{ message: string; fromChannel: boolean }>()
  const [notice, setNotice] = useState<string>()
  const [editRequested, setEditRequested] = useState(false)
  const editorOpen = useRef(false)

  // Notes point into the frames of one version: the version on display brings its own.
  useEffect(() => {
    setCommentsState(versionKey === undefined ? [] : notesByVersion.get(versionKey) ?? [])
    setError(undefined)
    setNotice(undefined)
  }, [versionKey])

  // A selector over the player, so the card re-renders when editing becomes possible, not on every frame.
  const readAvailability = () => image === undefined || image.model.trim().length === 0
    ? undefined
    : gifEditAvailability({ provider: image.provider, animated: gif.animated, snapshot: player?.getSnapshot() })
  const availability = useSyncExternalStore(player?.subscribe ?? noSubscription, readAvailability, readAvailability)

  const setComments = (next: GifComment[]) => {
    setCommentsState(next)
    if (versionKey === undefined) return
    if (next.length === 0) notesByVersion.delete(versionKey)
    else notesByVersion.set(versionKey, next)
  }

  const send = (sheet: DrawnSheet) => {
    if (image === undefined || player === undefined || busy.running || comments.length === 0) return
    const controller = new AbortController()
    busy.controller.current = controller
    busy.setRunning(true)
    setSending(true)
    setError(undefined)
    setNotice(undefined)
    void (async () => {
      try {
        const limit = await readCanvasImageLimit(controller.signal).catch(() => 4_000_000)
        controller.signal.throwIfAborted()
        const encoded = await encodeSheetWithinLimit(sheet.canvas, sheet.plan, limit).catch(() => { throw new Error(t('gifSheetTooLarge')) })
        const data = (await blobToDataUrl(encoded.blob)).replace(/^[^,]*,/, '')
        const model = await fetchGifEditModel(image, controller.signal)
        const request = gifEditRequest({ image, model, comments, sheet: { mediaType: encoded.mediaType, data, plan: encoded.plan }, frame: sheet.frame, speed: player.getSnapshot().speed })
        const response = await fetch(STUDIO_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
        const payload = await response.json().catch(() => null) as StudioGenerateResponse | { error?: string } | null
        if (!response.ok || payload === null || !('attachment' in payload)) {
          const reported = payload !== null && 'error' in payload && payload.error ? payload.error : undefined
          throw reported === undefined ? new Error(t('gifEditFailed')) : new StudioReplyError(reported)
        }
        const revision = revisionFromReply(payload, request, image.prompt)
        const savedOk = await addRevision(revision)
        if (revision.original?.mediaType !== 'image/gif' && revision.attachment.mediaType !== 'image/gif') {
          // The channel answered with a still: kept as a version so the result is not lost.
          onSent(t('gifEditStill'))
          return
        }
        onSent(savedOk ? t('gifEditDone') : t('gifEditSaveFailed'))
      } catch (cause) {
        if (controller.signal.aborted) return
        const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
        // Only an answer to the request says something about the channel; a
        // sheet too large to encode or a dropped connection does not.
        const fromChannel = cause instanceof StudioReplyError
        // The edit bar shows it now or when it is opened again; with no editor on screen the card says it too.
        setError({ message, fromChannel })
        if (!editorOpen.current) setNotice(t('gifEditFailedNotice', { reason: message }))
      } finally {
        setSending(false)
        if (busy.controller.current === controller) {
          busy.controller.current = undefined
          busy.setRunning(false)
        }
      }
    })()
  }

  return {
    t,
    availability,
    comments,
    setComments,
    busy: busy.running,
    sending,
    error,
    notice,
    editRequested,
    requestEdit: () => { setEditRequested(true) },
    takeEditRequest: () => {
      if (!editRequested) return false
      setEditRequested(false)
      return true
    },
    setEditorOpen: open => { editorOpen.current = open },
    beginEditing: () => { setNotice(undefined) },
    send,
    cancelSend: () => {
      busy.controller.current?.abort()
    },
    fallback: total => {
      if (image === undefined) return
      onFallback(composeFallbackPrompt(image.prompt, comments, total), t('gifEditFallbackHint'))
    },
  }
}

/** The card's edit chip, wired to open the lightbox in edit mode. */
export function GifCardEditChip({ edit, onOpen }: { edit: GifEdit; onOpen(): void }) {
  return <GifEditChip availability={edit.availability} t={edit.t} disabled={edit.busy} onOpen={() => { edit.requestEdit(); onOpen() }} />
}

/** A failure that came back while no editor was on screen, under the card title. */
export function GifEditNotice({ edit }: { edit: GifEdit }) {
  return edit.notice === undefined ? null : <div className="dsh-ig-gif-edit-notice" role="status">{edit.notice}</div>
}

/**
 * The GIF lightbox with the frame editor: entering edit mode pauses the
 * player and draws the sheet once (the sheet view and the request read it,
 * and it outlives frames the player releases); leaving it keeps the notes.
 * Escape leaves edit mode before it closes the lightbox.
 */
export function GifEditLightbox({ edit, ...props }: GifLightboxProps & { edit: GifEdit }) {
  const { player, gif } = props
  const t = gif.t
  const [editing, setEditing] = useState(false)
  // The frame counter needs the frame only while editing, when the player is mostly paused.
  const frameIndex = useSyncExternalStore(editing ? player.subscribe : noSubscription, () => (editing ? player.getSnapshot().index : 0), () => 0)
  const [view, setView] = useState<'gif' | 'sheet'>('gif')
  // Dropped, not cleared, on leaving: a send still encoding it holds its own reference.
  const [sheet, setSheet] = useState<DrawnSheet>()
  // Editing pauses on a frame; leaving it plays again if it was playing.
  const playedBefore = useRef(false)
  const enter = () => {
    const current = player.getSnapshot()
    const first = current.frames[0]
    if (current.status !== 'ready' || first === undefined) return
    playedBefore.current = current.playing
    player.pause()
    const plan = planGifSheet(current.frames.length, first.width, first.height)
    setSheet({ canvas: drawGifSheet(current.frames, plan), plan, frame: { width: first.width, height: first.height, delaysMs: [...current.delaysMs] } })
    setView('gif')
    setEditing(true)
    edit.beginEditing()
  }
  const leave = () => {
    setEditing(false)
    setSheet(undefined)
    if (playedBefore.current) player.play()
  }

  useEffect(() => {
    if (edit.takeEditRequest()) enter()
  }, [])

  useEffect(() => {
    edit.setEditorOpen(editing)
    return () => { edit.setEditorOpen(false) }
  }, [editing])

  useEffect(() => {
    if (!editing) return
    // Bubble phase on the document: a note box stops its own Escape first,
    // and the card's window listener that closes the lightbox never sees this one.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      leave()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [editing])

  const clear = () => {
    const count = edit.comments.length
    if (count === 0 || !window.confirm(t('gifCommentsClearConfirm', { count: String(count) }))) return
    edit.setComments([])
  }

  const frames = new Set(edit.comments.map(comment => comment.frame))
  return <GifLightbox
    {...props}
    wrapClassName={editing ? (view === 'sheet' ? 'is-editing is-sheet' : 'is-editing') : undefined}
    frameMarks={frames}
    stageOverlay={<GifCommentLayer player={player} editing={editing} view={view} sheet={sheet} comments={edit.comments} onChange={edit.setComments} t={t} />}
    barTrailing={edit.availability === undefined ? null : <GifEditToggle availability={edit.availability} editing={editing} t={t} onToggle={() => { if (editing) leave(); else enter() }} />}
    footer={editing ? <GifCommentBar
      view={view}
      current={frameIndex + 1}
      total={sheet?.plan.frames ?? 0}
      count={edit.comments.length}
      sending={edit.sending}
      error={edit.error?.message}
      errorHint={edit.error?.fromChannel === true ? t('gifEditFailedHint') : undefined}
      t={t}
      onView={setView}
      onClear={clear}
      onCancel={() => { if (edit.sending) edit.cancelSend(); else leave() }}
      onSend={() => { if (sheet !== undefined) edit.send(sheet) }}
      onFallback={() => { edit.fallback(sheet?.plan.frames ?? player.getSnapshot().frames.length) }}
    /> : null}
  />
}
