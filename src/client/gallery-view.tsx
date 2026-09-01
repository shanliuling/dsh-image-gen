/**
 * Native Workspace Gallery & Studio View Component for DSH `conversation.view` slot.
 * Fully i18n-reactive (Chinese & English) with modular tabs, multi-dimensional filters,
 * responsive image grid, and placeholder routes.
 */
import { useEffect, useState, useMemo, useRef, type FC, type MouseEvent } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IMAGE_ROUTE, DELETE_ROUTE, type ImageProvider } from '../shared.js'
import {
  Image as ImageIcon,
  SlidersHorizontal,
  Heart,
  GitCompare,
  ListTodo,
  Search,
  Copy,
  Download,
  FileText,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Check,
  AlertTriangle,
} from 'lucide-react'
import {
  getGalleryItems,
  subscribeGallery,
  deleteGalleryItem,
  bulkDeleteGalleryItems,
  toggleFavoriteGalleryItem,
  type GalleryItem,
} from './gallery-store.js'

export interface LocaleService {
  getSnapshot(): { active: string }
  subscribe(fn: () => void): () => void
}

export type TabKey = 'gallery' | 'studio' | 'favorites' | 'compare' | 'tasks'
export type SortKey = 'newest' | 'oldest'

const DICT = {
  zh: {
    // 顶部 Tab
    tabGallery: '图库',
    tabStudio: '工作台',
    tabFavorites: '收藏',
    tabCompare: '对比',
    tabTasks: '任务',

    // 筛选工具栏
    filterAllProviders: '全部提供商',
    filterGoogle: 'Google Gemini',
    filterOpenAI: 'OpenAI / 中转站',
    filterSeedream: '字节 Seedream',
    filterDashScope: '阿里 DashScope',
    filterComfyUI: '本地 ComfyUI',
    filterAllModels: '全部模型',
    filterAllRatios: '全部比例',
    searchPlaceholder: '搜索 Prompt、标签…',
    sortNewest: '最新生成',
    sortOldest: '最早生成',

    // 状态与提示
    totalCount: '共 {count} 张生成图片',
    emptyTitle: '暂无生图记录',
    emptyDesc: '在对话中让 Agent 生图后，生成的图片会自动收录到这里。',
    favEmptyTitle: '暂无收藏图片',
    favEmptyDesc: '在图库中点击卡片右下角的 ♡ 按钮，即可将喜爱的图片收录到这里。',
    noMatchTitle: '未找到匹配结果',
    noMatchDesc: '尝试更换搜索关键词或调整筛选条件。',
    copiedPrompt: '已复制 Prompt',
    copiedImage: '已复制图片',
    copyFailed: '复制失败',
    favoriteAdded: '已添加到收藏',
    favoriteRemoved: '已取消收藏',

    // 卡片与弹窗操作
    preview: '查看大图',
    download: '下载图片',
    copyImg: '复制图片',
    copyPpt: '复制 Prompt',
    delete: '从画廊删除',
    confirmDelete: '确定要从画廊中删除这张图片吗？（不会影响原聊天记录）',
    deleted: '已从画廊删除',
    model: '模型',
    prompt: 'Prompt',
    close: '关闭 (Esc)',
    prevImage: '上一张 (←)',
    nextImage: '下一张 (→)',

    // 批量管理与删除
    manage: '批量删除',
    exitManage: '退出选择',
    selectedCount: '已选 {n} 项',
    selectAll: '全选',
    invertSelect: '反选',
    clearSelect: '清空',
    batchDelete: '批量删除',
    batchDeleteTitle: '确认批量删除选中的 {count} 张图片？',
    batchDeleteTitleSingle: '确认从画廊中删除这张图片？',
    batchDeleteDesc: '将从画廊历史记录中移除所选图片。',
    deleteWorkspaceFilesOpt: '同时清理工作区磁盘物理文件（不可恢复）',
    cancel: '取消',
    confirmBatchDelete: '确认删除 ({count})',
    confirmDeleteSingle: '确认删除',
    batchDeletedToast: '已删除 {count} 张图片',
    batchDeletedWithFilesToast: '已删除 {count} 张图片，并清理了 {files} 个工作区文件',
    deleteFailedFileLocked: '已删除 {count} 张图片，但有 {files} 个文件因被系统占用未能删除',
    deleteFailedDatabase: '删除失败：本地数据库操作异常',

    // 时间格式化
    justNow: '刚刚',
    minutesAgo: '{n} 分钟前',
    hoursAgo: '{n} 小时前',
    daysAgo: '{n} 天前',

    // 预留模块占位
    studioTitle: 'AI 图像工作台 (Studio)',
    studioDesc: '工作台模块正在紧锣密鼓开发中。在此你将体验大图精修、变体生成 (Variations)、参数重调并一键将生成结果无缝插回 DSH 正在进行的对话。',
    studioTip: '💡 提示：目前你可以在“图库”中点击任意图片，在弹窗中进行查看、复制与下载。',
    compareTitle: '多模型横向对比 (Compare)',
    compareDesc: '支持单个 Prompt 一键同时调度 Gemini、Seedream、DashScope 及本地 ComfyUI 模型并排生成，直观横评画质与细节。',
    tasksTitle: '异步任务队列 (Tasks)',
    tasksDesc: '集中管理后台批量生图、多模型并发生成与本地 ComfyUI 耗时任务。支持状态追踪、失败重试与执行耗时分析。',
    comingSoonBadge: '即将推出',
  },
  en: {
    // Top Tabs
    tabGallery: 'Gallery',
    tabStudio: 'Studio',
    tabFavorites: 'Favorites',
    tabCompare: 'Compare',
    tabTasks: 'Tasks',

    // Filter Toolbar
    filterAllProviders: 'All Providers',
    filterGoogle: 'Google Gemini',
    filterOpenAI: 'OpenAI / Relay',
    filterSeedream: 'ByteDance Seedream',
    filterDashScope: 'Aliyun DashScope',
    filterComfyUI: 'Local ComfyUI',
    filterAllModels: 'All Models',
    filterAllRatios: 'All Ratios',
    searchPlaceholder: 'Search prompt, tags…',
    sortNewest: 'Newest first',
    sortOldest: 'Oldest first',

    // States & Toasts
    totalCount: '{count} images total',
    emptyTitle: 'No images generated yet',
    emptyDesc: 'Images generated during conversations will automatically appear here.',
    favEmptyTitle: 'No favorite images yet',
    favEmptyDesc: 'Click the ♡ button on any card in the gallery to collect your favorite images here.',
    noMatchTitle: 'No matching images',
    noMatchDesc: 'Try a different search keyword or adjust filter criteria.',
    copiedPrompt: 'Prompt copied',
    copiedImage: 'Image copied',
    copyFailed: 'Copy failed',
    favoriteAdded: 'Added to favorites',
    favoriteRemoved: 'Removed from favorites',

    // Card & Lightbox Actions
    preview: 'Full Preview',
    download: 'Download',
    copyImg: 'Copy Image',
    copyPpt: 'Copy Prompt',
    delete: 'Delete from gallery',
    confirmDelete: 'Are you sure you want to remove this image from the gallery? (Chat history will not be affected)',
    deleted: 'Deleted from gallery',
    model: 'Model',
    prompt: 'Prompt',
    close: 'Close (Esc)',
    prevImage: 'Previous (←)',
    nextImage: 'Next (→)',

    // Batch Management & Delete
    manage: 'Batch Delete',
    exitManage: 'Done',
    selectedCount: '{n} selected',
    selectAll: 'Select All',
    invertSelect: 'Invert',
    clearSelect: 'Clear',
    batchDelete: 'Batch Delete',
    batchDeleteTitle: 'Delete {count} selected images?',
    batchDeleteTitleSingle: 'Delete this image from gallery?',
    batchDeleteDesc: 'These images will be removed from your gallery history.',
    deleteWorkspaceFilesOpt: 'Also delete files from workspace disk (cannot be undone)',
    cancel: 'Cancel',
    confirmBatchDelete: 'Delete ({count})',
    confirmDeleteSingle: 'Delete',
    batchDeletedToast: 'Deleted {count} images',
    batchDeletedWithFilesToast: 'Deleted {count} images and cleaned {files} workspace files',
    deleteFailedFileLocked: 'Deleted {count} images, but {files} files could not be deleted (busy/locked)',
    deleteFailedDatabase: 'Failed to delete: local database error',

    // Relative Time
    justNow: 'Just now',
    minutesAgo: '{n}m ago',
    hoursAgo: '{n}h ago',
    daysAgo: '{n}d ago',

    // Route Placeholders
    studioTitle: 'AI Image Studio',
    studioDesc: 'Studio workbench is under active development. Fine-tune prompts, generate variations (2x/4x), and inject images directly into DSH chat.',
    studioTip: '💡 Tip: You can currently click any image in the Gallery to preview, copy, or download it.',
    compareTitle: 'Model Comparison (Compare)',
    compareDesc: 'Side-by-side multi-model benchmarking coming soon. Test Gemini, Seedream, DashScope, and ComfyUI with a single prompt.',
    tasksTitle: 'Task Queue (Tasks)',
    tasksDesc: 'Centralized view for batch generation, asynchronous ComfyUI runs, live progress tracking, and retry controls.',
    comingSoonBadge: 'Coming Soon',
  },
} as const

