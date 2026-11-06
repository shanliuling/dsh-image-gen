import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { imageRef, type ToolCallBlock } from './image-ref.js'
import { imageResultsFromMeta, originalFromMeta, type ImageResultPresentation } from './image-result-node.js'
import {
  appendConversationImageRevision,
  loadConversationImageRevisionChain,
  selectConversationImageRevision,
  type ConversationImageRevision,
  type ConversationImageRevisionChain,
} from './conversation-image-revisions.js'
import { saveGalleryItem } from './gallery-store.js'
import { persistGalleryRecord, type GalleryRecord } from './gallery-media.js'
import { copyImageBlob, type LocaleService } from './gallery-view.js'
import { blobToDataUrl, downloadBlobUrl } from './browser-image-utils.js'
import { fetchAttachmentBlob } from './image-cache.js'
import { DICT, usePluginLanguage, type DictKey } from './plugin-i18n.js'
import { CLOUD_IMAGE_PROVIDERS, STUDIO_ROUTE, vaultUrlFor, type ImageProvider, type StudioGenerateRequest, type StudioGenerateResponse } from '../shared.js'
import { conversationRegenerateRequest, gifOutputRequest } from './conversation-regenerate.js'
import { readGifInfo, retimeGif } from '../gif-info.js'
import { GifControls, GifStage, gifDownloadLabel, gifKeyboardAction, speedSuffix, useGifIndex, useGifPlayer, useGifSpeed, useGifStatus } from './gif-player.js'
import { GifCommentBar, GifCommentLayer, fetchGifEditModel, forgetGifEditFailure, gifEditAvailability, gifEditFailure, rememberGifEditFailure } from './gif-comment-editor.js'
import { composeFallbackPrompt, drawGifSheet, encodeSheetWithinLimit, gifEditRequest, planGifSheet, type GifComment, type GifSheetPlan } from './gif-sheet.js'
import { readCanvasImageLimit } from './tl/canvas-selection.js'
import { startGalleryImageDrag } from './tl/gallery-image-transfer.js'

/** The workbench answered the request with an error, its own or the provider's; a request that never got an answer throws a plain Error. */
class StudioReplyError extends Error {}

/** The sheet drawn when the editor opened, with the frames it was drawn from. */
interface DrawnSheet { canvas: HTMLCanvasElement; plan: GifSheetPlan; frame: { width: number; height: number; delaysMs: readonly number[] } }

export interface ImageCardFace { locale?: LocaleService | undefined; promoted: boolean }
export type ImageCardProps = PropsRuntime<'tool.call.toolview'> & InjectFace<ImageCardFace> & { sessionId?: string | undefined }
export interface ImageResultNodeProps {
  node: { data: { results: readonly ImageResultPresentation[] } }
  locale?: LocaleService | undefined
  sessionId?: string | undefined
}

export function GeneratedImageCard(props: ImageCardProps) {
  const result = imageResultFromBlock(props.block)
  if (props.promoted && result !== undefined) return <PromotedResultNotice locale={props.locale} />
  return <ImageResultCard result={result} locale={props.locale} sessionId={props.sessionId} />
}

/** Suppress the folded duplicate on modern hosts; render every image on legacy hosts. */
export function GeneratedImagesCard(props: ImageCardProps) {
  const block = props.block as unknown as {
    kind?: string
    meta?: unknown
    resultView?: { card?: string; meta?: unknown; content?: Array<{ type: string; text?: string; attachment?: ImageResultPresentation['attachment'] }> }
    content?: Array<{ type: string; text?: string; attachment?: ImageResultPresentation['attachment'] }>
  }
  let results = imageResultsFromMeta(block.meta ?? block.resultView?.meta)
  if (results.length === 0 && 'kind' in block) {
    const content = block.resultView?.card === 'generic' ? block.resultView.content : block.content
    results = (content ?? []).flatMap(item => item.type === 'image' && item.attachment !== undefined
      ? [{ attachment: item.attachment, prompt: 'Generated Image', provider: '', model: '', output: '' }]
      : [])
  }
  if (props.promoted && results.length > 0) return <PromotedResultNotice locale={props.locale} />
  if (results.length === 0) {
    if (!('kind' in block)) return <ImageResultCard locale={props.locale} />
    const content = block.content ?? block.resultView?.content ?? []
    return <div>{content.filter(item => item.type === 'text').map((item, index) => <p key={index}>{item.text}</p>)}</div>
  }
  return <div className="dsh-ig-promoted-results">
    {results.map((result, index) => <ImageResultCard key={`${result.attachment.attachmentId}:${index}`} result={result} locale={props.locale} sessionId={props.sessionId} />)}
  </div>
}

