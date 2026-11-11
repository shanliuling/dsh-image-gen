import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { imageRef, type ToolCallBlock } from './image-ref.js'
import { imageResultsFromMeta, imageVersionKey, isRasterResult, originalFromMeta, resultIdentity, type ImageResultPresentation, type RasterImageResult } from './image-result-node.js'
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
import { fetchAttachmentBlob } from './image-cache.js'
import { DICT, usePluginLanguage, type DictKey } from './plugin-i18n.js'
import { CLOUD_IMAGE_PROVIDERS, STUDIO_ROUTE, type ImageProvider, type StudioGenerateResponse } from '../shared.js'
import { conversationRegenerateRequest, gifOutputRequest } from './conversation-regenerate.js'
import { GifCardOverlay, GifToolbarDownload, useGifCard } from './gif-card.js'
import { GifCardEditChip, GifEditLightbox, GifEditNotice, useGifEdit } from './gif-edit.js'
import { GifStage } from './gif-player.js'
import { startGalleryImageDrag } from './tl/gallery-image-transfer.js'

export interface ImageCardFace { locale?: LocaleService | undefined; promoted: boolean }
export type ImageCardProps = PropsRuntime<'tool.call.toolview'> & InjectFace<ImageCardFace> & { sessionId?: string | undefined }
export interface ImageResultNodeProps {
  node: { data: { results: readonly ImageResultPresentation[] } }
  locale?: LocaleService | undefined
  sessionId?: string | undefined
  /** The host's file opener, the one reply file links use; hosts that do not pass it get the plain path. */
  openFile?: ((path: string) => void) | undefined
}

export function GeneratedImageCard(props: ImageCardProps) {
  const result = imageResultFromBlock(props.block)
  if (props.promoted && result !== undefined) return <PromotedResultNotice locale={props.locale} />
  // A tool-call block always carries a stored attachment; vector results only
  // arrive through result metadata or a PTC dispatch.
  return <ImageResultCard result={result !== undefined && isRasterResult(result) ? result : undefined} locale={props.locale} sessionId={props.sessionId} openFile={props.openFile} />
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
    {results.map((result, index) => <ResultCard key={`${resultIdentity(result)}:${index}`} result={result} locale={props.locale} sessionId={props.sessionId} openFile={props.openFile} />)}
  </div>
}

/** Route one result to its card: vector markup has no attachment to render. */
function ResultCard({ result, locale, sessionId, openFile }: {
  result: ImageResultPresentation
  locale?: LocaleService | undefined
  sessionId?: string | undefined
  openFile?: ((path: string) => void) | undefined
}) {
  if (!isRasterResult(result)) return <SvgResultCard result={result} locale={locale} openFile={openFile} />
  return <ImageResultCard result={result} locale={locale} sessionId={sessionId} openFile={openFile} />
}

