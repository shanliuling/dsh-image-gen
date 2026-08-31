/**
 * Native Workspace Gallery View Component for DSH `conversation.view` slot.
 * Fully i18n-reactive (Chinese & English).
 */
import { useEffect, useState, useMemo, type FC, type MouseEvent } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IMAGE_ROUTE, type ImageProvider } from '../shared.js'
import {
  getGalleryItems,
  subscribeGallery,
  deleteGalleryItem,
  type GalleryItem,
} from './gallery-store.js'

export interface LocaleService {
  getSnapshot(): { active: string }
  subscribe(fn: () => void): () => void
}

const DICT = {
  zh: {
    totalCount: '共 {count} 张生成图片',
    searchPlaceholder: '搜索 Prompt 关键词…',
    filterAll: '全部厂商',
    filterGoogle: 'Google Gemini',
    filterOpenAI: 'OpenAI / 中转站',
    filterSeedream: '字节 Seedream',
    filterDashScope: '阿里 DashScope',
    filterComfyUI: '本地 ComfyUI',
    emptyTitle: '暂无生图记录',
    emptyDesc: '在对话中让 Agent 生图后，生成的图片会自动收录到这里。',
    noMatchTitle: '未找到匹配结果',
    noMatchDesc: '尝试更换搜索关键词或选择其他厂商。',
    copiedPrompt: '已复制 Prompt',
    copiedImage: '已复制图片',
    copyFailed: '复制失败',
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
  },
  en: {
    totalCount: '{count} images total',
    searchPlaceholder: 'Search prompt keywords…',
    filterAll: 'All Providers',
    filterGoogle: 'Google Gemini',
    filterOpenAI: 'OpenAI / Relay',
    filterSeedream: 'ByteDance Seedream',
    filterDashScope: 'Aliyun DashScope',
    filterComfyUI: 'Local ComfyUI',
    emptyTitle: 'No images generated yet',
    emptyDesc: 'Images generated during conversations will automatically appear here.',
    noMatchTitle: 'No matching images',
    noMatchDesc: 'Try a different search keyword or provider filter.',
    copiedPrompt: 'Prompt copied',
    copiedImage: 'Image copied',
    copyFailed: 'Copy failed',
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
  },
} as const

export type DictKey = keyof typeof DICT.zh

