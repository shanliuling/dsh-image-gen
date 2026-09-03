import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import { Check, Clipboard, ExternalLink, ImageIcon, LoaderCircle, Maximize2, Search, Sparkles, Star, X } from 'lucide-react'
import { INSPIRATION_ROUTE } from '../shared.js'
import type { InspirationCase, InspirationCatalog, InspirationSource } from '../inspiration.js'
import { fetchInspirationImage } from './inspiration-image-cache.js'
import { loadCachedInspirationCatalog, saveCachedInspirationCatalog } from './inspiration-catalog-cache.js'
import type { LocaleService } from './gallery-view.js'

type Language = 'zh' | 'en'

const FAVORITES_STORAGE_KEY = 'dsh-ig-inspiration-favorites'

function loadInspirationFavorites(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return new Set(parsed)
    }
  } catch {}
  return new Set()
}

function saveInspirationFavorites(favorites: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favorites)))
  } catch {}
}

const TAG_MAP_ZH: Record<string, string> = {
  // ── 全部分类 (Categories) ──────────────────────────
  'Architecture & Spaces': '建筑空间',
  'Brand & Logos': '品牌 Logo',
  'Characters & People': '角色人物',
  'Charts & Infographics': '图表信息图',
  'Documents & Publishing': '文档出版',
  'History & Classical Themes': '历史古典',
  'Illustration & Art': '插画艺术',
  'Other Use Cases': '其他案例',
  'Photography & Realism': '摄影写真',
  'Posters & Typography': '海报排版',
  'Products & E-commerce': '产品电商',
  'Scenes & Storytelling': '场景故事',
  'UI & Interfaces': 'UI 界面',

  // ── 全部风格 (Styles) ──────────────────────────────
  '3D': '3D 渲染',
  'Architecture': '建筑空间',
  'Brand': '品牌视觉',
  'Character': '角色人物',
  'Characters': '人物群像',
  'Charts': '图表图解',
  'Classical': '古典艺术',
  'Documents': '文档出版',
  'History': '历史人文',
  'Illustration': '插画手绘',
  'Infographic': '信息图表',
  'Photography': '摄影写真',
  'Poster': '海报封面',
  'Product': '产品设计',
  'Products': '商业产品',
  'Realistic': '写实逼真',
  'Scenes': '场景概念',
  'UI': 'UI 界面',

  // ── 全部场景 (Scenes) ──────────────────────────────
  'Commerce': '商业电商',
  'Creative': '创意设计',
  'Education': '教育科普',
  'Fashion': '时尚潮流',
  'Food': '美食餐饮',
  'Social': '社媒传播',
  'Story': '故事剧情',
  'Tech': '科技未来',
  'Travel': '旅游出行',

  // ── 兼顾其他常见标签与测试用例 ────────────────────────
  'Art': '艺术创作',
  'Minimalist': '极简主义',
  'Vintage': '复古胶片',
  'Cyberpunk': '赛博朋克',
  'Anime': '二次元日系',
  'Watercolor': '水彩手绘',
  'Oil Painting': '油画质感',
}

function translateTag(name: string, lang: Language): string {
  if (lang !== 'zh') return name
  return TAG_MAP_ZH[name] ?? name
}