export type DictKey = keyof typeof DICT.zh

/** Format human-readable relative time */
function formatRelativeTime(
  timestamp: number,
  t: (key: DictKey, params?: Record<string, string>) => string
): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) {
    return t('justNow')
  }
  if (diff < 3600_000) {
    const mins = Math.max(1, Math.floor(diff / 60_000))
    return t('minutesAgo', { n: String(mins) })
  }
  if (diff < 86400_000) {
    const hours = Math.floor(diff / 3600_000)
    return t('hoursAgo', { n: String(hours) })
  }
  if (diff < 30 * 86400_000) {
    const days = Math.floor(diff / 86400_000)
    return t('daysAgo', { n: String(days) })
  }
  const d = new Date(timestamp)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** Extract standard aspect ratio for precise filtering */
function getItemRatio(item: GalleryItem): string {
  if (item.aspectRatio && item.aspectRatio !== 'custom') {
    return item.aspectRatio
  }
  if (item.output) {
    const ratioMatch = item.output.match(/\b(1:1|16:9|9:16|4:3|3:4|3:2|2:3)\b/)
    if (ratioMatch?.[1]) return ratioMatch[1]

    const dimMatch = item.output.match(/(\d{3,4})\s*[×x*]\s*(\d{3,4})/)
    if (dimMatch?.[1] && dimMatch[2]) {
      const w = parseInt(dimMatch[1], 10)
      const h = parseInt(dimMatch[2], 10)
      if (w === h) return '1:1'
      const approx = w / h
      if (Math.abs(approx - 16 / 9) < 0.05) return '16:9'
      if (Math.abs(approx - 9 / 16) < 0.05) return '9:16'
      if (Math.abs(approx - 4 / 3) < 0.05) return '4:3'
      if (Math.abs(approx - 3 / 4) < 0.05) return '3:4'
      if (Math.abs(approx - 3 / 2) < 0.05) return '3:2'
      if (Math.abs(approx - 2 / 3) < 0.05) return '2:3'
    }
  }
  return '1:1'
}

