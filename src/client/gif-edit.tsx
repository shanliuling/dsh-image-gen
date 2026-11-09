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
import { GifCommentBar, GifCommentLayer, GifEditChip, GifEditDoneBar, GifEditOverlay, GifEditToggle, fetchGifEditModel, gifEditAvailability, type GifEditAvailability, type GifEditDone, type GifEditPhase } from './gif-comments.js'
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

/** How long the reply waits before the new version is filed, so the bar is seen to fill (it takes .3s in gif-style.ts); the overlay stays until the version is filed. */
export const GIF_EDIT_FINISH_MS = 500

/** How long the card says how an edit went when it came back unwatched: the user is busy elsewhere and may glance back late. */
export const GIF_EDIT_SENT_TOAST_MS = 8_000

/** How long filing a new version waits for its picture: a fetch that stalls must not hold the version, or the overlay, back. */
export const GIF_EDIT_PREFETCH_WAIT_MS = 3_000

/** Settles as `promise` does, or with undefined once `ms` have passed, whichever is first. */
export function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { resolve(undefined) }, ms) })
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
}

/**
 * The redraw's estimated share after waiting this long. The channel reports
 * no progress, so the estimate rises quickly at first, slows down, and never
 * passes 90%: only the reply fills the bar.
 */
export function gifEditProgressAt(waitedMs: number): number {
  return 0.9 * (1 - Math.exp(-Math.max(0, waitedMs) / 25_000))
}

export interface GifEditStatus {
  phase: GifEditPhase | undefined
  /** Whole seconds since the send; ticks every second until the reply. */
  seconds: number
  /** The redraw's estimated share, 0 to 1. */
  progress: number
  /** Kept until the user goes on from it, closes the preview or sends again. */
  done: GifEditDone | undefined
}

/** One send's hold on the status; it does nothing once it ended, a later send began or the status was stopped. */
export interface GifEditRun {
  redraw(): void
  /** The reply is in: the bar fills and the seconds stop. */
  finish(): void
  /** Idle again, with what came of it when the editor is still on screen to show it. */
  succeed(done: GifEditDone | undefined): void
  stop(): void
}

export interface GifEditStatusStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): GifEditStatus
  start(): GifEditRun
  dismiss(): void
  /** Stop ticking and drop the send in progress. */
  stop(): void
}

const IDLE: GifEditStatus = { phase: undefined, seconds: 0, progress: 0, done: undefined }

/**
 * The card's send in progress and how the last one ended. It lives with the
 * card rather than the lightbox, which remounts when the new version loads,
 * and outside React state, so only the views that show the seconds re-render
 * every second.
 */