/** Render modern image artifacts as final conversation output instead of Tool process content. */
export function PromotedImageResultNode(props: ImageResultNodeProps) {
  return <div className="dsh-ig-promoted-results">
    {props.node.data.results.map((result, index) =>
      <ImageResultCard key={`${result.attachment.attachmentId}:${index}`} result={result} locale={props.locale} sessionId={props.sessionId} />)}
  </div>
}

function PromotedResultNotice({ locale }: { locale?: LocaleService | undefined }) {
  const lang = usePluginLanguage(locale)
  return <div className="dsh-ig-loading">{DICT[lang].resultShown}</div>
}

function ImageResultCard({
  result,
  locale,
  sessionId,
}: {
  result?: ImageResultPresentation | undefined
  locale?: LocaleService | undefined
  sessionId?: string | undefined
}) {
  const attachment = result?.attachment
  const originId = attachment?.attachmentId
  const [revisionChain, setRevisionChain] = useState<ConversationImageRevisionChain>(() =>
    loadConversationImageRevisionChain(String(originId ?? ''))
  )
  const selectedRevision = revisionChain.revisions[revisionChain.currentIndex - 1]
  const activeAttachment = selectedRevision?.attachment ?? attachment
  // The animation follows the version on display: a still revision of a GIF
  // card must not borrow the base animation.
  const activeOriginal = selectedRevision === undefined ? result?.original : selectedRevision.original
  const activeResult = selectedRevision !== undefined ? {
    prompt: selectedRevision.prompt,
    provider: selectedRevision.provider,
    ...(selectedRevision.channel === undefined ? {} : { channel: selectedRevision.channel }),
    model: selectedRevision.model,
    output: selectedRevision.output,
    createdAt: selectedRevision.createdAt,
    ...(result?.sourceAttachmentIds !== undefined && result.sourceAttachmentIds.length > 0
      ? { sourceAttachmentIds: result.sourceAttachmentIds }
      : {}),
  } : result
  const savedTo = result?.savedTo
  const [url, setUrl] = useState<string>()
  const [blob, setBlob] = useState<Blob>()
  const [gifBlob, setGifBlob] = useState<Blob>()
  const [gifUnavailable, setGifUnavailable] = useState(false)
  const [error, setError] = useState<string>()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [toast, setToast] = useState<string>()
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [regeneratePrompt, setRegeneratePrompt] = useState('')
  const [regenerateError, setRegenerateError] = useState<string>()
  const [isRegenerating, setIsRegenerating] = useState(false)
  const regenerateControllerRef = useRef<AbortController>()
  const regenerateTextareaRef = useRef<HTMLTextAreaElement>(null)
  // Frame comments: each version keeps its own notes while the card is
  // mounted (leaving the editor, switching versions or a sent edit keeps
  // them; only clearing removes them); the sheet is drawn once on entry.
  const [editing, setEditing] = useState(false)
  const [editView, setEditView] = useState<'gif' | 'sheet'>('gif')
  const [comments, setCommentsState] = useState<GifComment[]>([])
  const notesByVersion = useRef(new Map<string, GifComment[]>())
  const [editError, setEditError] = useState<{ message: string; fromChannel: boolean }>()
  // An edit that came back as a version but not as an animation; shown under the title until the next action.
  const [editNotice, setEditNotice] = useState<string>()
  const [regenerateFromNotes, setRegenerateFromNotes] = useState(false)
  const [sheet, setSheet] = useState<DrawnSheet>()
  const lang = usePluginLanguage(locale)
  const gifKey = activeOriginal?.mediaType === 'image/gif' ? activeOriginal.key : undefined
  // Notes belong to the version on display, which a raw GIF attachment is as
  // much as one the vault kept an original of.
  const notesKey = activeAttachment?.attachmentId
  // A reference whose file is gone (deleted from the gallery) is a still card again.
  const animated = (gifKey !== undefined && !gifUnavailable) || activeAttachment?.mediaType === 'image/gif'
  // The raw GIF comes from the vault when the host normalized the attachment,
  // or is the attachment itself when it did not.
  const player = useGifPlayer(gifKey !== undefined ? gifBlob : activeAttachment?.mediaType === 'image/gif' ? blob : undefined)
  const gifStatus = useGifStatus(player)
  const gifSpeed = useGifSpeed(player) ?? 1
  const gifReady = gifStatus === 'ready'
  const editFrame = useGifIndex(player, editing)
  const setComments = (next: GifComment[]) => {
    setCommentsState(next)
    if (notesKey !== undefined) notesByVersion.current.set(notesKey, next)
  }

  const t = (keyName: DictKey, params?: Record<string, string>): string => {
    const dict = lang === 'en' ? DICT.en : DICT.zh
    let text: string = dict[keyName] || DICT.zh[keyName] || keyName
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v)
      }
    }
    return text
  }

  const baseGalleryRecord = (presentation: ImageResultPresentation): GalleryRecord => ({
    id: presentation.attachment.attachmentId,
    attachment: presentation.attachment,
    prompt: presentation.prompt,
    provider: presentation.provider as ImageProvider,
    ...(presentation.channel === undefined ? {} : { channel: presentation.channel }),
    model: presentation.model,
    output: presentation.output,
    ...(presentation.savedTo ? { savedTo: presentation.savedTo } : {}),
    ...(presentation.seed !== undefined ? { seed: presentation.seed } : {}),
    ...(presentation.sourceAttachmentIds !== undefined && presentation.sourceAttachmentIds.length > 0
      ? { sourceAttachmentIds: [...presentation.sourceAttachmentIds] }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(presentation.original === undefined ? {} : { original: presentation.original }),
  })
  const revisionGalleryRecord = (revision: ConversationImageRevision): GalleryRecord => ({
    id: String(revision.attachment.attachmentId),
    attachment: revision.attachment,
    prompt: revision.prompt,
    provider: revision.provider,
    ...(revision.channel === undefined ? {} : { channel: revision.channel }),
    model: revision.model,
    createdAt: revision.createdAt,
    aspectRatio: revision.ratio,
    imageSize: revision.quality,
    resolution: revision.resolution,
    generationQuality: revision.generationQuality,
    watermark: revision.watermark,
    output: revision.output,
    ...(savedTo ? { savedTo } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(revision.original === undefined ? {} : { original: revision.original }),
  })
  const currentGalleryRecord = (): GalleryRecord | undefined =>
    selectedRevision !== undefined ? revisionGalleryRecord(selectedRevision) : result === undefined ? undefined : baseGalleryRecord(result)

  // Historical cards still populate the gallery. Canvas delivery subscribes
  // to live session events instead, so mounting old cards cannot replay images.
  useEffect(() => {
    if (result === undefined) return
    void persistGalleryRecord(baseGalleryRecord(result))
  }, [result?.attachment.attachmentId])

  useEffect(() => {
    if (!originId) return
    regenerateControllerRef.current?.abort()
    regenerateControllerRef.current = undefined
    setIsRegenerating(false)
    setRegenerateOpen(false)
    setRevisionChain(loadConversationImageRevisionChain(String(originId)))
  }, [originId])

  useEffect(() => () => { regenerateControllerRef.current?.abort() }, [])

  // Notes point into the frames of one version: the version on display brings its own.
  useEffect(() => {
    setCommentsState(notesKey === undefined ? [] : notesByVersion.current.get(notesKey) ?? [])
    closeEditor()
  }, [notesKey])

  useEffect(() => {
    if (!editing) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isRegenerating) closeEditor()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [editing, isRegenerating])

  useEffect(() => {
    if (!regenerateOpen || isRegenerating) return
    const frame = requestAnimationFrame(() => {
      regenerateTextareaRef.current?.focus()
      regenerateTextareaRef.current?.select()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRegenerateOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [regenerateOpen, isRegenerating])

  useEffect(() => {
    if (!previewOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPreviewOpen(false); return }
      if (player === undefined || player.getSnapshot().status !== 'ready') return
      const action = gifKeyboardAction(e.key, e.target as { tagName: string; type?: string } | null)
      if (action === undefined) return
      e.preventDefault()
      const run = { toggle: () => { player.toggle() }, previous: () => { player.step(-1) }, next: () => { player.step(1) }, first: () => { player.first() }, last: () => { player.last() } }
      run[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [previewOpen, player])

  const currentUrlRef = useRef<string | undefined>()

  useEffect(() => {
    return () => {
      if (currentUrlRef.current !== undefined) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = undefined
      }
    }
  }, [])

  useEffect(() => {
    if (activeAttachment === undefined) return
    let canceled = false
    void fetchAttachmentBlob(activeAttachment).then(resBlob => {
      if (canceled) return
      setBlob(resBlob)
      setError(undefined)
      const nextUrl = URL.createObjectURL(resBlob)
      if (currentUrlRef.current !== undefined) {
        URL.revokeObjectURL(currentUrlRef.current)
      }
      currentUrlRef.current = nextUrl
      setUrl(nextUrl)
    }).catch(cause => {
      if (canceled) return
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      canceled = true
    }
  }, [activeAttachment?.attachmentId])

  /** The vault fetch in flight, for a regeneration that starts before it lands. */
  const gifBlobRef = useRef<Promise<Blob | undefined>>()

  useEffect(() => {
    if (gifKey === undefined) {
      gifBlobRef.current = undefined
      return
    }
    let canceled = false
    const loading = fetch(vaultUrlFor(gifKey, 'image/gif'), { credentials: 'same-origin' }).then(async response => {
      if (response.ok) return response.blob()
      // Only the vault saying the file is gone (deleted from the gallery)
      // makes this a still card and drops the gallery record's reference, so
      // no later reference sync fails on it. Any other failure keeps both;
      // the next mount tries again.
      if (response.status === 404) return undefined
      throw new Error(`Original unavailable (${String(response.status)})`)
    })
    gifBlobRef.current = loading.catch(() => undefined)
    void loading.then(resBlob => {
      if (canceled) return
      if (resBlob !== undefined) {
        setGifBlob(resBlob)
        return
      }
      setGifUnavailable(true)
      const record = currentGalleryRecord()
      if (record !== undefined) void saveGalleryItem({ ...record, original: undefined })
    }, () => undefined)
    return () => {
      canceled = true
      setGifBlob(undefined)
      setGifUnavailable(false)
    }
  }, [gifKey])

  const showToast = (message: string, ms = 2000) => {
    setToast(message)
    setTimeout(() => { setToast(undefined) }, ms)
  }

  /** The GIF as it plays now: the provider's bytes at 1x, retimed delays at any other speed (which the bar offers only once the bytes are read). */
  const gifFile = (): Blob | undefined => {
    if (player === undefined) return undefined
    const bytes = player.bytes()
    if (bytes === undefined) return player.blob
    return new Blob([(retimeGif(bytes, gifSpeed) ?? bytes) as BlobPart], { type: 'image/gif' })
  }

  const downloadFile = (file: Blob, name: string) => {
    const objectUrl = URL.createObjectURL(file)
    downloadBlobUrl(objectUrl, name)
    setTimeout(() => { URL.revokeObjectURL(objectUrl) }, 10_000)
  }

  /** Frame facts of the GIF on display: the player's, or read from the raw bytes (the vault fetch still in flight, or the GIF attachment) while it has none yet. */
  const gifInfo = async () => {
    if (player !== undefined) return player.getSnapshot().info ?? readGifInfo(new Uint8Array(await player.blob.arrayBuffer()))
    const source = gifKey !== undefined ? await gifBlobRef.current : activeAttachment?.mediaType === 'image/gif' ? blob : undefined
    return source === undefined ? undefined : readGifInfo(new Uint8Array(await source.arrayBuffer()))
  }

  // The clipboard takes only still images: a decoded card copies the frame it
  // pauses on, a card without frames yet copies the still first frame, and the
  // toast says which, pointing at download or drag-out for the animation.
  const copyFrame = async () => {
    const frame = await player?.captureFrame()
    const target = frame ?? blob
    if (!target) return
    const ok = await copyImageBlob(target)
    const copied = player === undefined ? t('copiedImage')
      : frame === undefined ? t('gifCopiedFirstFrame')
      : t('gifCopiedFrame', { current: String(player.getSnapshot().index + 1), total: String(player.getSnapshot().frames.length) })
    showToast(ok ? copied : t('copyFailed'), ok && player !== undefined ? 3500 : 2000)
  }

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void copyFrame()
  }

  const downloadGif = () => {
    const file = gifFile()
    if (file === undefined) return
    downloadFile(file, `dsh-image-${String(Date.now())}${speedSuffix(gifSpeed)}.gif`)
  }

  const downloadFrame = async () => {
    const frame = await player?.captureFrame()
    if (frame === undefined || player === undefined) return
    downloadFile(frame, `dsh-image-${String(Date.now())}-frame${String(player.getSnapshot().index + 1)}.png`)
  }

  const download = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (player !== undefined) { downloadGif(); return }
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = activeAttachment?.name || `dsh-image-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const openNewTab = (e: React.MouseEvent) => {
    e.stopPropagation()
    const target = player?.url ?? url
    if (!target) return
    window.open(target, '_blank', 'noopener,noreferrer')
  }

  /** Drag the GIF out as a file, the same bytes a download would give. */
  const onDragStart = (event: DragEvent<HTMLElement>) => {
    const record = currentGalleryRecord()
    if (record === undefined) return
    startGalleryImageDrag(event, { createdAt: 0, ...record }, gifFile())
  }

  const openRegenerate = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (activeResult === undefined || isRegenerating) return
    setRegeneratePrompt(activeResult.prompt)
    setRegenerateError(undefined)
    setRegenerateFromNotes(false)
    setEditNotice(undefined)
    setRegenerateOpen(true)
  }

  /**
   * POST a workbench request and show its result as the next version of this
   * card, filed under `prompt` (the request's own unless given); says whether
   * the gallery kept it.
   */
  const submitRevision = async (request: StudioGenerateRequest, signal: AbortSignal, prompt?: string): Promise<{ savedOk: boolean; revision: ConversationImageRevision }> => {
    const response = await fetch(STUDIO_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const payload = await response.json().catch(() => null) as StudioGenerateResponse | { error?: string } | null
    if (!response.ok || payload === null || !('attachment' in payload)) {
      const reported = payload && 'error' in payload && payload.error ? payload.error : undefined
      throw reported === undefined ? new Error(t('regenerateFailed')) : new StudioReplyError(reported)
    }
    const original = originalFromMeta(payload.original)
    const revision: ConversationImageRevision = {
      attachment: payload.attachment,
      prompt: prompt ?? payload.prompt,
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
    const savedOk = await persistGalleryRecord(revisionGalleryRecord(revision))
    setRevisionChain(appendConversationImageRevision(String(originId), revision))
    return { savedOk, revision }
  }

  const openEditor = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (player === undefined || isRegenerating) return
    const snapshot = player.getSnapshot()
    const first = snapshot.frames[0]
    if (snapshot.status !== 'ready' || first === undefined) return
    player.pause()
    // Drawn once here, with the frame facts the request needs: the sheet view
    // and the request read them, and they outlive the frames the player
    // releases when the card scrolls away.
    const plan = planGifSheet(snapshot.frames.length, first.width, first.height)
    setSheet({ canvas: drawGifSheet(snapshot.frames, plan), plan, frame: { width: first.width, height: first.height, delaysMs: [...snapshot.delaysMs] } })
    setEditError(undefined)
    setEditNotice(undefined)
    setEditView('gif')
    setEditing(true)
  }

  function closeEditor() {
    setEditing(false)
    setEditError(undefined)
    if (sheet !== undefined) {
      sheet.canvas.width = 0
      setSheet(undefined)
    }
  }

  const clearComments = () => {
    if (comments.length === 0 || !window.confirm(t('gifCommentsClearConfirm', { count: String(comments.length) }))) return
    setComments([])
  }

  /** The notes as text requirements in the regenerate dialog: a plain generation, which keeps nothing of this animation. */
  const regenerateFromComments = () => {
    if (activeResult === undefined || isRegenerating) return
    const total = sheet?.plan.frames ?? player?.getSnapshot().info?.frames ?? comments.reduce((max, comment) => Math.max(max, comment.frame + 1), 0)
    setRegeneratePrompt(composeFallbackPrompt(activeResult.prompt, comments, total))
    setRegenerateError(undefined)
    setRegenerateFromNotes(true)
    setEditNotice(undefined)
    closeEditor()
    setRegenerateOpen(true)
  }

  const sendComments = async () => {
    if (activeResult === undefined || !originId || isRegenerating || sheet === undefined || comments.length === 0) return
    const image = activeResult
    setIsRegenerating(true)
    setEditError(undefined)
    const controller = new AbortController()
    regenerateControllerRef.current = controller
    try {
      const limit = await readCanvasImageLimit(controller.signal).catch(() => 4_000_000)
      controller.signal.throwIfAborted()
      const encoded = await encodeSheetWithinLimit(sheet.canvas, sheet.plan, limit).catch(() => { throw new Error(t('gifSheetTooLarge')) })
      const data = (await blobToDataUrl(encoded.blob)).replace(/^[^,]*,/, '')
      const model = await fetchGifEditModel(image, controller.signal)
      const request = gifEditRequest({ image, model, comments, sheet: { mediaType: encoded.mediaType, data, plan: encoded.plan }, frame: sheet.frame, speed: gifSpeed })
      // The new version is filed under the animation's own description, not
      // the sheet instructions, so regenerating or editing it starts from
      // what it shows; the notes stay with the version they were made on.
      const { savedOk, revision } = await submitRevision(request, controller.signal, image.prompt)
      closeEditor()
      if (revision.original?.mediaType !== 'image/gif' && revision.attachment.mediaType !== 'image/gif') {
        // The channel answered with a still: shown as a version so the result is not lost, and noted against the channel.
        rememberGifEditFailure(image, t('gifEditStill'))
        setEditNotice(t('gifEditStill'))
        return
      }
      forgetGifEditFailure(image)
      showToast(savedOk ? t('gifEditDone') : t('regenerateSaveFailed'))
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
        // Only an answer to the request says something about the channel; a
        // sheet too large to encode or a connection that dropped does not.
        const fromChannel = cause instanceof StudioReplyError
        setEditError({ message, fromChannel })
        if (fromChannel) rememberGifEditFailure(image, message)
      }
    } finally {
      if (regenerateControllerRef.current === controller) {
        regenerateControllerRef.current = undefined
        setIsRegenerating(false)
      }
    }
  }

  const cancelRegenerate = () => {
    regenerateControllerRef.current?.abort()
    regenerateControllerRef.current = undefined
    setIsRegenerating(false)
    setRegenerateOpen(false)
    setRegenerateError(undefined)
  }

  const regenerate = async () => {
    if (activeResult === undefined || !originId || isRegenerating || regeneratePrompt.trim().length === 0) return
    setIsRegenerating(true)
    setRegenerateError(undefined)
    // Non-blocking: close dialog immediately so user can continue chatting/scrolling!
    setRegenerateOpen(false)
    const controller = new AbortController()
    regenerateControllerRef.current = controller
    try {
      const base = conversationRegenerateRequest(
        activeResult,
        regeneratePrompt,
        selectedRevision === undefined ? undefined : { ratio: selectedRevision.ratio, quality: selectedRevision.quality, resolution: selectedRevision.resolution, generationQuality: selectedRevision.generationQuality, watermark: selectedRevision.watermark },
      )
      // An animated card asks for an animation again, with the frames and frame size it has.
      const request = animated ? { ...base, output: gifOutputRequest(await gifInfo()) } : base
      const { savedOk } = await submitRevision(request, controller.signal)
      showToast(savedOk ? t('regenerate') : t('regenerateSaveFailed'))
    } catch (cause) {
      if (!controller.signal.aborted) {
        const errMsg = cause instanceof Error ? cause.message : String(cause)
        setError(errMsg)
        showToast(errMsg, 3500)
      }
    } finally {
      if (regenerateControllerRef.current === controller) {
        regenerateControllerRef.current = undefined
        setIsRegenerating(false)
      }
    }
  }

  const selectVersion = (index: number) => {
    if (!originId || isRegenerating) return
    setEditNotice(undefined)
    setRevisionChain(selectConversationImageRevision(String(originId), index))
  }

  const canRegenerate = activeResult !== undefined
    && (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(activeResult.provider)
    && activeResult.model.trim().length > 0
  const versionTotal = revisionChain.revisions.length + 1
  const versionCurrent = revisionChain.currentIndex + 1
  const alt = activeAttachment?.name ?? 'Generated image'
  const editState = activeResult === undefined || !canRegenerate ? undefined
    : gifEditAvailability({ provider: activeResult.provider, animated, snapshot: player?.getSnapshot() })
  const editTitle = editState === 'ready' ? t('gifEdit') : editState === 'frame-count' ? t('gifEditTooManyFrames') : editState === 'unsupported' ? t('gifEditDecodeFailed') : editState === 'unloaded' ? t('gifEditNotLoaded') : t('gifEditDecoding')
  // The sheet view takes the stage's place; the stage stays mounted (invisible) so the player keeps its frames.
  const sheetView = editing && editView === 'sheet'

  if (attachment === undefined) return <div className="dsh-ig-loading">{t('generating')}</div>
  const media = url !== undefined ? <div className={editing ? 'dsh-ig-container dsh-ig-gif-editing' : 'dsh-ig-container'}>
    {player !== undefined
      ? <div className={sheetView ? 'dsh-ig-gif-edit-stage-hidden' : undefined}>
        <GifStage player={player} stage="card" className="dsh-ig-image" alt={alt} poster={url} onClick={() => { if (!isRegenerating) setPreviewOpen(true) }} onDragStart={onDragStart} />
      </div>
      : <img
        className="dsh-ig-image"
        src={url}
        alt={alt}
        onClick={() => { if (!isRegenerating) setPreviewOpen(true) }}
      />}
    {editing && player !== undefined && sheet !== undefined
      ? <GifCommentLayer player={player} view={editView} sheet={sheet.canvas} plan={sheet.plan} comments={comments} onChange={setComments} t={t} />
      : null}
    {isRegenerating ? (
      <div className="dsh-ig-regenerate-overlay">
        <div className="dsh-ig-regenerate-spinner" />
        <span className="dsh-ig-regenerate-overlay-text">{editing ? t('gifEditing') : t('regenerating')}</span>
        <button type="button" className="dsh-ig-regenerate-overlay-cancel" onClick={cancelRegenerate}>
          {t('cancel')}
        </button>
      </div>
    ) : null}
    {editing ? null : <div className="dsh-ig-toolbar">
      {canRegenerate ? <button type="button" className="dsh-ig-tool-btn" disabled={isRegenerating} title={isRegenerating ? t('regenerating') : t('regenerate')} onClick={openRegenerate}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
      </button> : null}
      {editState !== undefined ? <button type="button" className="dsh-ig-tool-btn" disabled={editState !== 'ready' || isRegenerating} title={editTitle} onClick={openEditor}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button> : null}
      <button type="button" className="dsh-ig-tool-btn" title={gifReady ? t('gifCopyFrame') : player !== undefined ? t('gifCopyFirstFrame') : t('copyImg')} onClick={copy}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button type="button" className="dsh-ig-tool-btn" title={player !== undefined ? gifDownloadLabel(t, gifSpeed) : t('download')} onClick={download}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button type="button" className="dsh-ig-tool-btn" title={t('openNewTab')} onClick={openNewTab}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>
      {toast ? <div className="dsh-ig-toast">{toast}</div> : null}
    </div>}
    {versionTotal > 1 && !editing ? <div className="dsh-ig-version-nav" aria-label={t('versionLabel', { current: String(versionCurrent), total: String(versionTotal) })}>
      <button type="button" title={t('versionPrevious')} disabled={revisionChain.currentIndex === 0 || isRegenerating} onClick={(event) => { event.stopPropagation(); selectVersion(revisionChain.currentIndex - 1) }}>‹</button>
      <span className="dsh-ig-version-count">{versionCurrent}/{versionTotal}</span>
      <button type="button" title={t('versionNext')} disabled={revisionChain.currentIndex >= revisionChain.revisions.length || isRegenerating} onClick={(event) => { event.stopPropagation(); selectVersion(revisionChain.currentIndex + 1) }}>›</button>
    </div> : null}
  </div> : null
  return <section className="dsh-ig-result" aria-label={t('generatedTitle')}>
    <div className="dsh-ig-result-title">{t('generatedTitle')}{animated ? <span className="dsh-ig-tag dsh-ig-gif-badge">GIF</span> : null}</div>
    {savedTo !== undefined ? <div className="dsh-ig-savedto">{t('savedToPath')}: {savedTo}</div> : null}
    {error !== undefined ? <div className="dsh-ig-error">{error}</div> : null}
    {editNotice !== undefined ? <div className="dsh-ig-gif-edit-notice" role="status">{editNotice}</div> : null}
    {url === undefined && error === undefined ? <div className="dsh-ig-loading">{t('loading')}</div> : null}
    {animated && media !== null
      ? <div className="dsh-ig-gif-block">
        {media}
        {player !== undefined ? <GifControls player={player} variant="card" t={t} onDownloadGif={downloadGif} onDownloadFrame={() => { void downloadFrame() }} /> : null}
        {editing && activeResult !== undefined ? <GifCommentBar
          current={editFrame + 1}
          total={sheet?.plan.frames ?? 0}
          comments={comments}
          view={editView}
          sending={isRegenerating}
          canSend={sheet !== undefined}
          notice={gifEditFailure(activeResult)}
          error={editError?.message}
          errorHint={editError?.fromChannel ? t('gifEditFailedHint') : undefined}
          t={t}
          onView={setEditView}
          onClear={clearComments}
          onCancel={closeEditor}
          onSend={() => { void sendComments() }}
          onFallback={regenerateFromComments}
        /> : null}
      </div>
      : media}

    {previewOpen && url !== undefined ? <div className="dsh-ig-lightbox-backdrop" onClick={() => { setPreviewOpen(false) }}>
      <div className="dsh-ig-lightbox-img-wrap" onClick={(e) => { e.stopPropagation() }}>
        {player !== undefined
          ? <GifStage player={player} stage="lightbox" className="dsh-ig-lightbox-img" alt={alt} poster={url} onDragStart={onDragStart} />
          : <img
            className="dsh-ig-lightbox-img"
            src={url}
            alt={activeAttachment?.name ?? 'Generated image preview'}
          />}
      </div>
      {player !== undefined ? <GifControls player={player} variant="lightbox" t={t} onDownloadGif={downloadGif} onDownloadFrame={() => { void downloadFrame() }} onCopyFrame={() => { void copyFrame() }} toast={toast} /> : null}
    </div> : null}
    {regenerateOpen && activeResult !== undefined ? <div className="dsh-ig-regenerate-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !isRegenerating) setRegenerateOpen(false)
    }}>
      <div className="dsh-ig-regenerate-dialog" role="dialog" aria-modal="true" aria-labelledby={`dsh-ig-regenerate-${String(originId)}`}>
        <h3 id={`dsh-ig-regenerate-${String(originId)}`}>{t('regenerateTitle')}</h3>
        <p>{regenerateFromNotes ? t('gifEditFallbackHint') : t('regenerateHint')}</p>
        <label>
          <span>{t('prompt')}</span>
          <textarea
            ref={regenerateTextareaRef}
            value={regeneratePrompt}
            disabled={isRegenerating}
            onChange={(event) => setRegeneratePrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void regenerate()
              }
            }}
          />
        </label>
        {regenerateError ? <p className="dsh-ig-regenerate-error" role="alert">{regenerateError}</p> : null}
        <div className="dsh-ig-regenerate-actions">
          <button type="button" className="dsh-ig-regenerate-cancel" onClick={cancelRegenerate}>{t('cancel')}</button>
          <button type="button" className="dsh-ig-regenerate-confirm" disabled={isRegenerating || regeneratePrompt.trim().length === 0} onClick={() => { void regenerate() }}>
            {t('confirmRegenerate')}
          </button>
        </div>
      </div>
    </div> : null}
  </section>
}


function imageResultFromBlock(block: ToolCallBlock): ImageResultPresentation | undefined {
  const attachment = imageRef(block)
  if (attachment === undefined) return undefined
  const blockValue = block as unknown as {
    meta?: Record<string, unknown>
    resultView?: { meta?: Record<string, unknown> }
    call?: { args?: { prompt?: string; source_attachment_id?: string; source_attachment_ids?: string[] } }
  }
  const meta = blockValue.meta ?? blockValue.resultView?.meta
  const sourceIds = Array.isArray(blockValue.call?.args?.source_attachment_ids)
    ? blockValue.call?.args?.source_attachment_ids
    : typeof blockValue.call?.args?.source_attachment_id === 'string'
      ? [blockValue.call?.args?.source_attachment_id]
      : undefined
  const original = originalFromMeta(meta?.original)
  return {
    attachment,
    prompt: typeof meta?.prompt === 'string' ? meta.prompt : blockValue.call?.args?.prompt ?? 'Generated Image',
    provider: typeof meta?.provider === 'string' ? meta.provider : 'google',
    model: typeof meta?.model === 'string' ? meta.model : '',
    output: typeof meta?.output === 'string' ? meta.output : '',
    ...(typeof meta?.savedTo === 'string' ? { savedTo: meta.savedTo } : {}),
    ...(typeof meta?.seed === 'number' ? { seed: meta.seed } : {}),
    ...(sourceIds !== undefined && sourceIds.length > 0 ? { sourceAttachmentIds: sourceIds } : {}),
    ...(original === undefined ? {} : { original }),
  }
}
