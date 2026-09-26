/**
 * Composer tool-row pill: switch the default image provider without leaving
 * the chat. Registered into the official 'conversation.input.right' slot; the
 * write path is the same `provider` settings field the settings card uses, so
 * the two views can never disagree.
 */
import { useEffect, useRef, useState } from 'react'
import {
  CLOUD_IMAGE_PROVIDERS,
  DEFAULT_MODELS,
  IMAGE_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_STATUS_ROUTE,
  activeComfyUIWorkflow,
  cloudCredentialRef,
  isSubscriptionProvider,
  type CloudImageProvider,
  type ComfyUIWorkflowEntry,
  type ImageProvider,
  type SubscriptionProvider,
} from '../shared.js'
import type { SettingsScope } from './index.js'
import type { LocaleService } from './gallery-view.js'
import { writeSetting } from './settings-write.js'

/** Settings fields the pill reads; a structural subset of the full settings shape. */
export interface PillSettings {
  provider?: ImageProvider
  googleModel?: string
  openaiModel?: string
  openaiCompatModel?: string
  seedreamModel?: string
  dashscopeModel?: string
  xaiModel?: string
  zhipuModel?: string
  comfyuiWorkflows?: readonly ComfyUIWorkflowEntry[]
  comfyuiActiveWorkflow?: string
  comfyuiWorkflowJson?: string
  comfyuiWorkflowName?: string
  /** Opt-in toggle persisted by the settings card; the pill stays hidden until enabled. */
  showProviderPill?: boolean
}

/** Minimal credential face the pill needs; structurally satisfied by the settings card's remote. */
interface PillCredentials {
  describe(refs: string[]): Promise<{ ok: boolean; value?: Readonly<Record<string, { configured?: boolean }>> }>
}

/** Notifies the pill whenever any credential reference changes on the host. */
interface PillCredentialEvents { listen(callback: () => void): () => void }

/** Business face injected at registration time by the client entry. */
export interface ProviderPillFace {
  scope: SettingsScope<PillSettings>
  credentials: PillCredentials
  locale?: LocaleService | undefined
  credentialEvents?: PillCredentialEvents | undefined
}

const PILL_DICT = {
  zh: {
    pillLabel: '生图',
    menuTitle: '生图模型',
    keyConfigured: 'Key 已配置',
    keyMissing: '未配置 Key',
    noKeyNeeded: '无需 Key',
    noWorkflow: '未导入工作流',
    subNoKey: '订阅生图',
    subSignedIn: '已登录',
    subSignedOut: '未登录',
    subStatusUnknown: '状态未知',
    readOnly: '图像设置为只读，无法在此切换',
    switchFailed: '切换失败',
    writeRejected: '设置未保存，请重试',
  },
  en: {
    pillLabel: 'Image',
    menuTitle: 'Image model',
    keyConfigured: 'Key configured',
    keyMissing: 'No key',
    noKeyNeeded: 'No key needed',
    noWorkflow: 'No workflow',
    subNoKey: 'Subscription',
    subSignedIn: 'Signed in',
    subSignedOut: 'Signed out',
    subStatusUnknown: 'Unknown',
    readOnly: 'Image settings are read-only; switch them in the config source',
    switchFailed: 'Switch failed',
    writeRejected: 'Setting was not saved. Please try again',
  },
} as const

type PillDictKey = keyof typeof PILL_DICT.zh

/** Provider row names, per locale. Brand words stay untranslated; only the
 * qualifier ("订阅" / "Sub") localizes, so the pill and the menu agree with the
 * settings card in both languages. */
const PILL_PROVIDER_LABELS: Record<'zh' | 'en', Record<ImageProvider, string>> = {
  zh: {
    google: 'Gemini',
    openai: 'OpenAI',
    'openai-compat': 'OpenAI 兼容',
    seedream: 'Seedream',
    dashscope: 'DashScope',
    xai: 'Grok',
    zhipu: '智谱 GLM',
    comfyui: 'ComfyUI',
    'chatgpt-sub': 'ChatGPT 订阅',
    'grok-sub': 'Grok 订阅',
    'google-sub': 'Google 订阅',
  },
  en: {
    google: 'Gemini',
    openai: 'OpenAI',
    'openai-compat': 'OpenAI Compatible',
    seedream: 'Seedream',
    dashscope: 'DashScope',
    xai: 'Grok',
    zhipu: 'Zhipu GLM',
    comfyui: 'ComfyUI',
    'chatgpt-sub': 'ChatGPT Sub',
    'grok-sub': 'Grok Sub',
    'google-sub': 'Google Sub',
  },
}

type KeyDot = 'checking' | 'configured' | 'missing' | 'unknown'

/** Menu's design max-height, mirroring the CSS `max-height` rule. */
const MENU_MAX_HEIGHT = 320