export function createGifEditStatus(): GifEditStatusStore {
  let snapshot = IDLE
  const listeners = new Set<() => void>()
  let current: object | undefined
  let startedAt = 0
  let redrawAt = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const set = (next: Partial<GifEditStatus>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  const seconds = () => Math.round((Date.now() - startedAt) / 1000)
  const halt = () => {
    clearInterval(timer)
    timer = undefined
  }
  const end = () => {
    halt()
    current = undefined
  }
  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    start: () => {
      halt()
      const run = {}
      current = run
      startedAt = Date.now()
      set({ ...IDLE, phase: 'preparing' })
      timer = setInterval(() => {
        set({ seconds: seconds(), progress: snapshot.phase === 'redrawing' ? gifEditProgressAt(Date.now() - redrawAt) : snapshot.progress })
      }, 1000)
      const live = () => current === run
      return {
        redraw: () => {
          if (!live()) return
          redrawAt = Date.now()
          set({ phase: 'redrawing', progress: 0 })
        },
        finish: () => {
          if (!live()) return
          halt()
          set({ phase: 'finishing', seconds: seconds(), progress: 1 })
        },
        succeed: done => {
          if (!live()) return
          end()
          set({ ...IDLE, done })
        },
        stop: () => {
          if (!live()) return
          end()
          set(IDLE)
        },
      }
    },
    dismiss: () => {
      if (snapshot.done !== undefined) set({ done: undefined })
    },
    stop: () => {
      end()
      if (snapshot.phase !== undefined) set({ phase: undefined, seconds: 0, progress: 0 })
    },
  }
}

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
  /** The edit came back as a new version while its editor was not on screen: close the lightbox and say how it went. */
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
  /** The send in progress; the views that show its seconds subscribe to it. */
  status: GifEditStatusStore
  /** The reply is in and its version is being filed: there is nothing left to cancel. */
  finishing: boolean
  /** An edit that came back while its editor was on screen; the preview shows it in place of the edit bar. */
  done: GifEditDone | undefined
  dismissDone(): void
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
  const [status] = useState(createGifEditStatus)
  const readDone = () => status.getSnapshot().done
  const done = useSyncExternalStore(status.subscribe, readDone, readDone)
  const readFinishing = () => status.getSnapshot().phase === 'finishing'
  const finishing = useSyncExternalStore(status.subscribe, readFinishing, readFinishing)
  const [error, setError] = useState<{ message: string; fromChannel: boolean }>()
  const [notice, setNotice] = useState<string>()
  const [editRequested, setEditRequested] = useState(false)
  const editorOpen = useRef(false)

  useEffect(() => () => { status.stop() }, [])

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
    setError(undefined)
    setNotice(undefined)
    const run = status.start()
    // Either cancel, the overlay's or the card's, clears the overlay at once rather than when the step in flight notices.
    controller.signal.addEventListener('abort', run.stop, { once: true })
    void (async () => {
      try {
        const limit = await readCanvasImageLimit(controller.signal).catch(() => 4_000_000)
        controller.signal.throwIfAborted()
        const encoded = await encodeSheetWithinLimit(sheet.canvas, sheet.plan, limit).catch(() => { throw new Error(t('gifSheetTooLarge')) })
        const data = (await blobToDataUrl(encoded.blob)).replace(/^[^,]*,/, '')
        const model = await fetchGifEditModel(image, controller.signal)
        const request = gifEditRequest({ image, model, comments, sheet: { mediaType: encoded.mediaType, data, plan: encoded.plan }, frame: sheet.frame, speed: player.getSnapshot().speed })
        run.redraw()
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
        run.finish()
        // The reply is paid for: from here a cancel no longer drops it, and the full bar shows before the new version is filed.
        await new Promise(resolve => { setTimeout(resolve, GIF_EDIT_FINISH_MS) })
        // Read before filing and again after: closing the preview while the version is filed counts as leaving. The
        // remount the new version causes reports no editor too, but only when React renders, after this has run.
        const watched = editorOpen.current
        const revision = revisionFromReply(payload, request, image.prompt)
        const savedOk = await addRevision(revision)
        // The channel answered with a still: kept as a version so the result is not lost.
        const still = revision.original?.mediaType !== 'image/gif' && revision.attachment.mediaType !== 'image/gif'
        if (!watched || !editorOpen.current) {
          onSent(still ? t('gifEditStill') : savedOk ? t('gifEditDone') : t('gifEditSaveFailed'))
          return
        }
        const message = still ? t('gifEditStill') : savedOk ? t('gifEditDoneHere', { seconds: String(status.getSnapshot().seconds) }) : t('gifEditSaveFailed')
        run.succeed({ message, still })
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
        run.stop()
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
    status,
    finishing,
    done,
    dismissDone: () => { status.dismiss() },
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
    beginEditing: () => {
      setNotice(undefined)
      status.dismiss()
    },
    send,
    // Frees the card at once, as its own cancel does, rather than when the step in flight notices: the notes can be sent again straight away.
    cancelSend: () => {
      busy.controller.current?.abort()
      busy.controller.current = undefined
      busy.setRunning(false)
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
 * A finished edit in the plain image preview, which takes over when the new
 * version is a still, and for a moment while a new animation's bytes load.
 */
export function GifEditDoneDock({ edit, onFinish }: { edit: GifEdit; onFinish(): void }) {
  if (edit.done === undefined) return null
  return <div className="dsh-ig-gif-dock is-plain" onClick={event => { event.stopPropagation() }}>
    <GifEditDoneBar done={edit.done} availability={edit.availability} t={edit.t} onFinish={onFinish} />
  </div>
}

/**
 * The GIF lightbox with the frame editor: entering edit mode pauses the
 * player and draws the sheet once (the sheet view and the request read it,
 * and it outlives frames the player releases); leaving it keeps the notes.
 * Escape leaves edit mode before it closes the lightbox. While a send runs the
 * picture is covered with its progress; an edit that comes back while the
 * editor is on screen leaves edit mode and shows the new version playing,
 * with its outcome where the edit bar was.
 */
export function GifEditLightbox({ edit, ...props }: GifLightboxProps & { edit: GifEdit }) {
  const { player, gif } = props
  const t = gif.t
  const status = useSyncExternalStore(edit.status.subscribe, edit.status.getSnapshot, edit.status.getSnapshot)
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

  // The paused frame and the sheet belonged to the version the edit replaced; the new one plays.
  useEffect(() => {
    if (edit.done === undefined) return
    setEditing(false)
    setSheet(undefined)
  }, [edit.done])

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
    stageOverlay={<>
      <GifCommentLayer player={player} editing={editing} view={view} sheet={sheet} comments={edit.comments} onChange={edit.setComments} t={t} />
      {status.phase === undefined ? null : <GifEditOverlay phase={status.phase} progress={status.progress} t={t} onCancel={edit.cancelSend} />}
    </>}
    barTrailing={edit.availability === undefined ? null : <GifEditToggle availability={edit.availability} editing={editing} t={t} onToggle={() => { if (editing) leave(); else enter() }} />}
    footer={editing ? <GifCommentBar
      view={view}
      current={frameIndex + 1}
      total={sheet?.plan.frames ?? 0}
      count={edit.comments.length}
      phase={status.phase}
      seconds={status.seconds}
      error={edit.error?.message}
      errorHint={edit.error?.fromChannel === true ? t('gifEditFailedHint') : undefined}
      t={t}
      onView={setView}
      onClear={clear}
      onSend={() => { if (sheet !== undefined) edit.send(sheet) }}
      onFallback={() => { edit.fallback(sheet?.plan.frames ?? player.getSnapshot().frames.length) }}
    /> : edit.done !== undefined ? <GifEditDoneBar done={edit.done} availability={edit.availability} t={t} onContinue={enter} onFinish={props.onClose} /> : null}
  />
}