/** Format aspect ratio or dimensions for card metadata (e.g., 1024×1024 or 16:9) */
function formatCardMeta(item: GalleryItem): string {
  if (item.output) {
    const dimMatch = item.output.match(/(\d{3,4})\s*[×x*]\s*(\d{3,4})/)
    if (dimMatch?.[1] && dimMatch[2]) {
      return `${dimMatch[1]}×${dimMatch[2]}`
    }
  }
  if (item.aspectRatio && item.aspectRatio !== 'custom') {
    return item.aspectRatio
  }
  if (item.output) {
    const ratioMatch = item.output.match(/\b(1:1|16:9|9:16|4:3|3:4|3:2|2:3)\b/)
    if (ratioMatch?.[1]) return ratioMatch[1]
  }
  if (item.imageSize) {
    return item.imageSize
  }
  return '1:1'
}

export const GalleryViewTab: FC<{ locale?: LocaleService }> = ({ locale }) => {
  const [activeTab, setActiveTab] = useState<TabKey>('gallery')
  const [items, setItems] = useState<GalleryItem[]>([])
  const [search, setSearch] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('all')
  const [selectedRatio, setSelectedRatio] = useState<string>('all')
  const [sortBy, setSortBy] = useState<SortKey>('newest')
  const [previewItem, setPreviewItem] = useState<GalleryItem | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Batch Management & Shift-Selection State
  const [isManageMode, setIsManageMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastSelectedIndexRef = useRef<number | null>(null)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteWorkspaceFiles, setDeleteWorkspaceFiles] = useState(true)
  const [isDeleting, setIsDeleting] = useState(false)

  // Clear batch selection and shift anchor when switching tabs, searching, or changing filters
  useEffect(() => {
    setSelectedIds(new Set())
    lastSelectedIndexRef.current = null
  }, [activeTab, search, selectedProvider, selectedRatio, sortBy])

  const [lang, setLang] = useState<'zh' | 'en'>(() => {
    const active = locale?.getSnapshot?.()?.active
    return active?.startsWith('en') ? 'en' : 'zh'
  })

  useEffect(() => {
    if (!locale?.subscribe) return
    return locale.subscribe(() => {
      const active = locale.getSnapshot?.()?.active
      setLang(active?.startsWith('en') ? 'en' : 'zh')
    })
  }, [locale])

  const dict = lang === 'en' ? DICT.en : DICT.zh
  const t = (key: DictKey, params?: Record<string, string>): string => {
    let text: string = dict[key] || DICT.zh[key] || key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v)
      }
    }
    return text
  }

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => {
      setToast(null)
    }, 2000)
  }

  // Hide chat input composer while browsing gallery/studio
  useEffect(() => {
    const seat = document.querySelector('[data-composer-seat]') as HTMLElement | null
    if (seat) {
      const prevDisplay = seat.style.display
      seat.style.display = 'none'
      return () => {
        seat.style.display = prevDisplay
      }
    }
  }, [])

  // Load items from IndexedDB
  useEffect(() => {
    let active = true
    const load = () => {
      void getGalleryItems().then((res) => {
        if (active) setItems(res)
      })
    }
    load()
    const unsubscribe = subscribeGallery(load)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const [previewLoading, setPreviewLoading] = useState(false)
  const blobCache = useMemo(() => new Map<string, Blob>(), [])
  const abortControllerRef = useRef<AbortController | null>(null)

  // Multi-dimensional filtering and sorting (Provider, Ratio, Search, and Sort)
  const filteredItems = useMemo(() => {
    return items
      .filter((item) => {
        // Tab-level filter (Favorites tab only shows favorited items)
        if (activeTab === 'favorites' && !item.isFavorite) {
          return false
        }
        // Provider filter
        if (selectedProvider !== 'all' && item.provider !== selectedProvider) {
          return false
        }
        // Ratio filter
        if (selectedRatio !== 'all') {
          const ratio = getItemRatio(item)
          if (ratio !== selectedRatio) {
            return false
          }
        }
        // Search filter (Prompt, model, tags, provider)
        if (search.trim().length > 0) {
          const q = search.trim().toLowerCase()
          const matchPrompt = item.prompt?.toLowerCase().includes(q)
          const matchModel = item.model?.toLowerCase().includes(q)
          const matchProvider = item.provider?.toLowerCase().includes(q)
          const matchTags = item.tags?.some((t) => t.toLowerCase().includes(q))
          if (!matchPrompt && !matchModel && !matchProvider && !matchTags) {
            return false
          }
        }
        return true
      })
      .sort((a, b) => {
        if (sortBy === 'oldest') {
          return a.createdAt - b.createdAt
        }
        return b.createdAt - a.createdAt
      })
  }, [items, activeTab, selectedProvider, selectedRatio, search, sortBy])

  // Current item index in the active filtered sequence
  const currentPreviewIndex = useMemo(() => {
    if (!previewItem) return -1
    return filteredItems.findIndex((i) => i.id === previewItem.id)
  }, [previewItem, filteredItems])

  const hasPrev = currentPreviewIndex > 0
  const hasNext = currentPreviewIndex >= 0 && currentPreviewIndex < filteredItems.length - 1

  // Safely open or navigate preview item
  const openPreviewItem = (item: GalleryItem, blob?: Blob) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    setPreviewItem(item)

    if (blob) {
      blobCache.set(item.id, blob)
      const url = URL.createObjectURL(blob)
      setPreviewBlob(blob)
      setPreviewUrl(url)
      setPreviewLoading(false)
      return
    }

    const cached = blobCache.get(item.id)
    if (cached) {
      const url = URL.createObjectURL(cached)
      setPreviewBlob(cached)
      setPreviewUrl(url)
      setPreviewLoading(false)
      return
    }

    setPreviewLoading(true)
    setPreviewBlob(null)
    setPreviewUrl(null)

    const controller = new AbortController()
    abortControllerRef.current = controller

    void fetch(IMAGE_ROUTE, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachment: item.attachment }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((fetchedBlob) => {
        if (controller.signal.aborted) return
        blobCache.set(item.id, fetchedBlob)
        const url = URL.createObjectURL(fetchedBlob)
        setPreviewBlob(fetchedBlob)
        setPreviewUrl(url)
        setPreviewLoading(false)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setPreviewLoading(false)
        showToast(t('copyFailed'))
      })
  }

  // Close preview and revoke object URL
  const handleClosePreview = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    setPreviewItem(null)
    setPreviewUrl(null)
    setPreviewBlob(null)
    setPreviewLoading(false)
  }

  const goToPrev = () => {
    if (currentPreviewIndex > 0) {
      const prevItem = filteredItems[currentPreviewIndex - 1]
      if (prevItem) openPreviewItem(prevItem)
    }
  }

  const goToNext = () => {
    if (currentPreviewIndex >= 0 && currentPreviewIndex < filteredItems.length - 1) {
      const nextItem = filteredItems[currentPreviewIndex + 1]
      if (nextItem) openPreviewItem(nextItem)
    }
  }

  // Clean up any remaining preview URL on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  // Keyboard navigation: Esc (close modal or preview), ArrowLeft (prev), ArrowRight (next)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return
      }
      if (showDeleteModal) {
        if (e.key === 'Escape' && !isDeleting) {
          e.preventDefault()
          setShowDeleteModal(false)
          if (!isManageMode) setSelectedIds(new Set())
        }
        return
      }
      if (previewItem) {
        if (e.key === 'Escape') {
          handleClosePreview()
        } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
          e.preventDefault()
          goToPrev()
        } else if (e.key === 'ArrowRight' || e.key === 'Right') {
          e.preventDefault()
          goToNext()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showDeleteModal, isDeleting, isManageMode, previewItem, currentPreviewIndex, filteredItems])

  // Shift-Click Range Selection & Card Click Handler
  const handleCardClick = (item: GalleryItem, index: number, e: MouseEvent, blob?: Blob) => {
    // If holding Shift, or if currently in manage mode:
    if (e.shiftKey || isManageMode) {
      e.stopPropagation()
      if (!isManageMode) {
        setIsManageMode(true)
      }

      if (e.shiftKey && lastSelectedIndexRef.current !== null) {
        const from = Math.min(lastSelectedIndexRef.current, index)
        const to = Math.max(lastSelectedIndexRef.current, index)
        const rangeItems = filteredItems.slice(from, to + 1)
        setSelectedIds((prev) => {
          const next = new Set(prev)
          for (const r of rangeItems) {
            next.add(r.id)
          }
          return next
        })
      } else {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(item.id)) {
            next.delete(item.id)
          } else {
            next.add(item.id)
          }
          return next
        })
        lastSelectedIndexRef.current = index
      }
      return
    }

    // Normal click -> open preview
    if (blob) {
      openPreviewItem(item, blob)
    }
  }

  // Toggle selection for a specific card index
  const handleToggleSelect = (id: string, index: number, e: MouseEvent) => {
    e.stopPropagation()
    if (!isManageMode) {
      setIsManageMode(true)
    }

    if (e.shiftKey && lastSelectedIndexRef.current !== null) {
      const from = Math.min(lastSelectedIndexRef.current, index)
      const to = Math.max(lastSelectedIndexRef.current, index)
      const rangeItems = filteredItems.slice(from, to + 1)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const r of rangeItems) {
          next.add(r.id)
        }
        return next
      })
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      })
      lastSelectedIndexRef.current = index
    }
  }

  const handleSelectAll = () => {
    setSelectedIds(new Set(filteredItems.map((i) => i.id)))
  }

  const handleInvertSelect = () => {
    setSelectedIds((prev) => {
      const next = new Set<string>()
      for (const item of filteredItems) {
        if (!prev.has(item.id)) {
          next.add(item.id)
        }
      }
      return next
    })
  }

  const handleClearSelect = () => {
    setSelectedIds(new Set())
    lastSelectedIndexRef.current = null
  }

  const handleExitManage = () => {
    setIsManageMode(false)
    setSelectedIds(new Set())
    lastSelectedIndexRef.current = null
  }

  // Request single image deletion through the unified modal
  const requestSingleDelete = (item: GalleryItem, e?: MouseEvent) => {
    if (e) e.stopPropagation()
    setSelectedIds(new Set([item.id]))
    setShowDeleteModal(true)
  }

  // Execute batch deletion (IndexedDB single transaction + optional workspace disk unlink)
  const handleConfirmBatchDelete = async () => {
    if (selectedIds.size === 0 || isDeleting) return
    setIsDeleting(true)

    const idsToDelete = Array.from(selectedIds)
    const itemsToDelete = items.filter((i) => selectedIds.has(i.id))

    // 1. Separate items: if savedTo is known, ONLY use exact path (no broad scan!)
    const pathsToDelete = itemsToDelete
      .map((i) => i.savedTo)
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)

    // 2. Only send attachmentId as fallback for legacy items that lack savedTo:
    const fallbackAttachmentIds = itemsToDelete
      .filter((i) => !i.savedTo || !i.savedTo.trim())
      .map((i) => i.id)

    let deletedFiles = 0
    let failedFilesCount = 0

    if (deleteWorkspaceFiles && (pathsToDelete.length > 0 || fallbackAttachmentIds.length > 0)) {
      try {
        const res = await fetch(DELETE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            paths: pathsToDelete,
            attachmentIds: fallbackAttachmentIds,
          }),
        })
        if (res.ok) {
          const data = (await res.json()) as {
            deletedCount?: number
            failedFiles?: { path: string; error: string }[]
          }
          deletedFiles = data.deletedCount ?? 0
          if (Array.isArray(data.failedFiles)) {
            failedFilesCount = data.failedFiles.length
          }
        }
      } catch (err) {
        console.warn('[dsh-image-gen] Workspace file deletion failed:', err)
      }
    }

    // 3. Perform IndexedDB deletion with real error handling
    try {
      await bulkDeleteGalleryItems(idsToDelete)
    } catch (err) {
      setIsDeleting(false)
      showToast(t('deleteFailedDatabase'))
      return
    }

    // Close lightbox if preview item was deleted
    if (previewItem && selectedIds.has(previewItem.id)) {
      handleClosePreview()
    }

    setIsDeleting(false)
    setShowDeleteModal(false)
    if (isManageMode) {
      handleExitManage()
    } else {
      setSelectedIds(new Set())
      lastSelectedIndexRef.current = null
    }

    if (failedFilesCount > 0) {
      showToast(t('deleteFailedFileLocked', { count: String(idsToDelete.length), files: String(failedFilesCount) }))
    } else if (deletedFiles > 0) {
      showToast(t('batchDeletedWithFilesToast', { count: String(idsToDelete.length), files: String(deletedFiles) }))
    } else {
      showToast(t('batchDeletedToast', { count: String(idsToDelete.length) }))
    }
  }

  return (
    <div className="dsh-ig-gallery-page">
      {/* 1. Top Navigation Tabs */}
      <header className="dsh-ig-studio-tabs-bar">
        <button
          type="button"
          className={`dsh-ig-studio-tab-btn ${activeTab === 'gallery' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('gallery')}
        >
          <ImageIcon size={15} />
          <span>{t('tabGallery')}</span>
        </button>

        <button
          type="button"
          className={`dsh-ig-studio-tab-btn ${activeTab === 'studio' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('studio')}
        >
          <SlidersHorizontal size={15} />
          <span>{t('tabStudio')}</span>
        </button>

        <button
          type="button"
          className={`dsh-ig-studio-tab-btn ${activeTab === 'favorites' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('favorites')}
        >
          <Heart size={15} />
          <span>{t('tabFavorites')}</span>
        </button>

        <button
          type="button"
          className={`dsh-ig-studio-tab-btn ${activeTab === 'compare' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('compare')}
        >
          <GitCompare size={15} />
          <span>{t('tabCompare')}</span>
        </button>

        <button
          type="button"
          className={`dsh-ig-studio-tab-btn ${activeTab === 'tasks' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('tasks')}
        >
          <ListTodo size={15} />
          <span>{t('tabTasks')}</span>
        </button>
      </header>

      {/* 2. Secondary Filter & Search Toolbar (Displayed on Gallery & Favorites) */}
      {(activeTab === 'gallery' || activeTab === 'favorites') && (
        <div className="dsh-ig-studio-toolbar">
          <div className="dsh-ig-studio-toolbar-left">
            {/* Provider Filter */}
            <select
              className="dsh-ig-studio-select"
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
            >
              <option value="all">{t('filterAllProviders')}</option>
              <option value="google">{t('filterGoogle')}</option>
              <option value="openai">{t('filterOpenAI')}</option>
              <option value="seedream">{t('filterSeedream')}</option>
              <option value="dashscope">{t('filterDashScope')}</option>
              <option value="comfyui">{t('filterComfyUI')}</option>
            </select>

            {/* Ratio Filter */}
            <select
              className="dsh-ig-studio-select"
              value={selectedRatio}
              onChange={(e) => setSelectedRatio(e.target.value)}
            >
              <option value="all">{t('filterAllRatios')}</option>
              <option value="1:1">1:1</option>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
              <option value="3:2">3:2</option>
              <option value="2:3">2:3</option>
            </select>

            {/* Prompt & Tag Search Bar */}
            <div className="dsh-ig-studio-search-wrap">
              <Search className="dsh-ig-studio-search-icon" size={14} />
              <input
                type="text"
                className="dsh-ig-studio-search-input"
                placeholder={t('searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="dsh-ig-studio-toolbar-right">
            {/* Sort Dropdown */}
            <select
              className="dsh-ig-studio-select dsh-ig-studio-select-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
            >
              <option value="newest">{t('sortNewest')}</option>
              <option value="oldest">{t('sortOldest')}</option>
            </select>

            {/* Batch Delete Mode Toggle */}
            <button
              type="button"
              className={`dsh-ig-studio-btn dsh-ig-studio-btn-danger ${isManageMode ? 'is-active' : ''}`}
              title={isManageMode ? t('exitManage') : t('manage')}
              onClick={() => {
                if (isManageMode) {
                  handleExitManage()
                } else {
                  setIsManageMode(true)
                }
              }}
            >
              <Trash2 size={13} />
              <span>{isManageMode ? t('exitManage') : t('manage')}</span>
            </button>
          </div>
        </div>
      )}

      {/* 3. Main View Body */}
      <div className="dsh-ig-gallery-page-body">
        {activeTab === 'gallery' || activeTab === 'favorites' ? (
          items.length === 0 ? (
            <div className="dsh-ig-gallery-empty">
              <div className="dsh-ig-gallery-empty-icon">🖼️</div>
              <div className="dsh-ig-gallery-empty-title">{t('emptyTitle')}</div>
              <div className="dsh-ig-gallery-empty-desc">{t('emptyDesc')}</div>
            </div>
          ) : activeTab === 'favorites' && filteredItems.length === 0 && search === '' && selectedProvider === 'all' && selectedRatio === 'all' ? (
            <div className="dsh-ig-gallery-empty">
              <div className="dsh-ig-gallery-empty-icon">🤍</div>
              <div className="dsh-ig-gallery-empty-title">{t('favEmptyTitle')}</div>
              <div className="dsh-ig-gallery-empty-desc">{t('favEmptyDesc')}</div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="dsh-ig-gallery-empty">
              <div className="dsh-ig-gallery-empty-icon">🔍</div>
              <div className="dsh-ig-gallery-empty-title">{t('noMatchTitle')}</div>
              <div className="dsh-ig-gallery-empty-desc">{t('noMatchDesc')}</div>
            </div>
          ) : (
            <div className="dsh-ig-gallery-grid">
              {filteredItems.map((item, idx) => (
                <GalleryCard
                  key={item.id}
                  item={item}
                  index={idx}
                  isManageMode={isManageMode}
                  isSelected={selectedIds.has(item.id)}
                  t={t}
                  onClick={(e, blob) => handleCardClick(item, idx, e, blob)}
                  onToggleSelect={(e) => handleToggleSelect(item.id, idx, e)}
                  onRequestDelete={() => requestSingleDelete(item)}
                  onPreview={(blob) => openPreviewItem(item, blob)}
                  onBlobLoaded={(b) => blobCache.set(item.id, b)}
                  onToast={showToast}
                />
              ))}
            </div>
          )
        ) : activeTab === 'studio' ? (
          <PlaceholderView
            icon="🎨"
            title={t('studioTitle')}
            description={t('studioDesc')}
            tip={t('studioTip')}
            badge={t('comingSoonBadge')}
          />
        ) : activeTab === 'compare' ? (
          <PlaceholderView
            icon="🔀"
            title={t('compareTitle')}
            description={t('compareDesc')}
            badge={t('comingSoonBadge')}
          />
        ) : (
          <PlaceholderView
            icon="📋"
            title={t('tasksTitle')}
            description={t('tasksDesc')}
            badge={t('comingSoonBadge')}
          />
        )}
      </div>

      {toast && <div className="dsh-ig-gallery-page-toast">{toast}</div>}

      {/* 4. Floating Batch Action Bar */}
      {(isManageMode || selectedIds.size > 0) && (
        <div className="dsh-ig-batch-bar">
          <div className="dsh-ig-batch-bar-left">
            <span className="dsh-ig-batch-counter">
              {t('selectedCount', { n: String(selectedIds.size) })}
            </span>
            <button
              type="button"
              className="dsh-ig-batch-btn"
              onClick={handleSelectAll}
            >
              {t('selectAll')}
            </button>
            <button
              type="button"
              className="dsh-ig-batch-btn"
              onClick={handleInvertSelect}
            >
              {t('invertSelect')}
            </button>
            {selectedIds.size > 0 && (
              <button
                type="button"
                className="dsh-ig-batch-btn"
                onClick={handleClearSelect}
              >
                {t('clearSelect')}
              </button>
            )}
          </div>

          <div className="dsh-ig-batch-bar-right">
            <button
              type="button"
              className="dsh-ig-batch-btn dsh-ig-batch-btn-danger"
              disabled={selectedIds.size === 0}
              onClick={() => setShowDeleteModal(true)}
            >
              <Trash2 size={13} />
              <span>{t('batchDelete')}{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}</span>
            </button>

            <button
              type="button"
              className="dsh-ig-batch-btn dsh-ig-batch-btn-exit"
              onClick={handleExitManage}
            >
              {t('exitManage')}
            </button>
          </div>
        </div>
      )}

      {/* 5. Delete Confirmation Modal (Unified for single & batch) */}
      {showDeleteModal && (
        <div
          className="dsh-ig-modal-backdrop"
          onClick={() => {
            if (!isDeleting) {
              setShowDeleteModal(false)
              if (!isManageMode) setSelectedIds(new Set())
            }
          }}
        >
          <div className="dsh-ig-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="dsh-ig-modal-header">
              <div className="dsh-ig-modal-icon-danger">
                <AlertTriangle size={20} />
              </div>
              <div className="dsh-ig-modal-title">
                {selectedIds.size === 1
                  ? t('batchDeleteTitleSingle')
                  : t('batchDeleteTitle', { count: String(selectedIds.size) })}
              </div>
            </div>

            <div className="dsh-ig-modal-body">
              <p className="dsh-ig-modal-desc">
                {t('batchDeleteDesc')}
              </p>

              <label className="dsh-ig-modal-checkbox-label">
                <input
                  type="checkbox"
                  checked={deleteWorkspaceFiles}
                  onChange={(e) => setDeleteWorkspaceFiles(e.target.checked)}
                  disabled={isDeleting}
                />
                <span>{t('deleteWorkspaceFilesOpt')}</span>
              </label>
            </div>

            <div className="dsh-ig-modal-footer">
              <button
                type="button"
                className="dsh-ig-modal-btn dsh-ig-modal-btn-cancel"
                onClick={() => {
                  setShowDeleteModal(false)
                  if (!isManageMode) setSelectedIds(new Set())
                }}
                disabled={isDeleting}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="dsh-ig-modal-btn dsh-ig-modal-btn-danger"
                onClick={handleConfirmBatchDelete}
                disabled={isDeleting}
              >
                {isDeleting
                  ? '...'
                  : selectedIds.size === 1
                  ? t('confirmDeleteSingle')
                  : t('confirmBatchDelete', { count: String(selectedIds.size) })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Lightbox Preview Modal */}
      {previewItem && (
        <div
          className="dsh-ig-lightbox-backdrop"
          onClick={handleClosePreview}
        >
          {/* Top Bar: Info, Index Counter & Close */}
          <div
            className="dsh-ig-lightbox-topbar"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dsh-ig-lightbox-meta">
              <span className="dsh-ig-tag">{previewItem.provider}</span>
              {previewItem.model ? (
                <span className="dsh-ig-tag dsh-ig-tag-model">{previewItem.model}</span>
              ) : null}
              {currentPreviewIndex >= 0 && (
                <span className="dsh-ig-lightbox-counter">
                  {currentPreviewIndex + 1} / {filteredItems.length}
                </span>
              )}
            </div>
            <button
              type="button"
              className="dsh-ig-lightbox-close-btn"
              title={t('close')}
              onClick={handleClosePreview}
            >
              <X size={18} />
            </button>
          </div>

          {/* Floating Prev Button (Left) */}
          <button
            type="button"
            className="dsh-ig-lightbox-nav-btn dsh-ig-lightbox-nav-prev"
            title={t('prevImage')}
            disabled={!hasPrev}
            onClick={(e) => {
              e.stopPropagation()
              goToPrev()
            }}
          >
            <ChevronLeft size={24} />
          </button>

          {/* Floating Next Button (Right) */}
          <button
            type="button"
            className="dsh-ig-lightbox-nav-btn dsh-ig-lightbox-nav-next"
            title={t('nextImage')}
            disabled={!hasNext}
            onClick={(e) => {
              e.stopPropagation()
              goToNext()
            }}
          >
            <ChevronRight size={24} />
          </button>

          {/* Centered Image / Loading state */}
          <div className="dsh-ig-lightbox-img-wrap" onClick={(e) => e.stopPropagation()}>
            {previewLoading ? (
              <div className="dsh-ig-lightbox-loading">
                <div className="dsh-ig-lightbox-spinner" />
              </div>
            ) : previewUrl ? (
              <img
                className="dsh-ig-lightbox-img"
                src={previewUrl}
                alt={previewItem.prompt}
              />
            ) : null}
          </div>

          {/* Bottom Floating Pill Bar: Prompt & Actions */}
          <div
            className="dsh-ig-lightbox-bottombar"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dsh-ig-lightbox-prompt-text" title={previewItem.prompt}>
              {previewItem.prompt}
            </div>
            <div className="dsh-ig-lightbox-actions">
              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={t('copyPpt')}
                onClick={async () => {
                  await navigator.clipboard.writeText(previewItem.prompt)
                  showToast(t('copiedPrompt'))
                }}
              >
                <FileText size={14} />
                <span>{t('copyPpt')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={t('copyImg')}
                onClick={async () => {
                  if (!previewBlob) return
                  const ok = await copyImageBlob(previewBlob)
                  showToast(ok ? t('copiedImage') : t('copyFailed'))
                }}
              >
                <Copy size={14} />
                <span>{t('copyImg')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={t('download')}
                onClick={() => {
                  if (!previewUrl) return
                  const a = document.createElement('a')
                  a.href = previewUrl
                  a.download = `dsh-${previewItem.provider}-${previewItem.id}.png`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                }}
              >
                <Download size={14} />
                <span>{t('download')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn dsh-ig-lightbox-btn-danger"
                title={t('delete')}
                onClick={() => {
                  if (previewItem) {
                    requestSingleDelete(previewItem)
                  }
                }}
              >
                <Trash2 size={14} />
                <span>{t('delete')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface GalleryCardProps {
  item: GalleryItem
  index: number
  isManageMode: boolean
  isSelected: boolean
  t: (key: DictKey, params?: Record<string, string>) => string
  onClick: (e: MouseEvent, blob?: Blob) => void
  onToggleSelect: (e: MouseEvent) => void
  onRequestDelete: () => void
  onPreview: (blob: Blob) => void
  onBlobLoaded?: (blob: Blob) => void
  onToast: (msg: string) => void
}

const GalleryCard: FC<GalleryCardProps> = ({
  item,
  index: _index,
  isManageMode,
  isSelected,
  t,
  onClick,
  onToggleSelect,
  onRequestDelete,
  onPreview: _onPreview,
  onBlobLoaded,
  onToast,
}) => {
  const [url, setUrl] = useState<string>()
  const [blob, setBlob] = useState<Blob>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined

    void fetch(IMAGE_ROUTE, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachment: item.attachment }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const resBlob = await response.blob()
        if (controller.signal.aborted) return
        setBlob(resBlob)
        onBlobLoaded?.(resBlob)
        objectUrl = URL.createObjectURL(resBlob)
        setUrl(objectUrl)
        setLoading(false)
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [item.attachment])

  const copyPrompt = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(item.prompt)
      onToast(t('copiedPrompt'))
    } catch {
      onToast(t('copyFailed'))
    }
  }

  const copyImage = async (e: MouseEvent) => {
    e.stopPropagation()
    if (!blob) return
    const ok = await copyImageBlob(blob)
    onToast(ok ? t('copiedImage') : t('copyFailed'))
  }

  const downloadImage = (e: MouseEvent) => {
    e.stopPropagation()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `dsh-${item.provider}-${item.id}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const toggleFavorite = async (e: MouseEvent) => {
    e.stopPropagation()
    const nextStatus = await toggleFavoriteGalleryItem(item.id)
    onToast(nextStatus ? t('favoriteAdded') : t('favoriteRemoved'))
  }

  // Label for top badge: show model or fallback to provider
  const badgeLabel = item.model || item.provider

  return (
    <div
      className={`dsh-ig-gallery-card ${isSelected ? 'is-selected' : ''} ${isManageMode ? 'is-manage-mode' : ''}`}
      onClick={(e) => onClick(e, blob)}
    >
      {/* Upper media container */}
      <div className="dsh-ig-gallery-card-media">
        {/* Selection Checkbox (Top Left) */}
        <button
          type="button"
          className={`dsh-ig-card-checkbox ${isSelected ? 'is-checked' : ''}`}
          title={isSelected ? t('clearSelect') : t('manage')}
          onClick={onToggleSelect}
        >
          {isSelected && <Check size={11} strokeWidth={3} />}
        </button>

        {loading && <div className="dsh-ig-gallery-card-loading">...</div>}
        {error && <div className="dsh-ig-gallery-card-error">⚠️ {error}</div>}
        {url && (
          <img
            className="dsh-ig-gallery-card-img"
            src={url}
            alt={item.prompt}
            loading="lazy"
          />
        )}

        {/* Hover quick action toolbar */}
        <div className="dsh-ig-card-toolbar">
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('copyImg')}
            onClick={(e) => {
              void copyImage(e)
            }}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('download')}
            onClick={downloadImage}
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('copyPpt')}
            onClick={(e) => {
              void copyPrompt(e)
            }}
          >
            <FileText size={13} />
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn dsh-ig-tool-btn-danger"
            title={t('delete')}
            onClick={(e) => {
              e.stopPropagation()
              onRequestDelete()
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Lower metadata container aligned with mockup */}
      <div className="dsh-ig-gallery-card-meta">
        {/* Top badge */}
        <div className="dsh-ig-card-badge-row">
          <span className="dsh-ig-card-badge" title={badgeLabel}>
            {badgeLabel}
          </span>
        </div>

        {/* Prompt single-line title */}
        <div className="dsh-ig-gallery-card-prompt-line" title={item.prompt}>
          {item.prompt}
        </div>

        {/* Bottom meta row: dimension/ratio + relative time + heart favorite */}
        <div className="dsh-ig-card-footer-row">
          <span className="dsh-ig-card-meta-text">
            {formatCardMeta(item)} | {formatRelativeTime(item.createdAt, t)}
          </span>

          <button
            type="button"
            className={`dsh-ig-card-fav-btn ${item.isFavorite ? 'is-favorited' : ''}`}
            title={item.isFavorite ? t('favoriteRemoved') : t('favoriteAdded')}
            onClick={(e) => {
              void toggleFavorite(e)
            }}
          >
            <Heart
              size={15}
              fill={item.isFavorite ? 'currentColor' : 'none'}
            />
          </button>
        </div>
      </div>
    </div>
  )
}

interface PlaceholderViewProps {
  icon: string
  title: string
  description: string
  tip?: string
  badge?: string
}

const PlaceholderView: FC<PlaceholderViewProps> = ({
  icon,
  title,
  description,
  tip,
  badge,
}) => {
  return (
    <div className="dsh-ig-placeholder-view">
      <div className="dsh-ig-placeholder-card">
        <div className="dsh-ig-placeholder-icon">{icon}</div>
        <div className="dsh-ig-placeholder-header">
          <h2 className="dsh-ig-placeholder-title">{title}</h2>
          {badge && <span className="dsh-ig-placeholder-badge">{badge}</span>}
        </div>
        <p className="dsh-ig-placeholder-desc">{description}</p>
        {tip && <div className="dsh-ig-placeholder-tip">{tip}</div>}
      </div>
    </div>
  )
}

export async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    if (blob.type === 'image/png') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    }
    const img = new Image()
    const url = URL.createObjectURL(blob)
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    const pngBlob = await new Promise<Blob | null>((res) => {
      canvas.toBlob(res, 'image/png')
    })
    if (!pngBlob) throw new Error('Blob conversion failed')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
    return true
  } catch (_err) {
    return false
  }
}