/** Compute the fixed-position anchor from the pill button: open upward when
 * the chat pane leaves room above the composer, drop down otherwise. */
function anchorOf(button: HTMLButtonElement | null): { left: number; bottom?: number; top?: number } | undefined {
  const rect = button?.getBoundingClientRect()
  if (rect === undefined) return undefined
  if (rect.top >= MENU_MAX_HEIGHT + 12) {
    return { left: rect.left, bottom: window.innerHeight - rect.top + 6 }
  }
  return { left: rect.left, top: rect.bottom + 6 }
}

/** Whether the user opted into the composer pill; hidden (not merely inert) when off. */
export function pillVisible(value: PillSettings | undefined): boolean {
  return value?.showProviderPill === true
}

/** Model (or ComfyUI workflow) a provider row will use with the persisted settings. */
export function pillModelOf(provider: ImageProvider, value: PillSettings | undefined): string {
  if (provider === 'comfyui') {
    const workflow = activeComfyUIWorkflow(value ?? {})
    return workflow === undefined ? '' : workflow.name
  }
  if ((SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider)) {
    return DEFAULT_MODELS[provider]
  }
  const stored = provider === 'google' ? value?.googleModel : provider === 'openai' ? value?.openaiModel
    : provider === 'openai-compat' ? value?.openaiCompatModel
    : provider === 'seedream' ? value?.seedreamModel : provider === 'dashscope' ? value?.dashscopeModel
    : provider === 'xai' ? value?.xaiModel : value?.zhipuModel
  return typeof stored === 'string' && stored.length > 0 ? stored : DEFAULT_MODELS[provider]
}