const COPY = {
  zh: {
    kicker: 'Prompt inspiration', title: '灵感素材', subtitle: '从公开案例中找构图、质感和文字处理，再带回工作台继续调整。',
    refresh: '检查更新', refreshing: '正在更新…', allCategories: '全部分类', allStyles: '全部风格', allScenes: '全部场景',
    search: '搜索案例、Prompt、风格…', results: '找到 {count} 个案例', noResults: '没有匹配的素材，换个关键词或筛选条件试试。',
    selectHint: '选择一张素材，查看完整 Prompt 并带回工作台。', prompt: '完整 Prompt', copy: '复制 Prompt', copied: '已复制', use: '使用这个 Prompt', source: '查看原来源',
    loading: '正在读取素材库…', loadFailed: '素材库读取失败，请稍后重试。', imageFailed: '图片暂时无法读取', featured: '精选', updated: '素材已更新（{count} 条）', updateFailed: '更新失败，仍在使用当前内置素材。',
    allLoaded: '已展示全部 {count} 个案例', onlyFavorites: '仅看收藏', noFavorites: '暂无收藏的灵感案例，浏览时点击星标即可收藏。',
    favorite: '收藏', favorited: '已收藏', zoomHint: '点击放大查看', close: '关闭',
  },
  en: {
    kicker: 'Prompt inspiration', title: 'Inspiration', subtitle: 'Explore public examples, then bring a prompt back to Studio to make it your own.',
    refresh: 'Check updates', refreshing: 'Updating…', allCategories: 'All categories', allStyles: 'All styles', allScenes: 'All scenes',
    search: 'Search examples, prompts, styles…', results: '{count} examples', noResults: 'No matching examples. Try another keyword or filter.',
    selectHint: 'Choose an example to read its full prompt and use it in Studio.', prompt: 'Full prompt', copy: 'Copy prompt', copied: 'Copied', use: 'Use this prompt', source: 'View source',
    loading: 'Loading inspiration…', loadFailed: 'Could not load the inspiration library.', imageFailed: 'Image is temporarily unavailable', featured: 'Featured', updated: 'Updated ({count} examples)', updateFailed: 'Update failed. The current bundled library is still available.',
    allLoaded: 'All {count} examples displayed', onlyFavorites: 'Favorites only', noFavorites: 'No favorited examples yet. Click the star icon on any card to save.',
    favorite: 'Favorite', favorited: 'Favorited', zoomHint: 'Click to zoom in', close: 'Close',
  },
} as const

type CopyKey = keyof typeof COPY.zh