/** Render modern image artifacts as final conversation output instead of Tool process content. */
export function PromotedImageResultNode(props: ImageResultNodeProps) {
  return <div className="dsh-ig-promoted-results">
    {props.node.data.results.map((result, index) =>
      <ResultCard key={`${resultIdentity(result)}:${index}`} result={result} locale={props.locale} sessionId={props.sessionId} openFile={props.openFile} />)}
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
  openFile,
}: {
  result?: RasterImageResult | undefined
  locale?: LocaleService | undefined
  sessionId?: string | undefined
  openFile?: ((path: string) => void) | undefined
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
  const [error, setError] = useState<string>()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [toast, setToast] = useState<string>()
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [regeneratePrompt, setRegeneratePrompt] = useState('')
  const [regenerateError, setRegenerateError] = useState<string>()
  // Set when the dialog regenerates from frame notes instead of the plain prompt.
  const [regenerateHint, setRegenerateHint] = useState<string>()
  const [isRegenerating, setIsRegenerating] = useState(false)
  const regenerateControllerRef = useRef<AbortController>()
  const regenerateTextareaRef = useRef<HTMLTextAreaElement>(null)
  const lang = usePluginLanguage(locale)

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

  const baseGalleryRecord = (presentation: RasterImageResult): GalleryRecord => ({
    id: imageVersionKey(String(presentation.attachment.attachmentId), presentation.original),
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
    id: imageVersionKey(String(revision.attachment.attachmentId), revision.original),
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

  const [gifPopupOpen, setGifPopupOpen] = useState(false)
  const gif = useGifCard({
    lang,
    original: activeOriginal,
    attachmentMediaType: activeAttachment?.mediaType,
    attachmentBlob: blob,
    onOriginalGone: () => {
      const record = currentGalleryRecord()
      if (record !== undefined) void saveGalleryItem({ ...record, original: undefined })
    },
  })
  const edit = useGifEdit({
    gif,
    image: originId ? activeResult : undefined,
    versionKey: activeAttachment === undefined ? undefined : imageVersionKey(String(activeAttachment.attachmentId), activeOriginal),
    busy: { running: isRegenerating, setRunning: setIsRegenerating, controller: regenerateControllerRef },
    addRevision: async revision => {
      const savedOk = await persistGalleryRecord(revisionGalleryRecord(revision))
      setRevisionChain(appendConversationImageRevision(String(originId), revision))
      return savedOk
    },
    onSent: message => {
      setPreviewOpen(false)
      setToast(message)
      setTimeout(() => { setToast(undefined) }, 3500)
    },
    onFallback: (prompt, hint) => {
      setPreviewOpen(false)
      setRegeneratePrompt(prompt)
      setRegenerateError(undefined)
      setRegenerateHint(hint)
      setRegenerateOpen(true)
    },
  })

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
      if (e.key === 'Escape') setPreviewOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [previewOpen])

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

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (gif.player !== undefined) {
      const message = await gif.copyFrame()
      if (message === undefined) return
      setToast(message)
      setTimeout(() => { setToast(undefined) }, 3500)
      return
    }
    if (!blob) return
    const ok = await copyImageBlob(blob)
    setToast(ok ? t('copiedImage') : t('copyFailed'))
    setTimeout(() => { setToast(undefined) }, 2000)
  }

  const download = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = activeAttachment?.name || `dsh-image-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // A host that opens files shows the saved one in its sidebar, and cannot open a new tab; only the conversation image has a saved file.
  const opensSavedFile = openFile !== undefined && savedTo !== undefined && selectedRevision === undefined
  const openNewTab = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (opensSavedFile) {
      openFile(savedTo)
      return
    }
    const target = gif.player?.url ?? url
    if (!target) return
    window.open(target, '_blank', 'noopener,noreferrer')
  }

  /** Drag the GIF out as a file, the same bytes a download would give. */
  const onDragStart = (event: DragEvent<HTMLElement>) => {
    const record = currentGalleryRecord()
    if (record === undefined) return
    startGalleryImageDrag(event, { createdAt: 0, ...record }, gif.file())
  }

  const openRegenerate = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (activeResult === undefined || isRegenerating) return
    setRegeneratePrompt(activeResult.prompt)
    setRegenerateError(undefined)
    setRegenerateHint(undefined)
    setRegenerateOpen(true)
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
      const request = gif.animated ? { ...base, output: gifOutputRequest(await gif.info()) } : base
      const response = await fetch(STUDIO_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const payload = await response.json().catch(() => null) as StudioGenerateResponse | { error?: string } | null
      if (!response.ok || payload === null || !('attachment' in payload)) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : t('regenerateFailed'))
      }
      const original = originalFromMeta(payload.original)
      const revision: ConversationImageRevision = {
        attachment: payload.attachment,
        prompt: payload.prompt,
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
      const next = appendConversationImageRevision(String(originId), revision)
      setRevisionChain(next)
      setToast(savedOk ? t('regenerate') : t('regenerateSaveFailed'))
      setTimeout(() => { setToast(undefined) }, 2000)
    } catch (cause) {
      if (!controller.signal.aborted) {
        const errMsg = cause instanceof Error ? cause.message : String(cause)
        setError(errMsg)
        setToast(errMsg)
        setTimeout(() => { setToast(undefined) }, 3500)
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
    setRevisionChain(selectConversationImageRevision(String(originId), index))
  }

  const canRegenerate = activeResult !== undefined
    && (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(activeResult.provider)
    && activeResult.model.trim().length > 0
  const versionTotal = revisionChain.revisions.length + 1
  const versionCurrent = revisionChain.currentIndex + 1

  if (attachment === undefined) return <div className="dsh-ig-loading">{t('generating')}</div>
  return <section className="dsh-ig-result" aria-label={t('generatedTitle')}>
    <div className="dsh-ig-result-title">{t('generatedTitle')}{gif.animated ? <span className="dsh-ig-tag dsh-ig-gif-badge" title={gif.t('gifBadge')}>GIF</span> : null}</div>
    {savedTo !== undefined ? <div className="dsh-ig-savedto">{t('savedToPath')}: {openFile === undefined ? savedTo : <button type="button" className="dsh-ig-savedto-open" title={savedTo} onClick={() => { openFile(savedTo) }}>{savedTo}</button>}</div> : null}
    {error !== undefined ? <div className="dsh-ig-error">{error}</div> : null}
    <GifEditNotice edit={edit} />
    {url === undefined && error === undefined ? <div className="dsh-ig-loading">{t('loading')}</div> : null}
    {url !== undefined ? <div className={gifPopupOpen ? 'dsh-ig-container is-gif-open' : 'dsh-ig-container'}>
      {gif.player !== undefined
        ? <GifStage player={gif.player} stage="card" className="dsh-ig-image" alt={activeAttachment?.name ?? 'Generated image'} poster={url} onClick={() => { if (!isRegenerating) setPreviewOpen(true) }} onDragStart={onDragStart} />
        : <img
        className="dsh-ig-image"
        src={url}
        alt={activeAttachment?.name ?? 'Generated image'}
        onClick={() => { if (!isRegenerating) setPreviewOpen(true) }}
      />}
      <GifCardOverlay gif={gif} onOpenChange={setGifPopupOpen} />
      <GifCardEditChip edit={edit} onOpen={() => { if (!isRegenerating) setPreviewOpen(true) }} />
      {isRegenerating ? (
        <div className="dsh-ig-regenerate-overlay">
          <div className="dsh-ig-regenerate-spinner" />
          <span className="dsh-ig-regenerate-overlay-text">{t('regenerating')}</span>
          <button type="button" className="dsh-ig-regenerate-overlay-cancel" onClick={cancelRegenerate}>
            {t('cancel')}
          </button>
        </div>
      ) : null}
      <div className={gifPopupOpen || toast !== undefined ? 'dsh-ig-toolbar is-pinned' : 'dsh-ig-toolbar'}>
        {canRegenerate ? <button type="button" className="dsh-ig-tool-btn" disabled={isRegenerating} title={isRegenerating ? t('regenerating') : t('regenerate')} onClick={openRegenerate}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
        </button> : null}
        <button type="button" className="dsh-ig-tool-btn" title={gif.player !== undefined ? gif.t('gifCopyFrame') : t('copyImg')} onClick={(e) => { void copy(e) }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        {gif.player !== undefined ? <GifToolbarDownload gif={gif} onOpenChange={setGifPopupOpen} /> : <button type="button" className="dsh-ig-tool-btn" title={t('download')} onClick={download}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>}
        <button type="button" className="dsh-ig-tool-btn" title={opensSavedFile ? gif.t('openInSidebar') : openFile !== undefined ? gif.t('notSavedVersion') : t('openNewTab')} disabled={openFile !== undefined && !opensSavedFile} onClick={openNewTab}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        {toast ? <div className="dsh-ig-toast">{toast}</div> : null}
      </div>
      {versionTotal > 1 ? <div className="dsh-ig-version-nav" aria-label={t('versionLabel', { current: String(versionCurrent), total: String(versionTotal) })}>
        <button type="button" title={t('versionPrevious')} disabled={revisionChain.currentIndex === 0 || isRegenerating} onClick={(event) => { event.stopPropagation(); selectVersion(revisionChain.currentIndex - 1) }}>‹</button>
        <span className="dsh-ig-version-count">{versionCurrent}/{versionTotal}</span>
        <button type="button" title={t('versionNext')} disabled={revisionChain.currentIndex >= revisionChain.revisions.length || isRegenerating} onClick={(event) => { event.stopPropagation(); selectVersion(revisionChain.currentIndex + 1) }}>›</button>
      </div> : null}
    </div> : null}

    {previewOpen && url !== undefined && gif.player !== undefined
      ? <GifEditLightbox edit={edit} gif={gif} player={gif.player} alt={activeAttachment?.name ?? 'Generated image preview'} poster={url} onClose={() => { setPreviewOpen(false) }} onDragStart={onDragStart} />
      : null}
    {previewOpen && url !== undefined && gif.player === undefined ? <div className="dsh-ig-lightbox-backdrop" onClick={() => { setPreviewOpen(false) }}>
      <div className="dsh-ig-lightbox-img-wrap" onClick={(e) => { e.stopPropagation() }}>
        <img
          className="dsh-ig-lightbox-img"
          src={url}
          alt={activeAttachment?.name ?? 'Generated image preview'}
        />
      </div>
    </div> : null}
    {regenerateOpen && activeResult !== undefined ? <div className="dsh-ig-regenerate-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !isRegenerating) setRegenerateOpen(false)
    }}>
      <div className="dsh-ig-regenerate-dialog" role="dialog" aria-modal="true" aria-labelledby={`dsh-ig-regenerate-${String(originId)}`}>
        <h3 id={`dsh-ig-regenerate-${String(originId)}`}>{t('regenerateTitle')}</h3>
        <p>{regenerateHint ?? t('regenerateHint')}</p>
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


/**
 * Card for a vector result. DSH attachments store raster formats only, so the
 * markup the model received is rendered here as a data URL: the picture shows
 * in the conversation exactly like a bitmap card, with vector-only actions
 * (copy markup, download .svg).
 */
function SvgResultCard({ result, locale, openFile }: {
  result: ImageResultPresentation
  locale?: LocaleService | undefined
  openFile?: ((path: string) => void) | undefined
}) {
  const lang = usePluginLanguage(locale)
  const t = (keyName: DictKey): string => DICT[lang][keyName] || DICT.zh[keyName] || keyName
  const markup = result.svg ?? ''
  const [previewOpen, setPreviewOpen] = useState(false)
  const [toast, setToast] = useState<string>()
  const savedTo = result.savedTo
  // A percent-encoded data URL avoids base64 limits for large documents and
  // keeps the markup readable in devtools. <img> never runs scripts.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  const copyMarkup = () => {
    const flash = (message: string) => {
      setToast(message)
      setTimeout(() => { setToast(undefined) }, 2000)
    }
    // navigator.clipboard is missing outside a secure context.
    if (typeof navigator.clipboard?.writeText !== 'function') { flash(t('copyFailed')); return }
    void navigator.clipboard.writeText(markup).then(() => { flash(t('svgCopy')) }).catch(() => { flash(t('copyFailed')) })
  }
  const download = () => {
    const name = savedTo?.split(/[\\/]/).pop() ?? 'image.svg'
    const blobUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    const anchor = document.createElement('a')
    anchor.href = blobUrl
    anchor.download = name.endsWith('.svg') ? name : `${name}.svg`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => { URL.revokeObjectURL(blobUrl) }, 10_000)
  }
  return <section className="dsh-ig-result" aria-label={t('generatedTitle')}>
    <div className="dsh-ig-result-title">
      {t('generatedTitle')}
      <span className="dsh-ig-tag dsh-ig-svg-badge" title={t('svgPreviewHint')}>{t('svgBadge')}</span>
    </div>
    {savedTo !== undefined
      ? <div className="dsh-ig-savedto">{t('savedToPath')}: {openFile === undefined ? savedTo : <button type="button" className="dsh-ig-savedto-open" title={savedTo} onClick={() => { openFile(savedTo) }}>{savedTo}</button>}</div>
      : null}
    <div className="dsh-ig-container">
      <img
        className="dsh-ig-image"
        src={url}
        alt={result.prompt || 'Generated SVG'}
        onClick={() => { setPreviewOpen(true) }}
      />
      <div className={toast !== undefined ? 'dsh-ig-toolbar is-pinned' : 'dsh-ig-toolbar'}>
        <button type="button" className="dsh-ig-tool-btn" title={t('svgCopy')} onClick={copyMarkup}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>
        </button>
        <button type="button" className="dsh-ig-tool-btn" title={t('svgDownload')} onClick={download}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        {openFile !== undefined && savedTo !== undefined
          ? <button type="button" className="dsh-ig-tool-btn" title={t('openNewTab')} onClick={() => { openFile(savedTo) }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
          : null}
        {toast ? <div className="dsh-ig-toast">{toast}</div> : null}
      </div>
    </div>
    {previewOpen ? <div className="dsh-ig-lightbox-backdrop" onClick={() => { setPreviewOpen(false) }}>
      <div className="dsh-ig-lightbox-img-wrap" onClick={(event) => { event.stopPropagation() }}>
        <img className="dsh-ig-lightbox-img" src={url} alt={result.prompt || 'Generated SVG preview'} />
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
