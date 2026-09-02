import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FC } from 'react'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  Download,
  Expand,
  FileText,
  Heart,
  ImagePlus,
  LoaderCircle,
  PanelLeft,
  PanelLeftClose,
  PencilLine,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { DELETE_ROUTE, SAVE_WORKSPACE_ROUTE, STUDIO_ROUTE, type StudioConfigResponse, type StudioGenerateResponse, type StudioGeneratedItem, type StudioProviderProfile, type StudioReference } from '../shared.js'
import { deleteGalleryItem, getGalleryItems, saveGalleryItem, subscribeGallery, toggleFavoriteGalleryItem, type GalleryItem } from './gallery-store.js'
import { evictAttachmentCache, fetchAttachmentBlob } from './image-cache.js'
import { copyImageBlob, downloadBlobUrl, formatRelativeTime } from './browser-image-utils.js'

const PAGE_SIZE = 12

export interface LocaleService {
  subscribe(cb: () => void): () => void
  getSnapshot(): { active?: string }
}

type Mode = 'generate' | 'edit'
type PanelTab = 'generate' | 'details'

export interface StudioReferenceItem {
  id: string
  attachment?: ImageAttachmentRef
  file?: File
  previewUrl: string
}

const COPY = {
  zh: {
    title: '云端生图工作台', configured: 'API 已配置', unconfigured: '未配置', recent: '最近生成', empty: '暂无生成历史',
    generate: '文生图', edit: '图生图', details: '图片详情', reference: '参考图', optional: '选填', upload: '点击或拖拽图片到此处',
    uploadHint: '支持 JPG / PNG / WebP / GIF，最大 10MB（最多 5 张）', prompt: '提示词 Prompt', clear: '清空', promptPlaceholder: '描述主体、构图、风格、光线与需要出现的文字…（支持 Ctrl+Enter 快捷生成）',
    provider: 'Provider', model: 'Model', ratio: '比例', quality: '清晰度', start: '开始生成', generating: '正在生成…', cancelGenerate: '取消生成',
    count: '生成数量', countUnit: '{n} 张', partialSuccess: '已生成 {success} 张图片，{failed} 张失败', generatingCount: '正在生成（共 {count} 张）…',
    batchResult: '本次生成（共 {count} 张）',
    saveToGallery: '收藏进画廊', savedToGallery: '已收藏进画廊', inGallery: '已在画廊',
    retry: '重新加载', configLoadFailed: '工作台配置加载失败，请检查服务后重试。',
    noProvider: '请先在设置中配置至少一个云端图像 Provider 的 API Key。', selectConfigured: '该 Provider 尚未配置，请先到设置中配置 API Key。',
    needPrompt: '请输入提示词', needReference: '请先添加至少一张参考图', result: '本次结果', continueEdit: '继续编辑（垫图）', regenerate: '再次生成',
    copy: '复制', copied: '已复制到剪贴板', copyFailed: '复制失败', download: '下载', remove: '删除', fit: '适应窗口', loading: '正在读取图片…', generationFailed: '生成失败',
    selectHistory: '从左侧选择一张图片，或在右侧开始新的生成。', created: '生成时间', elapsed: '耗时', dimensions: '尺寸', output: '输出参数',
    closeReference: '移除参考图', uploadInvalid: '请选择有效的图片文件（最大 10MB）', imageLoadFailed: '图片读取失败',
    fullscreen: '大图全屏', close: '关闭', copyPpt: '复制 Prompt', copiedPrompt: '已复制 Prompt', copiedImage: '已复制图片',
    favorite: '收藏', favorited: '已收藏', favoriteAdded: '已添加到收藏', favoriteRemoved: '已取消收藏',
    loadMore: '加载更多 ({n})', deleteModalTitle: '从图库删除', deleteModalDesc: '确定从图库中删除这张图片吗？（原聊天记录不会受影响）',
    deleteWorkspaceFilesLabel: '同时删除工作区本地文件', confirm: '确定删除', cancel: '取消', deletedToast: '已从图库删除',
    referencesCount: '参考图 ({current}/{max})', addMoreRef: '+ 添加', maxReferencesExceeded: '最多支持添加 {max} 张参考图',
    newGeneration: '新建生成', new: '新建',
    configuredCount: 'API 已配置 · {count}', unconfiguredStatus: 'API 未配置', providerStatus: '云端提供商与模型状态',
    collapseSidebar: '折叠最近生成', expandSidebar: '展开最近生成',
  },
  en: {
    title: 'Cloud Image Studio', configured: 'API configured', unconfigured: 'Not configured', recent: 'Recent generations', empty: 'No generated images yet',
    generate: 'Text to image', edit: 'Image to image', details: 'Image details', reference: 'Reference image', optional: 'optional', upload: 'Click or drop images here',
    uploadHint: 'JPG / PNG / WebP / GIF, up to 10MB (max 5)', prompt: 'Prompt', clear: 'Clear', promptPlaceholder: 'Describe the subject, composition, style, lighting, and exact text… (Ctrl+Enter to generate)',
    provider: 'Provider', model: 'Model', ratio: 'Aspect ratio', quality: 'Quality', start: 'Generate', generating: 'Generating…', cancelGenerate: 'Cancel',
    count: 'Number of images', countUnit: '{n}', partialSuccess: 'Generated {success} images, {failed} failed', generatingCount: 'Generating ({count} images)…',
    batchResult: 'Generated {count} images',
    saveToGallery: 'Save to Gallery', savedToGallery: 'Saved to Gallery', inGallery: 'In Gallery',
    retry: 'Retry', configLoadFailed: 'Failed to load studio configuration.',
    noProvider: 'Configure an API key for at least one cloud image provider in Settings.', selectConfigured: 'This provider is not configured. Add its API key in Settings first.',
    needPrompt: 'Enter a prompt', needReference: 'Add at least one reference image first', result: 'Current result', continueEdit: 'Continue editing', regenerate: 'Generate again',
    copy: 'Copy', copied: 'Copied to clipboard', copyFailed: 'Copy failed', download: 'Download', remove: 'Delete', fit: 'Fit', loading: 'Loading image…', generationFailed: 'Generation failed',
    selectHistory: 'Select an image on the left, or start a new generation on the right.', created: 'Created', elapsed: 'Elapsed', dimensions: 'Dimensions', output: 'Output',
    closeReference: 'Remove reference', uploadInvalid: 'Choose a valid image file up to 10MB.', imageLoadFailed: 'Could not load image',
    fullscreen: 'Fullscreen', close: 'Close', copyPpt: 'Copy Prompt', copiedPrompt: 'Prompt copied', copiedImage: 'Image copied',
    favorite: 'Favorite', favorited: 'Favorited', favoriteAdded: 'Added to favorites', favoriteRemoved: 'Removed from favorites',
    loadMore: 'Load more ({n})', deleteModalTitle: 'Delete from gallery', deleteModalDesc: 'Remove this image from the local gallery? (Chat history remains unaffected)',
    deleteWorkspaceFilesLabel: 'Also delete local workspace files', confirm: 'Delete', cancel: 'Cancel', deletedToast: 'Deleted from gallery',
    referencesCount: 'References ({current}/{max})', addMoreRef: '+ Add', maxReferencesExceeded: 'Up to {max} reference images allowed',
    newGeneration: 'New generation', new: 'New',
    configuredCount: 'API configured · {count}', unconfiguredStatus: 'Not configured', providerStatus: 'Provider & Model Status',
    collapseSidebar: 'Collapse sidebar', expandSidebar: 'Expand recent list',
  },
} as const