export const InspirationView: FC<{ locale?: LocaleService | undefined; onUsePrompt(prompt: string): void }> = ({ locale, onUsePrompt }) => {
  const [language, setLanguage] = useState<Language>(() => locale?.getSnapshot?.().active?.startsWith('en') ? 'en' : 'zh')
  const [catalog, setCatalog] = useState<InspirationCatalog | null>(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [style, setStyle] = useState('')
  const [scene, setScene] = useState('')
  const [visibleLimit, setVisibleLimit] = useState(60)
  const [selected, setSelected] = useState<InspirationCase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [favorites, setFavorites] = useState<Set<string>>(() => loadInspirationFavorites())
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const [lightboxCase, setLightboxCase] = useState<{ sourceId: string; caseId: string; title: string; alt: string } | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!locale?.subscribe) return
    return locale.subscribe(() => setLanguage(locale.getSnapshot?.().active?.startsWith('en') ? 'en' : 'zh'))
  }, [locale])

  const t = (key: CopyKey, values?: Record<string, string>) => {
    let value: string = COPY[language][key] ?? COPY.zh[key]
    for (const [name, replacement] of Object.entries(values ?? {})) value = value.replace(`{${name}}`, replacement)
    return value
  }

  const toggleFavorite = (id: string) => {
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveInspirationFavorites(next)
      return next
    })
  }

  const loadCatalog = async (method: 'GET' | 'POST' = 'GET') => {
    const response = await fetch(`${INSPIRATION_ROUTE}/${method === 'GET' ? 'catalog' : 'refresh'}`, {
      method,
      credentials: 'same-origin',
    })
    const payload = (await response.json().catch(() => null)) as InspirationCatalog | { error?: string } | null
    if (!response.ok || payload === null || !('schemaVersion' in payload) || payload.schemaVersion !== 1) {
      throw new Error(payload && 'error' in payload && payload.error ? payload.error : t('loadFailed'))
    }
    return payload
  }

  useEffect(() => {
    let mounted = true
    void Promise.allSettled([loadCatalog(), loadCachedInspirationCatalog()]).then(([server, cache]) => {
      if (!mounted) return
      const cached = cache.status === 'fulfilled' ? cache.value : undefined
      const bundled = server.status === 'fulfilled' ? server.value : undefined
      const next = resolveActiveCatalog(bundled, cached)
      if (next === undefined) {
        setError(t('loadFailed'))
        return
      }
      setCatalog(next)
      setSelected(previous => previous === null ? next.sources[0]?.cases.find(item => item.featured) ?? next.sources[0]?.cases[0] ?? null : previous)
    })
    return () => { mounted = false }
  }, [])

  const source = catalog?.sources[0] ?? null
  const matchingCases = useMemo(() => {
    if (source === null) return []
    const query = search.trim().toLowerCase()
    return source.cases.filter(item => {
      if (onlyFavorites && !favorites.has(item.id)) return false
      if (category && item.category !== category) return false
      if (style && !item.styles.includes(style)) return false
      if (scene && !item.scenes.includes(scene)) return false
      if (!query) return true
      const translatedCat = translateTag(item.category, language)
      const translatedStyles = item.styles.map(s => translateTag(s, language))
      const translatedScenes = item.scenes.map(s => translateTag(s, language))
      return [item.title, item.prompt, item.category, translatedCat, ...item.styles, ...translatedStyles, ...item.scenes, ...translatedScenes].some(value => value.toLowerCase().includes(query))
    })
  }, [source, search, category, style, scene, onlyFavorites, favorites, language])

  useEffect(() => setVisibleLimit(60), [search, category, style, scene, onlyFavorites])
  const visibleCases = matchingCases.slice(0, visibleLimit)

  // 现代感应式无限滚动：滑近底部时自动追加批次
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setVisibleLimit(limit => Math.min(limit + 48, matchingCases.length))
        }
      },
      { rootMargin: '360px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [matchingCases.length, visibleCases.length])

  // ESC 关闭大图预览
  useEffect(() => {
    if (lightboxCase === null) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxCase(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightboxCase])

  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    setError(null)
    try {
      const next = await loadCatalog('POST')
      setCatalog(next)
      void saveCachedInspirationCatalog(next)
      setSelected(previous => previous === null ? next.sources[0]?.cases[0] ?? null : next.sources[0]?.cases.find(item => item.id === previous.id) ?? next.sources[0]?.cases[0] ?? null)
      setError(t('updated', { count: String(next.sources[0]?.cases.length ?? 0) }))
    } catch {
      setError(t('updateFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  const copyPrompt = async () => {
    if (selected === null) return
    try {
      await copyText(selected.prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_800)
    } catch {
      setError(t('loadFailed'))
    }
  }

  return <section className="dsh-ig-inspiration" aria-label={t('title')}>
    <header className="dsh-ig-inspiration-head">
      <div><p className="dsh-ig-inspiration-kicker">{t('kicker')}</p><h1>{t('title')}</h1><p className="dsh-ig-inspiration-subtitle">{t('subtitle')}</p></div>
      <button type="button" className="dsh-ig-inspiration-refresh" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <LoaderCircle className="dsh-ig-spin" size={14} /> : <Sparkles size={14} />}{refreshing ? t('refreshing') : t('refresh')}</button>
    </header>
    {error !== null && <p className="dsh-ig-inspiration-error" role="status">{error}</p>}
    {source === null ? <div className="dsh-ig-inspiration-empty"><LoaderCircle className="dsh-ig-spin" size={23} /><span>{t('loading')}</span></div> : <>
      <div className="dsh-ig-inspiration-toolbar">
        <label className="dsh-ig-inspiration-search"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('search')} /></label>
        <button
          type="button"
          className={`dsh-ig-inspiration-fav-filter ${onlyFavorites ? 'is-active' : ''}`}
          onClick={() => setOnlyFavorites(prev => !prev)}
          title={t('onlyFavorites')}
        >
          <Star size={14} className={onlyFavorites ? 'fill-star' : ''} />
          <span>{t('onlyFavorites')}{favorites.size > 0 ? ` (${favorites.size})` : ''}</span>
        </button>
        <select value={category} onChange={event => setCategory(event.target.value)} aria-label={t('allCategories')}>
          <option value="">{t('allCategories')}</option>
          {source.categories.map(item => <option key={item} value={item}>{translateTag(item, language)}</option>)}
        </select>
        <select value={style} onChange={event => setStyle(event.target.value)} aria-label={t('allStyles')}>
          <option value="">{t('allStyles')}</option>
          {source.styles.map(item => <option key={item} value={item}>{translateTag(item, language)}</option>)}
        </select>
        <select value={scene} onChange={event => setScene(event.target.value)} aria-label={t('allScenes')}>
          <option value="">{t('allScenes')}</option>
          {source.scenes.map(item => <option key={item} value={item}>{translateTag(item, language)}</option>)}
        </select>
      </div>
      <div className="dsh-ig-inspiration-layout">
        <div>
          <div className="dsh-ig-inspiration-summary">
            <strong>{t('results', { count: String(matchingCases.length) })}</strong>
            <span>{source.version.slice(0, 8)}</span>
          </div>
          {matchingCases.length === 0 ? (
            <div className="dsh-ig-inspiration-empty">{onlyFavorites ? t('noFavorites') : t('noResults')}</div>
          ) : (
            <>
              <div className="dsh-ig-inspiration-grid">
                {visibleCases.map(item => (
                  <InspirationCard
                    key={item.id}
                    item={item}
                    sourceId={source.id}
                    selected={selected?.id === item.id}
                    isFavorited={favorites.has(item.id)}
                    language={language}
                    featuredLabel={t('featured')}
                    onSelect={() => { setSelected(item); setCopied(false) }}
                    onToggleFavorite={() => toggleFavorite(item.id)}
                  />
                ))}
              </div>
              {visibleCases.length < matchingCases.length ? (
                <div ref={sentinelRef} style={{ height: 32, margin: '16px 0' }} />
              ) : (
                <div className="dsh-ig-inspiration-end-hint">{t('allLoaded', { count: String(matchingCases.length) })}</div>
              )}
            </>
          )}
        </div>
        <aside className="dsh-ig-inspiration-inspector">
          {selected === null ? (
            <div className="dsh-ig-inspiration-inspector-empty"><ImageIcon size={28} /><span>{t('selectHint')}</span></div>
          ) : (
            <>
              <div
                className="dsh-ig-inspiration-inspector-image"
                onClick={() => setLightboxCase({ sourceId: source.id, caseId: selected.id, title: selected.title, alt: selected.imageAlt })}
                title={t('zoomHint')}
              >
                <InspirationImage sourceId={source.id} caseId={selected.id} alt={selected.imageAlt} />
                <span className="dsh-ig-inspiration-inspector-zoom-hint">
                  <Maximize2 size={11} />
                  {t('zoomHint')}
                </span>
              </div>
              <div className="dsh-ig-inspiration-inspector-body">
                <div className="dsh-ig-inspiration-inspector-head">
                  <h2>{selected.title}</h2>
                  <button
                    type="button"
                    className={`dsh-ig-inspiration-inspector-fav ${favorites.has(selected.id) ? 'is-favorited' : ''}`}
                    onClick={() => toggleFavorite(selected.id)}
                    title={favorites.has(selected.id) ? t('favorited') : t('favorite')}
                  >
                    <Star size={15} className={favorites.has(selected.id) ? 'fill-star' : ''} />
                  </button>
                </div>
                {selected.sourceLabel && <p className="dsh-ig-inspiration-origin">{selected.sourceLabel}</p>}
                <div className="dsh-ig-inspiration-tags">
                  <span>{translateTag(selected.category, language)}</span>
                  {selected.styles.slice(0, 3).map(item => <span key={item}>{translateTag(item, language)}</span>)}
                </div>
                <div className="dsh-ig-inspiration-prompt-label"><span>{t('prompt')}</span><span>{selected.prompt.length}</span></div>
                <p className="dsh-ig-inspiration-prompt">{selected.prompt}</p>
                <div className="dsh-ig-inspiration-actions">
                  <button type="button" onClick={() => void copyPrompt()}>{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? t('copied') : t('copy')}</button>
                  {selected.sourceUrl ?? selected.githubUrl ? <a className="dsh-ig-inspiration-source-link" href={selected.sourceUrl ?? selected.githubUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t('source')}</a> : <span /> }
                  <button type="button" className="dsh-ig-inspiration-use" onClick={() => onUsePrompt(selected.prompt)}><Sparkles size={14} />{t('use')}</button>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </>}

    {/* 大图弹窗全屏查看 (Lightbox Modal) */}
    {lightboxCase !== null && (
      <div className="dsh-ig-inspiration-lightbox" onClick={() => setLightboxCase(null)}>
        <div className="dsh-ig-inspiration-lightbox-content" onClick={e => e.stopPropagation()}>
          <button type="button" className="dsh-ig-inspiration-lightbox-close" onClick={() => setLightboxCase(null)} aria-label={t('close')}>
            <X size={18} />
          </button>
          <div className="dsh-ig-inspiration-lightbox-img-wrap">
            <InspirationImage sourceId={lightboxCase.sourceId} caseId={lightboxCase.caseId} alt={lightboxCase.alt} />
          </div>
          <div className="dsh-ig-inspiration-lightbox-caption">{lightboxCase.title}</div>
        </div>
      </div>
    )}
  </section>
}

const InspirationCard: FC<{
  item: InspirationCase
  sourceId: string
  selected: boolean
  isFavorited: boolean
  language: Language
  featuredLabel: string
  onSelect(): void
  onToggleFavorite(): void
}> = ({ item, sourceId, selected, isFavorited, language, featuredLabel, onSelect, onToggleFavorite }) => (
  <button type="button" className={`dsh-ig-inspiration-card ${selected ? 'is-selected' : ''}`} onClick={onSelect}>
    <div className="dsh-ig-inspiration-visual">
      {item.featured && <span className="dsh-ig-inspiration-featured"><Sparkles size={10} />{featuredLabel}</span>}
      <button
        type="button"
        className={`dsh-ig-inspiration-card-star ${isFavorited ? 'is-favorited' : ''}`}
        onClick={e => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        aria-label="收藏"
      >
        <Star size={13} className={isFavorited ? 'fill-star' : ''} />
      </button>
      <InspirationImage sourceId={sourceId} caseId={item.id} alt={item.imageAlt} />
    </div>
    <div className="dsh-ig-inspiration-card-copy">
      <strong>{item.title}</strong>
      <span>{translateTag(item.category, language)}</span>
    </div>
  </button>
)

const InspirationImage: FC<{ sourceId: string; caseId: string; alt: string }> = ({ sourceId, caseId, alt }) => {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const urlRef = useRef<string | null>(null)
  useEffect(() => {
    if (node === null) return
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '320px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  useEffect(() => {
    if (!visible) return
    let active = true
    setFailed(false)
    void fetchInspirationImage(sourceId, caseId).then(blob => {
      if (!active) return
      const next = URL.createObjectURL(blob)
      urlRef.current = next
      setUrl(next)
    }).catch(() => { if (active) setFailed(true) })
    return () => {
      active = false
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [visible, sourceId, caseId])
  return <div ref={setNode} style={{ width: '100%', height: '100%' }}>{url !== null ? <img src={url} alt={alt} loading="lazy" /> : <div className={`dsh-ig-inspiration-image-placeholder ${failed ? 'is-error' : ''}`}>{failed ? '图片暂时无法读取' : <LoaderCircle className="dsh-ig-spin" size={18} />}</div>}</div>
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('copy-failed')
}

export function resolveActiveCatalog(bundled?: InspirationCatalog, cached?: InspirationCatalog): InspirationCatalog | undefined {
  if (!bundled) return cached
  if (!cached) return bundled

  const bundledSource = bundled.sources[0]
  const cachedSource = cached.sources[0]
  if (!bundledSource) return cached
  if (!cachedSource) return bundled

  // 1. 版本一致时优先 bundled（包内静态对象）
  if (bundledSource.version === cachedSource.version) {
    return bundled
  }

  // 2. 有更新时间戳时，取较新的那个（例如发新版插件时 bundled 较新；用户手动刷新成功时 cached 较新）
  const bundledTime = bundledSource.updatedAt ? Date.parse(bundledSource.updatedAt) : NaN
  const cachedTime = cachedSource.updatedAt ? Date.parse(cachedSource.updatedAt) : NaN
  if (Number.isFinite(bundledTime) && Number.isFinite(cachedTime)) {
    return cachedTime > bundledTime ? cached : bundled
  }

  // 3. 缺少有效时间戳时：若缓存的案例数更多，说明是用户手动拉取的新快照，保留缓存；否则优先随插件发版的 bundled
  return cachedSource.cases.length > bundledSource.cases.length ? cached : bundled
}
