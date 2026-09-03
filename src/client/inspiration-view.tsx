import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import { Check, Clipboard, ExternalLink, ImageIcon, LoaderCircle, Search, Sparkles } from 'lucide-react'
import { INSPIRATION_ROUTE } from '../shared.js'
import type { InspirationCase, InspirationCatalog, InspirationSource } from '../inspiration.js'
import { fetchInspirationImage } from './inspiration-image-cache.js'
import { loadCachedInspirationCatalog, saveCachedInspirationCatalog } from './inspiration-catalog-cache.js'
import type { LocaleService } from './gallery-view.js'

type Language = 'zh' | 'en'

const COPY = {
  zh: {
    kicker: 'Prompt inspiration', title: '灵感素材', subtitle: '从公开案例中找构图、质感和文字处理，再带回工作台继续调整。',
    refresh: '检查更新', refreshing: '正在更新…', allCategories: '全部分类', allStyles: '全部风格', allScenes: '全部场景',
    search: '搜索案例、Prompt、风格…', results: '找到 {count} 个案例', noResults: '没有匹配的素材，换个关键词或筛选条件试试。',
    selectHint: '选择一张素材，查看完整 Prompt 并带回工作台。', prompt: '完整 Prompt', copy: '复制 Prompt', copied: '已复制', use: '使用这个 Prompt', source: '查看原来源',
    loading: '正在读取素材库…', loadFailed: '素材库读取失败，请稍后重试。', imageFailed: '图片暂时无法读取', featured: '精选', updated: '素材已更新（{count} 条）', updateFailed: '更新失败，仍在使用当前内置素材。', loadMore: '加载更多（剩余 {count}）',
  },
  en: {
    kicker: 'Prompt inspiration', title: 'Inspiration', subtitle: 'Explore public examples, then bring a prompt back to Studio to make it your own.',
    refresh: 'Check updates', refreshing: 'Updating…', allCategories: 'All categories', allStyles: 'All styles', allScenes: 'All scenes',
    search: 'Search examples, prompts, styles…', results: '{count} examples', noResults: 'No matching examples. Try another keyword or filter.',
    selectHint: 'Choose an example to read its full prompt and use it in Studio.', prompt: 'Full prompt', copy: 'Copy prompt', copied: 'Copied', use: 'Use this prompt', source: 'View source',
    loading: 'Loading inspiration…', loadFailed: 'Could not load the inspiration library.', imageFailed: 'Image is temporarily unavailable', featured: 'Featured', updated: 'Updated ({count} examples)', updateFailed: 'Update failed. The current bundled library is still available.', loadMore: 'Load more ({count} left)',
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
  const [visibleLimit, setVisibleLimit] = useState(72)
  const [selected, setSelected] = useState<InspirationCase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!locale?.subscribe) return
    return locale.subscribe(() => setLanguage(locale.getSnapshot?.().active?.startsWith('en') ? 'en' : 'zh'))
  }, [locale])

  const t = (key: CopyKey, values?: Record<string, string>) => {
    let value: string = COPY[language][key] ?? COPY.zh[key]
    for (const [name, replacement] of Object.entries(values ?? {})) value = value.replace(`{${name}}`, replacement)
    return value
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
      if (category && item.category !== category) return false
      if (style && !item.styles.includes(style)) return false
      if (scene && !item.scenes.includes(scene)) return false
      if (!query) return true
      return [item.title, item.prompt, item.category, ...item.styles, ...item.scenes].some(value => value.toLowerCase().includes(query))
    })
  }, [source, search, category, style, scene])

  useEffect(() => setVisibleLimit(72), [search, category, style, scene])
  const visibleCases = matchingCases.slice(0, visibleLimit)

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
        <select value={category} onChange={event => setCategory(event.target.value)} aria-label={t('allCategories')}><option value="">{t('allCategories')}</option>{source.categories.map(item => <option key={item} value={item}>{item}</option>)}</select>
        <select value={style} onChange={event => setStyle(event.target.value)} aria-label={t('allStyles')}><option value="">{t('allStyles')}</option>{source.styles.map(item => <option key={item} value={item}>{item}</option>)}</select>
        <select value={scene} onChange={event => setScene(event.target.value)} aria-label={t('allScenes')}><option value="">{t('allScenes')}</option>{source.scenes.map(item => <option key={item} value={item}>{item}</option>)}</select>
      </div>
      <div className="dsh-ig-inspiration-layout">
        <div><div className="dsh-ig-inspiration-summary"><strong>{t('results', { count: String(matchingCases.length) })}</strong><span>{source.version.slice(0, 8)}</span></div>{matchingCases.length === 0 ? <div className="dsh-ig-inspiration-empty">{t('noResults')}</div> : <><div className="dsh-ig-inspiration-grid">{visibleCases.map(item => <InspirationCard key={item.id} item={item} sourceId={source.id} selected={selected?.id === item.id} featuredLabel={t('featured')} onSelect={() => { setSelected(item); setCopied(false) }} />)}</div>{matchingCases.length > visibleLimit && <button type="button" className="dsh-ig-inspiration-load-more" onClick={() => setVisibleLimit(limit => limit + 72)}>{t('loadMore', { count: String(matchingCases.length - visibleLimit) })}</button>}</>}</div>
        <aside className="dsh-ig-inspiration-inspector">{selected === null ? <div className="dsh-ig-inspiration-inspector-empty"><ImageIcon size={28} /><span>{t('selectHint')}</span></div> : <>
          <div className="dsh-ig-inspiration-inspector-image"><InspirationImage sourceId={source.id} caseId={selected.id} alt={selected.imageAlt} /></div>
          <div className="dsh-ig-inspiration-inspector-body"><h2>{selected.title}</h2>{selected.sourceLabel && <p className="dsh-ig-inspiration-origin">{selected.sourceLabel}</p>}<div className="dsh-ig-inspiration-tags"><span>{selected.category}</span>{selected.styles.slice(0, 3).map(item => <span key={item}>{item}</span>)}</div><div className="dsh-ig-inspiration-prompt-label"><span>{t('prompt')}</span><span>{selected.prompt.length}</span></div><p className="dsh-ig-inspiration-prompt">{selected.prompt}</p><div className="dsh-ig-inspiration-actions"><button type="button" onClick={() => void copyPrompt()}>{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? t('copied') : t('copy')}</button>{selected.sourceUrl ?? selected.githubUrl ? <a className="dsh-ig-inspiration-source-link" href={selected.sourceUrl ?? selected.githubUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t('source')}</a> : <span /> }<button type="button" className="dsh-ig-inspiration-use" onClick={() => onUsePrompt(selected.prompt)}><Sparkles size={14} />{t('use')}</button></div></div>
        </>}</aside>
      </div>
    </>}
  </section>
}

const InspirationCard: FC<{ item: InspirationCase; sourceId: string; selected: boolean; featuredLabel: string; onSelect(): void }> = ({ item, sourceId, selected, featuredLabel, onSelect }) => <button type="button" className={`dsh-ig-inspiration-card ${selected ? 'is-selected' : ''}`} onClick={onSelect}><div className="dsh-ig-inspiration-visual">{item.featured && <span className="dsh-ig-inspiration-featured"><Sparkles size={10} />{featuredLabel}</span>}<InspirationImage sourceId={sourceId} caseId={item.id} alt={item.imageAlt} /></div><div className="dsh-ig-inspiration-card-copy"><strong>{item.title}</strong><span>{item.category}</span></div></button>

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
