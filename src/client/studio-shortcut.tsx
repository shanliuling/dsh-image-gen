/**
 * Composer shortcut that opens or closes the right-sidebar Image Studio.
 * Registered into the official 'conversation.input.right' slot, which DSH
 * renders right before the model select, so the icon sits beside it.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import type { LocaleService } from './gallery-view.js'

/** One open right-sidebar tab as published by DSH's `sidebarRight` inventory. */
export interface SidebarRightTab {
  sessionId?: string
  tabId: string
  kind: string
}

/**
 * Runtime face of DSH's `sidebarRight` controller. Duck-typed and optional:
 * older hosts without the service never mount the composer shortcut.
 */
export interface SidebarRightFace {
  openTab(kind: string, options?: { revealIfOpened?: boolean }): void
  close(tabId: string): void
  active(): { id: string; kind: string } | undefined
  openTabs?: {
    getSnapshot(): readonly SidebarRightTab[]
    subscribe(listener: () => void): () => void
  } | undefined
}

export interface StudioShortcutProps {
  locale?: LocaleService | undefined
  sidebarRight: SidebarRightFace
  /** Studio tab identity: `kind` is what `openTab` takes, `id` prefixes its tab ids. */
  studioTab: { id: string; kind: string }
  sessionId?: string
  /** Plugin settings; the shortcut shares the provider pill's `showProviderPill` toggle. */
  scope?: ShortcutVisibilityScope | undefined
}

export interface ShortcutVisibilityScope {
  getSnapshot(): { value?: { showProviderPill?: boolean } | undefined }
  subscribe(listener: () => void): () => void
}

/** Shown together with the provider pill: only while its toggle is on. */
export function shortcutVisible(scope: ShortcutVisibilityScope | undefined): boolean {
  return scope?.getSnapshot().value?.showProviderPill === true
}

function useShortcutVisible(scope: ShortcutVisibilityScope | undefined): boolean {
  const subscribe = useMemo(() => (listener: () => void) => scope?.subscribe(listener) ?? (() => {}), [scope])
  const getSnapshot = (): boolean => shortcutVisible(scope)
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const SHORTCUT_TEXT = {
  zh: { open: '打开图像工作台', close: '关闭图像工作台' },
  en: { open: 'Open Image Studio', close: 'Close Image Studio' },
} as const

export type ShortcutLang = keyof typeof SHORTCUT_TEXT

export function shortcutLang(locale: LocaleService | undefined): ShortcutLang {
  return locale?.getSnapshot?.()?.active?.startsWith('en') ? 'en' : 'zh'
}

/** Tooltip and accessible name: the action the next click performs. */
export function shortcutTitle(lang: ShortcutLang, open: boolean): string {
  return SHORTCUT_TEXT[lang][open ? 'close' : 'open']
}

/** Subscribable view of the host locale reduced to the shortcut's language. */
export function shortcutLangStore(locale: LocaleService | undefined): { subscribe(listener: () => void): () => void; getSnapshot(): ShortcutLang } {
  return {
    subscribe: listener => (typeof locale?.subscribe === 'function' ? locale.subscribe(listener) : () => {}),
    getSnapshot: () => shortcutLang(locale),
  }
}

/** Current composer language, re-rendering whenever the host locale switches. */
function useShortcutLang(locale: LocaleService | undefined): ShortcutLang {
  const store = useMemo(() => shortcutLangStore(locale), [locale])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function isStudioTab(studioTab: { id: string; kind: string }, tab: { kind?: string; tabId?: string; id?: string } | undefined): boolean {
  return tab !== undefined && (tab.kind === studioTab.kind || tab.kind === studioTab.id || String(tab.tabId ?? tab.id ?? '').startsWith(studioTab.id))
}

/** The studio tab of this session to close, or undefined when the next click opens it. */
export function openStudioTab(props: StudioShortcutProps): string | undefined {
  const inSession = (tab: SidebarRightTab): boolean => props.sessionId === undefined || tab.sessionId === undefined || tab.sessionId === props.sessionId
  let tabs: readonly SidebarRightTab[] = []
  try { tabs = props.sidebarRight.openTabs?.getSnapshot() ?? [] } catch { tabs = [] }
  const existing = tabs.find(tab => inSession(tab) && isStudioTab(props.studioTab, tab))
  if (existing !== undefined) return existing.tabId
  const active = props.sidebarRight.active()
  return active !== undefined && isStudioTab(props.studioTab, active) ? active.id : undefined
}

/** Opens the studio, or closes it when this session already shows it. */
export function toggleStudio(props: StudioShortcutProps): 'opened' | 'closed' {
  const tabId = openStudioTab(props)
  if (tabId !== undefined) {
    props.sidebarRight.close(tabId)
    return 'closed'
  }
  props.sidebarRight.openTab(props.studioTab.kind, { revealIfOpened: true })
  return 'opened'
}

export function StudioShortcutButton(props: StudioShortcutProps) {
  const { sidebarRight, sessionId } = props
  const lang = useShortcutLang(props.locale)
  const visible = useShortcutVisible(props.scope)
  const [pressed, setPressed] = useState(false)
  const [tabsActive, setTabsActive] = useState(false)
  const [hover, setHover] = useState(false)
  const prevTabsActive = useRef(false)
  useEffect(() => {
    const source = sidebarRight.openTabs
    if (source === undefined) return undefined
    const sync = (): void => { setTabsActive(openStudioTab(props) !== undefined) }
    sync()
    return source.subscribe(sync)
  }, [sidebarRight, sessionId])
  useEffect(() => {
    if (tabsActive) { prevTabsActive.current = true; return }
    if (!prevTabsActive.current) return
    prevTabsActive.current = false
    setPressed(false)
  }, [tabsActive])
  const active = pressed || tabsActive
  const title = shortcutTitle(lang, active)
  if (!visible) return null
  return (
    <button
      type="button"
      className="dsh-image-quick-button"
      aria-label={title}
      aria-pressed={active}
      title={title}
      style={{
        appearance: 'none',
        WebkitAppearance: 'none',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        padding: 0,
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: active ? 'rgba(74, 125, 255, 0.10)' : (hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent'),
        color: active ? '#4A7DFF' : 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        outline: 'none',
        boxShadow: active ? '0 0 0 1px #4A7DFF' : 'none',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { setPressed(toggleStudio(props) === 'opened') }}
    >
      <ImageIcon size={15} strokeWidth={1.8} aria-hidden="true" />
    </button>
  )
}