type CopyKey = keyof typeof COPY.zh

export interface StudioWorkspaceProps {
  workspaceId?: string | undefined
  path?: string | undefined
  title?: string | undefined
  sessionIds?: readonly string[] | undefined
}

export const StudioView: FC<{
  locale?: LocaleService | undefined
  workspace?: StudioWorkspaceProps | null | undefined
}> = ({ locale, workspace }) => {
  const [lang, setLang] = useState<'zh' | 'en'>(() => locale?.getSnapshot?.().active?.startsWith('en') ? 'en' : 'zh')
  const [config, setConfig] = useState<StudioConfigResponse | null>(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [items, setItems] = useState<GalleryItem[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(30)
  const [selected, setSelected] = useState<GalleryItem | null>(null)
  const [mode, setMode] = useState<Mode>('generate')
  const [panelTab, setPanelTab] = useState<PanelTab>('generate')
  const [provider, setProvider] = useState('google')
  const [model, setModel] = useState('')
  const [ratio, setRatio] = useState('1:1')
  const [quality, setQuality] = useState('1K')
  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<StudioReferenceItem[]>([])
  const [count, setCount] = useState(1)
  const [currentBatch, setCurrentBatch] = useState<GalleryItem[] | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Interactive Pan-Zoom Viewport State
  const [zoom, setZoom] = useState(100)
  const [fit, setFit] = useState(true)
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  const hasDraggedRef = useRef(false)

  const [dragging, setDragging] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteWorkspaceFiles, setDeleteWorkspaceFiles] = useState(true)
  const requestRef = useRef<AbortController | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const image = useAttachmentImage(selected?.attachment)

  const maxReferences = provider === 'dashscope' ? 3 : 5
  const referencesRef = useRef(references)
  referencesRef.current = references

  const t = (key: CopyKey, values?: Record<string, string>): string => {
    let text: string = COPY[lang][key]
    for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value)
    return text
  }

  useEffect(() => locale?.subscribe?.(() => setLang(locale.getSnapshot().active?.startsWith('en') ? 'en' : 'zh')), [locale])

  const loadConfig = useCallback(async () => {
    setConfigLoading(true)
    setConfigError(null)
    const controller = new AbortController()
    try {
      const response = await fetch(STUDIO_ROUTE, { signal: controller.signal, credentials: 'same-origin' })
      const payload = await response.json() as StudioConfigResponse | { error?: string }
      if (!response.ok || !('providers' in payload)) throw new Error('error' in payload && payload.error ? payload.error : 'Studio unavailable')
      setConfig(payload)
      const initial = payload.providers.find(item => item.provider === payload.activeProvider) ?? payload.providers[0]
      if (initial !== undefined) applyProvider(initial)
    } catch (fetchError) {
      if (!controller.signal.aborted) setConfigError(messageOf(fetchError))
    } finally {
      setConfigLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    let mounted = true
    const load = () => void getGalleryItems().then(next => {
      if (!mounted) return
      setItems(next)
      setSelected(current => current === null ? null : (next.find(item => item.id === current.id) ?? null))
    })
    load()
    const unsubscribe = subscribeGallery(load)
    return () => { mounted = false; unsubscribe() }
  }, [])

  // Abort only on component unmount
  useEffect(() => {
    return () => {
      requestRef.current?.abort()
    }
  }, [])

  // Revoke all reference object URLs on component unmount
  useEffect(() => {
    return () => {
      for (const item of referencesRef.current) {
        if (item.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(item.previewUrl)
        }
      }
    }
  }, [])

  // Support Escape to close Lightbox
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && lightboxOpen) {
        setLightboxOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [lightboxOpen])

  // Non-passive wheel zoom on canvas to prevent page scrolling and provide smooth zooming
  useEffect(() => {
    const canvasEl = canvasRef.current
    if (!canvasEl) return

    const onWheel = (e: WheelEvent) => {
      if (selected === null && (!currentBatch || currentBatch.length === 0)) return
      e.preventDefault()
      const delta = e.deltaY < 0 ? 15 : -15
      setFit(false)
      setZoom(prev => Math.min(500, Math.max(25, prev + delta)))
    }

    canvasEl.addEventListener('wheel', onWheel, { passive: false })
    return () => canvasEl.removeEventListener('wheel', onWheel)
  }, [selected, currentBatch])

  // Global mousemove and mouseup to handle canvas panning smoothly
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return
      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasDraggedRef.current = true
        setFit(false)
      }
      setOffset({
        x: dragStartRef.current.startX + dx,
        y: dragStartRef.current.startY + dy,
      })
    }

    const handleMouseUp = () => {
      dragStartRef.current = null
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const activeProfile = useMemo(() => config?.providers.find(item => item.provider === provider), [config, provider])
  const configuredCount = config?.providers.filter(item => item.configured).length ?? 0
  const displayItems = useMemo(() => items.slice(0, visibleLimit), [items, visibleLimit])

  const applyProvider = (profile: StudioProviderProfile) => {
    setProvider(profile.provider)
    setModel(profile.model)
    setRatio(profile.defaultRatio)
    setQuality(profile.defaultQuality)
    setError(null)
  }

  const changeProvider = (value: string) => {
    const profile = config?.providers.find(item => item.provider === value)
    if (profile !== undefined) {
      applyProvider(profile)
      const providerMax = value === 'dashscope' ? 3 : 5
      if (referencesRef.current.length > providerMax) {
        const keep = referencesRef.current.slice(0, providerMax)
        const overflow = referencesRef.current.slice(providerMax)
        for (const item of overflow) {
          if (item.previewUrl.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl)
        }
        setReferences(keep)
        referencesRef.current = keep
        setError(t('maxReferencesExceeded', { max: String(providerMax) }))
      }
    }
  }

  const resetFit = () => {
    setFit(true)
    setZoom(100)
    setOffset({ x: 0, y: 0 })
  }

  const selectItem = (item: GalleryItem) => {
    setCurrentBatch(null)
    setSelected(item)
    setPanelTab('details')
    resetFit()
  }

  const startNew = () => {
    setCurrentBatch(null)
    setSelected(null)
    setPanelTab('generate')
    resetFit()
  }

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    if (selected === null && (!currentBatch || currentBatch.length === 0)) return
    setIsDragging(true)
    hasDraggedRef.current = false
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startX: offset.x,
      startY: offset.y,
    }
  }

  const handleImageClick = () => {
    // Canvas click is for selection, not preview
  }

  const addReferenceFiles = (fileList: FileList | File[] | null | undefined) => {
    if (!fileList || fileList.length === 0) return
    const files = Array.from(fileList)
    const validFiles: File[] = []
    for (const file of files) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024) {
        setError(t('uploadInvalid'))
        continue
      }
      validFiles.push(file)
    }
    if (validFiles.length === 0) return

    const currentLen = referencesRef.current.length
    const available = maxReferences - currentLen
    if (available <= 0) {
      setError(t('maxReferencesExceeded', { max: String(maxReferences) }))
      return
    }

    const toAdd = validFiles.slice(0, available)
    if (validFiles.length > available) {
      setError(t('maxReferencesExceeded', { max: String(maxReferences) }))
    } else {
      setError(null)
    }

    const newItems: StudioReferenceItem[] = toAdd.map((file, idx) => ({
      id: `upload-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    setReferences(prev => [...prev, ...newItems])
  }

  const removeReference = (id: string) => {
    const target = referencesRef.current.find(item => item.id === id)
    if (target && target.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(target.previewUrl)
    }
    setReferences(prev => prev.filter(item => item.id !== id))
  }

  const clearAllReferences = () => {
    for (const item of referencesRef.current) {
      if (item.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(item.previewUrl)
      }
    }
    setReferences([])
  }

  const continueEdit = async () => {
    if (selected === null) return
    const targetItem = selected
    const targetAttId = targetItem.attachment.attachmentId
    const targetMax = targetItem.provider === 'dashscope' ? 3 : 5

    if (referencesRef.current.some(r => r.attachment?.attachmentId === targetAttId)) {
      setMode('edit')
      setPanelTab('generate')
      changeProvider(targetItem.provider)
      return
    }
    if (referencesRef.current.length >= targetMax) {
      setError(t('maxReferencesExceeded', { max: String(targetMax) }))
      return
    }

    try {
      const blob = image.blob ?? await fetchAttachmentBlob(targetItem.attachment)
      if (referencesRef.current.some(r => r.attachment?.attachmentId === targetAttId)) {
        setMode('edit')
        setPanelTab('generate')
        changeProvider(targetItem.provider)
        return
      }
      if (referencesRef.current.length >= targetMax) {
        setError(t('maxReferencesExceeded', { max: String(targetMax) }))
        return
      }

      const independentUrl = URL.createObjectURL(blob)
      const newItem: StudioReferenceItem = {
        id: `item-${targetItem.id}-${Date.now()}`,
        attachment: targetItem.attachment,
        previewUrl: independentUrl,
      }
      const nextList = [...referencesRef.current, newItem]
      setReferences(nextList)
      referencesRef.current = nextList
      setError(null)
      setMode('edit')
      setPanelTab('generate')
      changeProvider(targetItem.provider)
    } catch {
      setError(t('imageLoadFailed'))
    }
  }

  const cancelGeneration = () => {
    if (requestRef.current) {
      requestRef.current.abort()
      requestRef.current = null
      setIsGenerating(false)
    }
  }

  const submit = async () => {
    if (isGenerating || activeProfile === undefined) return
    if (prompt.trim().length === 0) return setError(t('needPrompt'))
    if (!activeProfile.configured) return setError(t('selectConfigured'))
    if (mode === 'edit' && references.length === 0) return setError(t('needReference'))
    setIsGenerating(true)
    setError(null)
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const referencesPayload: StudioReference[] | undefined = mode === 'edit' && references.length > 0
        ? await Promise.all(references.map(async (ref) => {
            if (ref.attachment !== undefined) {
              return { attachment: ref.attachment }
            }
            if (ref.file !== undefined) {
              return {
                mediaType: ref.file.type as ImageMediaType,
                data: await fileToBase64(ref.file),
                ...(ref.file.name ? { name: ref.file.name } : {}),
              }
            }
            throw new Error('无效参考图')
          }))
        : undefined

      const response = await fetch(STUDIO_ROUTE, {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode, provider, model, prompt: prompt.trim(), ratio, quality,
          ...(count > 1 ? { count } : {}),
          ...(workspace?.path ? { workspaceRoot: workspace.path } : {}),
          ...(referencesPayload === undefined ? {} : {
            references: referencesPayload,
          }),
        }),
      })
      const payload = await response.json() as StudioGenerateResponse | { error?: string }
      if (!response.ok || !('attachment' in payload)) throw new Error('error' in payload && payload.error ? payload.error : t('generationFailed'))

      const generatedList: StudioGeneratedItem[] = Array.isArray(payload.items) && payload.items.length > 0
        ? payload.items
        : [{
            attachment: payload.attachment,
            output: payload.output,
            ...(payload.savedTo ? { savedTo: payload.savedTo } : {}),
          }]

      const galleryEntries: GalleryItem[] = generatedList.map((gen, idx) => ({
        id: String(gen.attachment.attachmentId || `${payload.createdAt}-${idx}`),
        attachment: gen.attachment,
        prompt: payload.prompt,
        provider: payload.provider,
        model: payload.model,
        createdAt: payload.createdAt + idx,
        aspectRatio: ratio,
        imageSize: quality,
        output: gen.output,
        ...(gen.savedTo ? { savedTo: gen.savedTo } : {}),
        ...(workspace?.path ? { workspacePath: workspace.path } : {}),
        ...(workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
      }))

      if (galleryEntries.length > 1) {
        setCurrentBatch(galleryEntries)
        setSelected(galleryEntries[0]!)
      } else if (galleryEntries.length === 1) {
        setCurrentBatch(null)
        setSelected(galleryEntries[0]!)
      }
      setPanelTab('details')
      resetFit()

      if (payload.failedCount && payload.failedCount > 0) {
        flash(t('partialSuccess', { success: String(generatedList.length), failed: String(payload.failedCount) }))
      }
    } catch (submitError) {
      if (controller.signal.aborted) {
        return
      }
      setError(messageOf(submitError))
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setIsGenerating(false)
      }
    }
  }

  const isSelectedInGallery = useMemo(() => {
    if (selected === null) return false
    return items.some(item => item.id === selected.id)
  }, [items, selected])

  const handleSaveToGallery = async () => {
    if (selected === null || isSelectedInGallery) return
    let savedTo = selected.savedTo
    const targetRoot = workspace?.path || config?.workspaceRoot

    if (!savedTo) {
      try {
        const res = await fetch(SAVE_WORKSPACE_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            attachment: selected.attachment,
            ...(targetRoot ? { workspaceRoot: targetRoot } : {}),
          }),
        })
        if (res.ok) {
          const data = await res.json() as { ok: boolean; savedTo?: string }
          if (data.savedTo) {
            savedTo = data.savedTo
          }
        }
      } catch (e) {
        console.warn('Failed to save to workspace:', e)
      }
    }

    const updatedItem: GalleryItem = {
      ...selected,
      ...(savedTo ? { savedTo } : {}),
      ...(targetRoot ? { workspacePath: targetRoot } : {}),
      ...(workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
    }

    await saveGalleryItem(updatedItem)
    setSelected(updatedItem)
    if (currentBatch) {
      setCurrentBatch(prev => prev ? prev.map(i => i.id === updatedItem.id ? updatedItem : i) : prev)
    }
    flash(t('savedToGallery'))
  }

  const handleConfirmDelete = async () => {
    if (selected === null) return
    const idToDelete = selected.id
    const attachmentId = selected.attachment.attachmentId
    const savedPath = selected.savedTo
    setShowDeleteModal(false)
    try {
      if (deleteWorkspaceFiles && typeof savedPath === 'string' && savedPath.trim().length > 0) {
        const res = await fetch(DELETE_ROUTE, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: [savedPath] }),
        })
        if (!res.ok) {
          throw new Error(`删除请求网络异常 (${res.status})`)
        }
        const data = await res.json().catch(() => null) as { ok?: boolean; failedFiles?: Array<{ path: string; error: string }> } | null
        if (!data || data.ok === false || (Array.isArray(data.failedFiles) && data.failedFiles.length > 0)) {
          const reason = data?.failedFiles?.[0]?.error || '工作区文件删除失败'
          throw new Error(reason)
        }
      }
      if (isSelectedInGallery) {
        await deleteGalleryItem(idToDelete)
      }
      evictAttachmentCache(attachmentId)
      if (currentBatch) {
        const remaining = currentBatch.filter(i => i.id !== idToDelete)
        if (remaining.length > 1) {
          setCurrentBatch(remaining)
          setSelected(remaining[0]!)
        } else if (remaining.length === 1) {
          setCurrentBatch(null)
          setSelected(remaining[0]!)
        } else {
          setCurrentBatch(null)
          setSelected(null)
        }
      } else {
        setSelected(null)
      }
      flash(t('deletedToast'))
    } catch (delError) {
      setError(messageOf(delError))
    }
  }

  const copySelected = async () => {
    if (image.blob === null) return
    const ok = await copyImageBlob(image.blob)
    flash(ok ? t('copiedImage') : t('copyFailed'))
  }

  const downloadSelected = () => {
    if (image.url === null || selected === null) return
    downloadBlobUrl(image.url, `dsh-${selected.provider}-${selected.id.slice(-8)}.${extension(selected.attachment.mediaType)}`)
  }

  const toggleFavorite = async () => {
    if (selected === null) return
    const targetId = selected.id
    if (isSelectedInGallery) {
      const nextFav = await toggleFavoriteGalleryItem(targetId)
      setSelected(curr => (curr !== null && curr.id === targetId ? { ...curr, isFavorite: nextFav } : curr))
      if (currentBatch) {
        setCurrentBatch(prev => prev ? prev.map(i => i.id === targetId ? { ...i, isFavorite: nextFav } : i) : null)
      }
      flash(nextFav ? t('favoriteAdded') : t('favoriteRemoved'))
    } else {
      const nextFav = !selected.isFavorite
      setSelected(curr => (curr !== null && curr.id === targetId ? { ...curr, isFavorite: nextFav } : curr))
      if (currentBatch) {
        setCurrentBatch(prev => prev ? prev.map(i => i.id === targetId ? { ...i, isFavorite: nextFav } : i) : null)
      }
      flash(nextFav ? t('favoriteAdded') : t('favoriteRemoved'))
    }
  }

  const stepLightbox = (delta: number) => {
    if (!currentBatch || currentBatch.length <= 1 || selected === null) return
    const currIdx = currentBatch.findIndex(i => i.id === selected.id)
    if (currIdx === -1) return
    const nextIdx = (currIdx + delta + currentBatch.length) % currentBatch.length
    setSelected(currentBatch[nextIdx]!)
  }

  useEffect(() => {
    if (!lightboxOpen || !currentBatch || currentBatch.length <= 1) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') stepLightbox(-1)
      else if (e.key === 'ArrowRight') stepLightbox(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightboxOpen, currentBatch, selected])

  const flash = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(null), 2_200)
  }

  return (
    <section className="dsh-ig-workbench" aria-label={t('title')}>
      <div className={`dsh-ig-workbench-grid ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
        {!sidebarCollapsed && (
          <aside className="dsh-ig-recent-panel">
            <div className="dsh-ig-panel-title">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{t('recent')}</span>
                <span className="dsh-ig-count-badge">{items.length}</span>
              </div>
              <button
                type="button"
                className="dsh-ig-collapse-btn"
                onClick={() => setSidebarCollapsed(true)}
                title={t('collapseSidebar')}
              >
                <PanelLeftClose size={15} />
              </button>
            </div>
            <div className="dsh-ig-recent-scroll">
              {items.length === 0 ? <div className="dsh-ig-recent-empty"><ImagePlus size={22} /><span>{t('empty')}</span></div> : displayItems.map(item => <RecentItem key={item.id} item={item} active={selected?.id === item.id} lang={lang} onClick={() => selectItem(item)} />)}
              {items.length > visibleLimit && (
                <button type="button" className="dsh-ig-load-more" onClick={() => setVisibleLimit(l => l + 30)}>
                  {t('loadMore', { n: String(items.length - visibleLimit) })}
                </button>
              )}
            </div>
          </aside>
        )}

        <main className="dsh-ig-canvas-column">
          <div className="dsh-ig-canvas-toolbar">
            <div className="dsh-ig-canvas-toolbar-left">
              {sidebarCollapsed && (
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(false)}
                  title={t('expandSidebar')}
                >
                  <PanelLeft size={14} />
                  <span>{t('recent')}</span>
                </button>
              )}
              <div className="dsh-ig-status-badge-wrap">
                <div className="dsh-ig-status-badge">
                  <span className={`dsh-ig-status-dot ${configuredCount > 0 ? 'is-ready' : 'is-muted'}`} />
                  <span className="dsh-ig-status-text">
                    {configuredCount > 0 ? t('configuredCount', { count: String(configuredCount) }) : t('unconfiguredStatus')}
                  </span>
                  <ChevronDown size={11} className="dsh-ig-status-arrow" />
                </div>
                {config !== null && (
                  <div className="dsh-ig-status-popover">
                    <div className="dsh-ig-status-popover-title">{t('providerStatus')}</div>
                    <ul className="dsh-ig-status-list">
                      {config.providers.map(p => (
                        <li key={p.provider} className={p.configured ? 'is-configured' : 'is-missing'}>
                          <div className="dsh-ig-status-item-name">
                            <strong>{p.label}</strong>
                            <small>{p.model}</small>
                          </div>
                          <span className="dsh-ig-status-item-tag">
                            {p.configured ? t('configured') : t('unconfigured')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="dsh-ig-canvas-toolbar-right">
              {selected !== null && (
                <button type="button" onClick={startNew} title={t('newGeneration')}>
                  <Plus size={13} />
                  <span>{t('newGeneration')}</span>
                </button>
              )}
              <button type="button" className={fit ? 'is-active' : ''} onClick={resetFit}>{t('fit')} <ChevronDown size={13} /></button>
              <button type="button" onClick={() => { setFit(false); setZoom(value => Math.max(25, value - 25)) }} title="Zoom out"><ZoomOut size={16} /></button>
              <span className="dsh-ig-zoom-display">{fit ? 'AUTO' : `${Math.round(zoom)}%`}</span>
              <button type="button" onClick={() => { setFit(false); setZoom(value => Math.min(500, value + 25)) }} title="Zoom in"><ZoomIn size={16} /></button>
              <button type="button" onClick={() => setLightboxOpen(true)} title={t('fullscreen')} disabled={selected === null}><Expand size={16} /></button>
            </div>
          </div>
          <div
            className={`dsh-ig-canvas ${isDragging ? 'is-dragging' : ''}`}
            ref={canvasRef}
            onMouseDown={handleCanvasMouseDown}
            onDoubleClick={resetFit}
          >
            {isGenerating ? (
              <div className="dsh-ig-generating-state">
                <div className="dsh-ig-generation-orbit"><Sparkles size={28} /></div>
                <strong>{count > 1 ? t('generatingCount', { count: String(count) }) : t('generating')}</strong>
                <span>{activeProfile?.label} · {model}</span>
              </div>
            ) : currentBatch && currentBatch.length > 1 ? (
              <div
                className="dsh-ig-canvas-cluster"
                data-count={currentBatch.length}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom / 100})`,
                  transformOrigin: 'center center',
                  transition: isDragging ? 'none' : 'transform 0.08s ease-out',
                }}
              >
                {currentBatch.map((batchItem, index) => (
                  <BatchCanvasItem
                    key={batchItem.id}
                    item={batchItem}
                    index={index}
                    isSelected={selected?.id === batchItem.id}
                    onSelect={() => {
                      if (!hasDraggedRef.current) {
                        setSelected(batchItem)
                      }
                    }}
                  />
                ))}
              </div>
            ) : selected === null ? (
              <div className="dsh-ig-canvas-empty"><ImagePlus size={36} /><span>{t('selectHistory')}</span></div>
            ) : image.loading ? (
              <div className="dsh-ig-canvas-empty"><LoaderCircle className="dsh-ig-spin" size={28} /><span>{t('loading')}</span></div>
            ) : image.url !== null ? (
              <img
                src={image.url}
                alt={selected.prompt}
                draggable={false}
                onClick={handleImageClick}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom / 100})`,
                  transformOrigin: 'center center',
                  transition: isDragging ? 'none' : 'transform 0.08s ease-out',
                }}
              />
            ) : (
              <div className="dsh-ig-canvas-empty"><ImagePlus size={32} /><span>{t('imageLoadFailed')}</span></div>
            )}
          </div>
          {selected !== null && <>
            <div className="dsh-ig-result-strip"><span>{t('result')}</span><div><button type="button" onClick={() => void continueEdit()}><PencilLine size={15} />{t('continueEdit')}</button><button type="button" onClick={() => { setMode('generate'); setPanelTab('generate'); setPrompt(selected.prompt) }}><RefreshCw size={15} />{t('regenerate')}</button></div></div>
            <div className="dsh-ig-result-actions">
              <p>{selected.prompt}</p>
              <div>
                <button
                  type="button"
                  className={`dsh-ig-save-gallery-btn ${isSelectedInGallery ? 'is-saved' : ''}`}
                  onClick={() => void handleSaveToGallery()}
                  title={isSelectedInGallery ? t('inGallery') : t('saveToGallery')}
                  disabled={isSelectedInGallery}
                >
                  {isSelectedInGallery ? <Check size={15} /> : <BookmarkPlus size={15} />}
                  <span>{isSelectedInGallery ? t('inGallery') : t('saveToGallery')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void toggleFavorite()}
                  title={selected.isFavorite ? t('favorited') : t('favorite')}
                >
                  <Heart
                    size={15}
                    fill={selected.isFavorite ? '#ef4444' : 'none'}
                    color={selected.isFavorite ? '#ef4444' : 'currentColor'}
                  />
                  <span>{selected.isFavorite ? t('favorited') : t('favorite')}</span>
                </button>
                <button type="button" onClick={() => void copySelected()}><Clipboard size={15} /><span>{t('copy')}</span></button>
                <button type="button" onClick={downloadSelected}><Download size={15} /><span>{t('download')}</span></button>
                <button type="button" onClick={() => setShowDeleteModal(true)}><Trash2 size={15} /><span>{t('remove')}</span></button>
              </div>
            </div>
            <div className="dsh-ig-result-meta"><span>{formatRelativeTime(selected.createdAt, lang)}</span><span>{selected.provider}</span><span>{selected.model}</span><span>{selected.attachment.width && selected.attachment.height ? `${selected.attachment.width} × ${selected.attachment.height}` : '—'}</span></div>
          </>}
        </main>

        <aside className="dsh-ig-generate-panel">
          <div className="dsh-ig-panel-tabs"><button type="button" className={panelTab === 'generate' ? 'is-active' : ''} onClick={() => setPanelTab('generate')}>{t('generate')}</button><button type="button" className={panelTab === 'details' ? 'is-active' : ''} onClick={() => setPanelTab('details')}>{t('details')}</button></div>
          {panelTab === 'details' ? <DetailsPanel item={selected} t={t} /> : <div className="dsh-ig-generator-form">
            <div className="dsh-ig-mode-switch"><button type="button" className={mode === 'generate' ? 'is-active' : ''} onClick={() => setMode('generate')}><Sparkles size={15} />{t('generate')}</button><button type="button" className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')}><ImagePlus size={15} />{t('edit')}</button></div>
            {mode === 'edit' && (
              <div className="dsh-ig-field">
                <div className="dsh-ig-field-label">
                  <label>
                    {t('referencesCount', { current: String(references.length), max: String(maxReferences) })} <b>*</b>
                  </label>
                  {references.length > 0 && (
                    <button type="button" onClick={clearAllReferences}>
                      {t('clear')}
                    </button>
                  )}
                </div>

                {references.length === 0 ? (
                  <button
                    type="button"
                    className={`dsh-ig-upload ${dragging ? 'is-dragging' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={event => { event.preventDefault(); setDragging(true) }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={event => {
                      event.preventDefault()
                      setDragging(false)
                      addReferenceFiles(event.dataTransfer.files)
                    }}
                  >
                    <Upload size={20} />
                    <strong>{t('upload')}</strong>
                    <small>{t('uploadHint')}</small>
                  </button>
                ) : (
                  <div className="dsh-ig-reference-grid">
                    {references.map((item, index) => (
                      <div key={item.id} className="dsh-ig-reference-card">
                        <img src={item.previewUrl} alt={`Ref ${index + 1}`} />
                        <button
                          type="button"
                          title={t('closeReference')}
                          onClick={() => removeReference(item.id)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    {references.length < maxReferences && (
                      <button
                        type="button"
                        className="dsh-ig-reference-add"
                        onClick={() => fileInputRef.current?.click()}
                        title={t('upload')}
                      >
                        <Upload size={16} />
                        <span>{t('addMoreRef')}</span>
                      </button>
                    )}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    addReferenceFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
              </div>
            )}
            <div className="dsh-ig-field">
              <div className="dsh-ig-field-label"><label htmlFor="dsh-ig-prompt">{t('prompt')} <b>*</b></label><button type="button" onClick={() => setPrompt('')}>{t('clear')}</button></div>
              <textarea
                id="dsh-ig-prompt"
                value={prompt}
                maxLength={2000}
                onChange={event => setPrompt(event.target.value)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault()
                    if (!isGenerating && config !== null && prompt.trim().length > 0) void submit()
                  }
                }}
                placeholder={t('promptPlaceholder')}
              />
              <small>{prompt.length}/2000</small>
            </div>
            {config === null ? (
              configLoading ? (
                <div className="dsh-ig-form-loading"><LoaderCircle className="dsh-ig-spin" size={18} /></div>
              ) : (
                <div className="dsh-ig-config-error">
                  <p>{configError ?? t('configLoadFailed')}</p>
                  <button type="button" onClick={() => void loadConfig()}><RefreshCw size={13} /><span>{t('retry')}</span></button>
                </div>
              )
            ) : <>
              <div className="dsh-ig-field-grid"><FieldSelect label={t('provider')} value={provider} onChange={changeProvider} options={config.providers.map(item => ({ value: item.provider, label: `${item.label}${item.configured ? '' : ` · ${t('unconfigured')}`}` }))} /><FieldSelect label={t('model')} value={model} onChange={setModel} options={activeProfile === undefined ? [] : [{ value: activeProfile.model, label: activeProfile.model }]} /></div>
              <div className="dsh-ig-field-grid"><FieldSelect label={t('ratio')} value={ratio} onChange={setRatio} options={activeProfile?.ratioOptions ?? []} /><FieldSelect label={t('quality')} value={quality} onChange={setQuality} options={activeProfile?.qualityOptions ?? []} /></div>
              <div className="dsh-ig-field">
                <label>{t('count')}</label>
                <div className="dsh-ig-count-row">
                  {[1, 2, 3, 4].map(option => (
                    <button
                      key={option}
                      type="button"
                      className={`dsh-ig-count-pill ${count === option ? 'is-active' : ''}`}
                      onClick={() => setCount(option)}
                    >
                      {t('countUnit', { n: String(option) })}
                    </button>
                  ))}
                </div>
              </div>
            </>}
            {configuredCount === 0 && config !== null && <div className="dsh-ig-inline-note">{t('noProvider')}</div>}
            {error !== null && <div className="dsh-ig-form-error">{error}</div>}
            {isGenerating ? (
              <button type="button" className="dsh-ig-generate-button is-cancel" onClick={cancelGeneration}>
                <LoaderCircle className="dsh-ig-spin" size={17} />
                <span>{t('cancelGenerate')}</span>
              </button>
            ) : (
              <button type="button" className="dsh-ig-generate-button" disabled={config === null} onClick={() => void submit()}>
                <Sparkles size={17} />
                <span>{t('start')}{count > 1 ? ` (${count})` : ''}</span>
              </button>
            )}
          </div>}
        </aside>
      </div>

      {/* Unified Pure Centered Lightbox Modal (Aligned with Gallery) */}
      {lightboxOpen && selected !== null && (
        <div className="dsh-ig-lightbox-backdrop" onClick={() => setLightboxOpen(false)}>
          <div className="dsh-ig-lightbox-topbar">
            <div className="dsh-ig-lightbox-meta">
              <span className="dsh-ig-tag">{selected.provider}</span>
              <span className="dsh-ig-tag dsh-ig-tag-model">{selected.model}</span>
              {currentBatch && currentBatch.length > 1 && (
                <span className="dsh-ig-tag">
                  {currentBatch.findIndex(i => i.id === selected.id) + 1} / {currentBatch.length}
                </span>
              )}
              {selected.attachment.width && selected.attachment.height ? (
                <span className="dsh-ig-tag">{selected.attachment.width} × {selected.attachment.height}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="dsh-ig-lightbox-close-btn"
              title={t('close')}
              onClick={() => setLightboxOpen(false)}
            >
              <X size={18} />
            </button>
          </div>

          {currentBatch && currentBatch.length > 1 && (
            <>
              <button
                type="button"
                className="dsh-ig-lightbox-nav is-prev"
                onClick={e => {
                  e.stopPropagation()
                  stepLightbox(-1)
                }}
                title="上一张"
              >
                <ChevronLeft size={24} />
              </button>
              <button
                type="button"
                className="dsh-ig-lightbox-nav is-next"
                onClick={e => {
                  e.stopPropagation()
                  stepLightbox(1)
                }}
                title="下一张"
              >
                <ChevronRight size={24} />
              </button>
            </>
          )}

          <div className="dsh-ig-lightbox-img-wrap" onClick={e => e.stopPropagation()}>
            {image.url !== null ? (
              <img
                className="dsh-ig-lightbox-img"
                src={image.url}
                alt={selected.prompt}
              />
            ) : (
              <div className="dsh-ig-lightbox-loading">
                <div className="dsh-ig-lightbox-spinner" />
              </div>
            )}
          </div>

          <div className="dsh-ig-lightbox-bottombar" onClick={e => e.stopPropagation()}>
            <div className="dsh-ig-lightbox-prompt-text" title={selected.prompt}>
              {selected.prompt}
            </div>
            <div className="dsh-ig-lightbox-actions">
              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={t('copyPpt')}
                onClick={async () => {
                  await navigator.clipboard.writeText(selected.prompt)
                  flash(t('copiedPrompt'))
                }}
              >
                <FileText size={14} />
                <span>{t('copyPpt')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={t('copy')}
                onClick={async () => {
                  if (!image.blob) return
                  const ok = await copyImageBlob(image.blob)
                  flash(ok ? t('copiedImage') : t('copyFailed'))
                }}
              >
                <Copy size={14} />
                <span>{t('copy')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={t('download')}
                onClick={downloadSelected}
              >
                <Download size={14} />
                <span>{t('download')}</span>
              </button>

              <button
                type="button"
                className={`dsh-ig-lightbox-btn ${isSelectedInGallery ? 'is-saved' : ''}`}
                title={isSelectedInGallery ? t('inGallery') : t('saveToGallery')}
                onClick={() => void handleSaveToGallery()}
                disabled={isSelectedInGallery}
              >
                {isSelectedInGallery ? <Check size={14} /> : <BookmarkPlus size={14} />}
                <span>{isSelectedInGallery ? t('inGallery') : t('saveToGallery')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={selected.isFavorite ? t('favorited') : t('favorite')}
                onClick={() => void toggleFavorite()}
              >
                <Heart size={14} fill={selected.isFavorite ? '#ef4444' : 'none'} color={selected.isFavorite ? '#ef4444' : 'currentColor'} />
                <span>{selected.isFavorite ? t('favorited') : t('favorite')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unified Deletion Danger Modal */}
      {showDeleteModal && selected !== null && (
        <div className="dsh-ig-workbench-modal-backdrop" onClick={() => setShowDeleteModal(false)}>
          <div className="dsh-ig-workbench-modal-box" onClick={e => e.stopPropagation()}>
            <div className="dsh-ig-workbench-modal-header">
              <AlertTriangle size={20} color="#dc2626" />
              <strong>{t('deleteModalTitle')}</strong>
            </div>
            <p className="dsh-ig-workbench-modal-desc">{t('deleteModalDesc')}</p>
            {Boolean(selected.savedTo) && (
              <label className="dsh-ig-workbench-modal-option">
                <input
                  type="checkbox"
                  checked={deleteWorkspaceFiles}
                  onChange={e => setDeleteWorkspaceFiles(e.target.checked)}
                />
                <span>{t('deleteWorkspaceFilesLabel')}</span>
              </label>
            )}
            <div className="dsh-ig-workbench-modal-actions">
              <button type="button" className="dsh-ig-workbench-modal-cancel" onClick={() => setShowDeleteModal(false)}>{t('cancel')}</button>
              <button type="button" className="dsh-ig-workbench-modal-danger" onClick={() => void handleConfirmDelete()}>{t('confirm')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Unified Floating Toast */}
      {notice !== null && <div className="dsh-ig-workbench-toast">{notice}</div>}
    </section>
  )
}

const BatchCanvasItem: FC<{
  item: GalleryItem
  index: number
  isSelected: boolean
  onSelect(): void
}> = ({ item, index, isSelected, onSelect }) => {
  const image = useAttachmentImage(item.attachment, true)
  return (
    <div
      className={`dsh-ig-canvas-item ${isSelected ? 'is-selected' : ''}`}
      onClick={onSelect}
    >
      <span className="dsh-ig-canvas-badge">#{index + 1}</span>
      {image.url !== null ? (
        <img src={image.url} alt={item.prompt} draggable={false} />
      ) : image.loading ? (
        <div className="dsh-ig-canvas-item-loading">
          <LoaderCircle className="dsh-ig-spin" size={24} />
        </div>
      ) : (
        <div className="dsh-ig-canvas-item-loading">
          <ImagePlus size={24} />
        </div>
      )}
    </div>
  )
}

const FieldSelect: FC<{ label: string; value: string; options: Array<{ value: string; label: string }>; onChange(value: string): void }> = ({ label, value, options, onChange }) => <label className="dsh-ig-field-select"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>

const DetailsPanel: FC<{ item: GalleryItem | null; t(key: CopyKey, values?: Record<string, string>): string }> = ({ item, t }) => item === null ? <div className="dsh-ig-details-empty"><ImagePlus size={28} /><span>{t('selectHistory')}</span></div> : <dl className="dsh-ig-details"><div><dt>{t('prompt')}</dt><dd>{item.prompt}</dd></div><div><dt>{t('provider')}</dt><dd>{item.provider}</dd></div><div><dt>{t('model')}</dt><dd>{item.model}</dd></div><div><dt>{t('dimensions')}</dt><dd>{item.attachment.width && item.attachment.height ? `${item.attachment.width} × ${item.attachment.height}` : '—'}</dd></div><div><dt>{t('output')}</dt><dd>{item.output ?? '—'}</dd></div><div><dt>{t('created')}</dt><dd>{new Date(item.createdAt).toLocaleString()}</dd></div></dl>

const RecentItem: FC<{ item: GalleryItem; active: boolean; lang: 'zh' | 'en'; onClick(): void }> = ({ item, active, lang, onClick }) => {
  const [setRef, inView] = useInView<HTMLButtonElement>()
  const image = useAttachmentImage(item.attachment, inView)
  return (
    <button ref={setRef} type="button" className={`dsh-ig-recent-item ${active ? 'is-active' : ''}`} onClick={onClick}>
      <div className="dsh-ig-recent-thumb">{image.url !== null ? <img src={image.url} alt="" loading="lazy" /> : <ImagePlus size={18} />}</div>
      <div>
        <strong>{item.prompt}</strong>
        <span>{formatRelativeTime(item.createdAt, lang)}</span>
        <small>{item.provider} · {item.model}</small>
        <small>{item.attachment.width && item.attachment.height ? `${item.attachment.width} × ${item.attachment.height}` : '—'}</small>
      </div>
    </button>
  )
}

function useInView<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [inView, setInView] = useState(false)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
    }
  }, [])

  const refCallback = useCallback((el: T | null) => {
    observerRef.current?.disconnect()
    if (!el || inView) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setInView(true)
        observer.disconnect()
      }
    }, { rootMargin: '120px' })
    observerRef.current = observer
    observer.observe(el)
  }, [inView])

  return [refCallback, inView]
}

export function useAttachmentImage(attachment: ImageAttachmentRef | undefined, shouldLoad: boolean = true): { url: string | null; blob: Blob | null; loading: boolean } {
  const [value, setValue] = useState<{ url: string | null; blob: Blob | null; loading: boolean }>({ url: null, blob: null, loading: false })
  useEffect(() => {
    if (attachment === undefined || !shouldLoad) { setValue({ url: null, blob: null, loading: false }); return }
    let cancelled = false
    let objectUrl: string | null = null
    setValue({ url: null, blob: null, loading: true })
    fetchAttachmentBlob(attachment)
      .then(blob => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setValue({ url: objectUrl, blob, loading: false })
      })
      .catch(() => { if (!cancelled) setValue({ url: null, blob: null, loading: false }) })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment?.attachmentId, shouldLoad])
  return value
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const commaIndex = result.indexOf(',')
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  })
}

function extension(mediaType: ImageMediaType): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1] ?? 'png'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