/** One fixed-position provider menu anchored to the pill button. */
export function ImageProviderPill(props: ProviderPillFace) {
  const [snapshot, setSnapshot] = useState(() => props.scope.getSnapshot())
  const [lang, setLang] = useState<'zh' | 'en'>(() => (props.locale?.getSnapshot?.()?.active?.startsWith('en') ? 'en' : 'zh'))
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<ImageProvider | undefined>(undefined)
  const [error, setError] = useState('')
  const [dots, setDots] = useState<Record<CloudImageProvider, KeyDot>>({ google: 'unknown', openai: 'unknown', 'openai-compat': 'unknown', seedream: 'unknown', dashscope: 'unknown', xai: 'unknown', zhipu: 'unknown' })
  const [keyTick, setKeyTick] = useState(0)
  // Subscription login state read from the host status route; the browser sees
  // only state words and the account email, never a token.
  const [subDots, setSubDots] = useState<Record<SubscriptionProvider, 'logged-in' | 'logged-out' | 'unknown'>>(
    () => ({ 'chatgpt-sub': 'unknown', 'grok-sub': 'unknown', 'google-sub': 'unknown' }),
  )
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [menuStyle, setMenuStyle] = useState<{ left: number; bottom?: number; top?: number } | null>(null)

  useEffect(() => props.scope.subscribe(() => { setSnapshot(props.scope.getSnapshot()) }), [props.scope])
  useEffect(() => props.locale?.subscribe?.(() => {
    setLang(props.locale?.getSnapshot?.()?.active?.startsWith('en') ? 'en' : 'zh')
  }), [props.locale])
  useEffect(() => props.credentialEvents?.listen(() => { setKeyTick(tick => tick + 1) }), [props.credentialEvents])

  useEffect(() => {
    let active = true
    const refs: string[] = []
    for (const provider of CLOUD_IMAGE_PROVIDERS) {
      const ref = cloudCredentialRef(provider)
      if (ref !== undefined) refs.push(ref)
    }
    void props.credentials.describe(refs).then(response => {
      if (!active) return
      const next = {} as Record<CloudImageProvider, KeyDot>
      for (const provider of CLOUD_IMAGE_PROVIDERS) {
        const info = response.ok ? response.value?.[cloudCredentialRef(provider) as string] : undefined
        next[provider] = response.ok ? (info?.configured ? 'configured' : 'missing') : 'unknown'
      }
      setDots(next)
    }).catch(() => {
      if (!active) return
      setDots({ google: 'unknown', openai: 'unknown', 'openai-compat': 'unknown', seedream: 'unknown', dashscope: 'unknown', xai: 'unknown', zhipu: 'unknown' })
    })
    return () => { active = false }
  }, [props.credentials, keyTick])

  // Subscription login badges: probed when the menu opens and re-probed on
  // host credential events (a login/logout in the settings card flips the
  // dots here too). Same status route as the settings card; state words only.
  useEffect(() => {
    if (!open) return
    let active = true
    const probe = async (): Promise<void> => {
      try {
        const response = await fetch(SUBSCRIPTION_STATUS_ROUTE, { method: 'POST', cache: 'no-store' })
        if (!active || !response.ok) return
        const payload = await response.json() as { statuses?: Record<string, { state?: string }> }
        if (!active || payload.statuses === undefined) return
        const next = {} as Record<SubscriptionProvider, 'logged-in' | 'logged-out' | 'unknown'>
        for (const provider of SUBSCRIPTION_PROVIDERS) {
          const row = payload.statuses[provider]
          next[provider] = row?.state === 'logged-in' ? 'logged-in' : row?.state === 'logged-out' ? 'logged-out' : 'unknown'
        }
        setSubDots(next)
      } catch { /* dots stay unknown */ }
    }
    void probe()
    return () => { active = false }
  }, [open, keyTick])

  const t = (keyName: PillDictKey): string => (lang === 'en' ? PILL_DICT.en : PILL_DICT.zh)[keyName]

  const current = snapshot.value?.provider ?? 'google'
  const writable = snapshot.writable

  // Anchor the fixed-position menu next to the pill each time it opens, and
  // re-anchor on viewport changes: the menu follows the button instead of
  // snapping shut.
  useEffect(() => {
    if (!open) { setMenuStyle(null); return }
    const anchor = (): void => {
      const next = anchorOf(buttonRef.current)
      if (next !== undefined) setMenuStyle(next)
    }
    anchor()
    window.addEventListener('resize', anchor)
    return () => { window.removeEventListener('resize', anchor) }
  }, [open])

  // Close on outside press, Escape, and when the pill scrolls fully out of
  // view. Menu-internal scrolling never closes: the capture-phase scroll
  // listener below ignores events originating inside the menu itself.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && buttonRef.current !== null && !buttonRef.current.contains(target)
        && !(target instanceof Element && target.closest('.dsh-ig-pill-menu') !== null)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    const onReflow = (event: Event): void => {
      // Scrolling inside the menu itself only scrolls; it never re-anchors
      // and never closes.
      if (event.target instanceof Element && event.target.closest('.dsh-ig-pill-menu') !== null) return
      // Page/pane scroll re-anchors the menu so it keeps following the
      // button; it closes only when the pill left the viewport entirely.
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect !== undefined && (rect.bottom < 0 || rect.top > window.innerHeight)) {
        setOpen(false)
        return
      }
      const next = anchorOf(buttonRef.current)
      if (next !== undefined) setMenuStyle(next)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open])

  // Opt-in guard, placed after the last hook: render nothing until the user
  // enables the pill in settings. Toggling later is a plain re-render.
  if (!pillVisible(snapshot.value)) return null

  /** Same write path as the settings card: one field, one disposer, no implicit side effects. */
  const select = (provider: ImageProvider): void => {
    if (pending !== undefined || provider === current) { setOpen(false); return }
    setError('')
    setPending(provider)
    void writeSetting(props.scope, 'provider', provider, t('writeRejected'))
      .then(() => { setOpen(false) })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setPending(undefined) })
  }

  /** Plan A dots: ComfyUI is always fixed blue (theme-independent); each
   * subscription reflects its login state (green in, gray out); cloud rows
   * reflect their API-key state as before. */
  const dotClassOf = (provider: ImageProvider): string => {
    if (provider === 'comfyui') return 'dsh-ig-pill-dot-neutral'
    if (isSubscriptionProvider(provider)) {
      const state = subDots[provider]
      return state === 'logged-in' ? 'dsh-ig-pill-dot-ok' : 'dsh-ig-pill-dot-missing'
    }
    const dot = dots[provider]
    return dot === 'configured' ? 'dsh-ig-pill-dot-ok' : dot === 'missing' ? 'dsh-ig-pill-dot-missing' : 'dsh-ig-pill-dot-neutral'
  }

  const subtitleOf = (provider: ImageProvider): string => {
    if (provider === 'comfyui') {
      const workflow = pillModelOf(provider, snapshot.value)
      return workflow.length > 0 ? `${t('noKeyNeeded')} · ${workflow}` : `${t('noKeyNeeded')} · ${t('noWorkflow')}`
    }
    if (isSubscriptionProvider(provider)) {
      const state = subDots[provider]
      const stateText = state === 'logged-in' ? t('subSignedIn') : state === 'logged-out' ? t('subSignedOut') : t('subStatusUnknown')
      return `${t('subNoKey')} · ${stateText} · ${pillModelOf(provider, snapshot.value)}`
    }
    const dot = dots[provider]
    const model = pillModelOf(provider, snapshot.value)
    if (dot === 'configured') return `${t('keyConfigured')} · ${model}`
    if (dot === 'missing') return `${t('keyMissing')} · ${model}`
    return model
  }

  return (
    <div className="dsh-ig-pill-root">
      <button
        type="button"
        ref={buttonRef}
        className={`dsh-ig-pill-button${open ? ' dsh-ig-pill-button-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={writable ? t('menuTitle') : t('readOnly')}
        disabled={!writable}
        onClick={() => { setOpen(value => !value) }}
      >
        <svg className="dsh-ig-pill-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" /><circle cx="5.5" cy="6.5" r="1.3" /><path d="M14.5 10.5l-3.2-3.2-6.3 6.2" />
        </svg>
        <span className="dsh-ig-pill-provider">{PILL_PROVIDER_LABELS[lang][current]}</span>
        <span className={`dsh-ig-pill-caret${open ? ' dsh-ig-pill-caret-open' : ''}`} aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4" /></svg>
        </span>
      </button>
      {open && menuStyle !== null ? (
        <div className="dsh-ig-pill-menu" role="menu" aria-label={t('menuTitle')} style={menuStyle}>
          <div className="dsh-ig-pill-menu-title">{t('menuTitle')}</div>
          {IMAGE_PROVIDERS.map(provider => (
            <button
              type="button"
              key={provider}
              role="menuitemradio"
              aria-checked={provider === current}
              className={`dsh-ig-pill-option${provider === current ? ' dsh-ig-pill-option-active' : ''}`}
              disabled={pending !== undefined}
              onClick={() => { select(provider) }}
            >
              <span className={`dsh-ig-pill-dot ${dotClassOf(provider)}`} aria-hidden="true" />
              <span className="dsh-ig-pill-option-text">
                <span className="dsh-ig-pill-option-name">{PILL_PROVIDER_LABELS[lang][provider]}</span>
                <span className="dsh-ig-pill-option-sub">{subtitleOf(provider)}</span>
              </span>
              {provider === current ? <span className="dsh-ig-pill-check" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 8.5l3.5 3.5 7-8" /></svg>
              </span> : null}
            </button>
          ))}
          {error.length > 0 ? <div className="dsh-ig-pill-error" role="alert">{t('switchFailed')}：{error}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Styles for the pill and its fixed-position menu; injected by the client entry. */
export const PROVIDER_PILL_STYLE = `
.dsh-ig-pill-root{position:relative;display:inline-flex;align-items:center;height:28px}
.dsh-ig-pill-button{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px 0 8px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:14px;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:border-color .15s,background .15s,color .15s;-webkit-user-select:none;user-select:none}
.dsh-ig-pill-button:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#9ca3af);color:var(--dsw-alias-label-primary,#111827)}
.dsh-ig-pill-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c78ff);outline-offset:1px}
.dsh-ig-pill-button:disabled{opacity:.5;cursor:not-allowed}
.dsh-ig-pill-button-open{border-color:var(--dsw-alias-brand-primary,#4c78ff);color:var(--dsw-alias-label-primary,#111827)}
.dsh-ig-pill-icon{flex:none;color:var(--dsw-alias-brand-primary,#4c78ff)}
.dsh-ig-pill-provider{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ig-pill-caret{display:inline-flex;flex:none;transition:transform .15s}
.dsh-ig-pill-caret-open{transform:rotate(180deg)}
@container (max-width:700px){
  .dsh-ig-pill-caret{display:none}
  .dsh-ig-pill-button{padding:0 7px 0 6px}
}
.dsh-ig-pill-menu{position:fixed;z-index:1000;min-width:264px;max-width:min(320px,calc(100vw - 24px));padding:6px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 12px 32px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.08);max-height:min(320px,calc(100vh - 48px));overflow-y:auto}
.dsh-ig-pill-menu-title{padding:6px 8px 4px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-ig-pill-option{display:flex;width:100%;align-items:center;gap:9px;padding:7px 8px;border:0;border-radius:8px;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.dsh-ig-pill-option:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f3f4f6)}
.dsh-ig-pill-option:disabled{opacity:.6;cursor:default}
.dsh-ig-pill-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c78ff);outline-offset:-2px}
.dsh-ig-pill-option-active{background:var(--dsw-alias-brand-primary-soft,rgba(76,120,255,.10))}
.dsh-ig-pill-dot{flex:none;width:7px;height:7px;border-radius:50%}
.dsh-ig-pill-dot-ok{background:#22c55e}
.dsh-ig-pill-dot-missing{background:#9ca3af}
.dsh-ig-pill-dot-neutral{background:#4c78ff}
.dsh-ig-pill-option-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-ig-pill-option-name{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary,#111827);line-height:1.2}
.dsh-ig-pill-option-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ig-pill-check{flex:none;color:var(--dsw-alias-brand-primary,#4c78ff)}
.dsh-ig-pill-error{margin-top:4px;padding:6px 8px;border-radius:8px;background:rgba(239,68,68,.08);color:#ef4444;font-size:11.5px;line-height:1.4;word-break:break-all}
`