export const GalleryViewTab: FC<{ locale?: LocaleService }> = ({ locale }) => {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [search, setSearch] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('all')
  const [previewItem, setPreviewItem] = useState<GalleryItem | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [toast, setToast] = useState<string | null>(null)
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

  // Hide chat input composer while browsing gallery
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

  useEffect(() => {
    if (!previewItem) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPreviewItem(null)
        setPreviewUrl(null)
        setPreviewBlob(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewItem])

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (selectedProvider !== 'all' && item.provider !== selectedProvider) return false
      if (search.trim().length > 0) {
        const q = search.trim().toLowerCase()
        const matchPrompt = item.prompt?.toLowerCase().includes(q)
        const matchModel = item.model?.toLowerCase().includes(q)
        if (!matchPrompt && !matchModel) return false
      }
      return true
    })
  }, [items, search, selectedProvider])

  return (
    <div className="dsh-ig-gallery-page">
      {/* Top Toolbar */}
      <header className="dsh-ig-gallery-page-header">
        <div className="dsh-ig-gallery-page-title-row">
          <span className="dsh-ig-gallery-page-count">
            {t('totalCount', { count: String(items.length) })}
          </span>
        </div>
        <div className="dsh-ig-gallery-page-tools">
          <div className="dsh-ig-gallery-search-wrap">
            <svg
              className="dsh-ig-gallery-search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="dsh-ig-gallery-search-input"
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="dsh-ig-gallery-select"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
          >
            <option value="all">{t('filterAll')}</option>
            <option value="google">{t('filterGoogle')}</option>
            <option value="openai">{t('filterOpenAI')}</option>
            <option value="seedream">{t('filterSeedream')}</option>
            <option value="dashscope">{t('filterDashScope')}</option>
            <option value="comfyui">{t('filterComfyUI')}</option>
          </select>
        </div>
      </header>

      {/* Grid Content */}
      <div className="dsh-ig-gallery-page-body">
        {items.length === 0 ? (
          <div className="dsh-ig-gallery-empty">
            <div className="dsh-ig-gallery-empty-icon">🖼️</div>
            <div className="dsh-ig-gallery-empty-title">{t('emptyTitle')}</div>
            <div className="dsh-ig-gallery-empty-desc">{t('emptyDesc')}</div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="dsh-ig-gallery-empty">
            <div className="dsh-ig-gallery-empty-icon">🔍</div>
            <div className="dsh-ig-gallery-empty-title">{t('noMatchTitle')}</div>
            <div className="dsh-ig-gallery-empty-desc">{t('noMatchDesc')}</div>
          </div>
        ) : (
          <div className="dsh-ig-gallery-grid">
            {filteredItems.map((item) => (
              <GalleryCard
                key={item.id}
                item={item}
                t={t}
                onPreview={(url, blob) => {
                  setPreviewItem(item)
                  setPreviewUrl(url)
                  setPreviewBlob(blob)
                }}
                onToast={showToast}
              />
            ))}
          </div>
        )}
      </div>

      {toast && <div className="dsh-ig-gallery-page-toast">{toast}</div>}

      {/* Pure Centered Lightbox Preview */}
      {previewItem && previewUrl && (
        <div
          className="dsh-ig-lightbox-backdrop"
          onClick={() => {
            setPreviewItem(null)
            setPreviewUrl(null)
            setPreviewBlob(null)
          }}
        >
          {/* Top Bar: Info & Close */}
          <div
            className="dsh-ig-lightbox-topbar"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dsh-ig-lightbox-meta">
              <span className="dsh-ig-tag">{previewItem.provider}</span>
              {previewItem.model ? (
                <span className="dsh-ig-tag dsh-ig-tag-model">{previewItem.model}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="dsh-ig-lightbox-close-btn"
              title={t('close')}
              onClick={() => {
                setPreviewItem(null)
                setPreviewUrl(null)
                setPreviewBlob(null)
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          {/* Centered Image */}
          <div className="dsh-ig-lightbox-img-wrap" onClick={(e) => e.stopPropagation()}>
            <img
              className="dsh-ig-lightbox-img"
              src={previewUrl}
              alt={previewItem.prompt}
            />
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>{t('copyImg')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn"
                title={t('download')}
                onClick={() => {
                  const a = document.createElement('a')
                  a.href = previewUrl
                  a.download = `dsh-${previewItem.provider}-${previewItem.id}.png`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>{t('download')}</span>
              </button>

              <button
                type="button"
                className="dsh-ig-lightbox-btn dsh-ig-lightbox-btn-danger"
                title={t('delete')}
                onClick={async () => {
                  if (!window.confirm(t('confirmDelete'))) return
                  await deleteGalleryItem(previewItem.id)
                  setPreviewItem(null)
                  setPreviewUrl(null)
                  setPreviewBlob(null)
                  showToast(t('deleted'))
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
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
  t: (key: DictKey, params?: Record<string, string>) => string
  onPreview: (url: string, blob: Blob) => void
  onToast: (msg: string) => void
}

const GalleryCard: FC<GalleryCardProps> = ({ item, t, onPreview, onToast }) => {
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

  return (
    <div
      className="dsh-ig-gallery-card"
      onClick={() => {
        if (url && blob) onPreview(url, blob)
      }}
    >
      <div className="dsh-ig-gallery-card-media">
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

        {/* Floating Toolbar: 3 Essential High-Value Actions (Top-Left Pill) */}
        <div className="dsh-ig-card-toolbar">
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('copyImg')}
            onClick={(e) => {
              void copyImage(e)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('download')}
            onClick={downloadImage}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn"
            title={t('copyPpt')}
            onClick={(e) => {
              void copyPrompt(e)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
          </button>
          <button
            type="button"
            className="dsh-ig-tool-btn dsh-ig-tool-btn-danger"
            title={t('delete')}
            onClick={async (e) => {
              e.stopPropagation()
              if (!window.confirm(t('confirmDelete'))) return
              await deleteGalleryItem(item.id)
              onToast(t('deleted'))
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </div>

      <div className="dsh-ig-gallery-card-meta">
        <div className="dsh-ig-gallery-card-header">
          <span className="dsh-ig-tag">{item.provider}</span>
          {item.model ? (
            <span className="dsh-ig-tag dsh-ig-tag-model">{item.model}</span>
          ) : null}
        </div>
        <p className="dsh-ig-gallery-card-prompt" title={item.prompt}>
          {item.prompt}
        </p>
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
