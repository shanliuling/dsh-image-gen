import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  StudioShortcutButton,
  shortcutLangStore,
  shortcutTitle,
  shortcutVisible,
  toggleStudio,
  type SidebarRightFace,
  type SidebarRightTab,
  type StudioShortcutProps,
} from '../src/client/studio-shortcut.js'

const studioTab = { id: 'dsh-image-gen/studio', kind: 'dsh-image-gen-studio' }

function localeStore(active: string) {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ active }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    switchTo(next: string) { active = next; for (const fn of listeners) fn() },
    listeners,
  }
}

function sidebar(tabs: SidebarRightTab[] = [], active?: { id: string; kind: string }): SidebarRightFace & { openTab: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    openTab: vi.fn(),
    close: vi.fn(),
    active: () => active,
    openTabs: { getSnapshot: () => tabs, subscribe: () => () => {} },
  }
}

describe('composer studio shortcut language', () => {
  it('names the next action in both languages', () => {
    expect(shortcutTitle('zh', false)).toBe('打开图像工作台')
    expect(shortcutTitle('zh', true)).toBe('关闭图像工作台')
    expect(shortcutTitle('en', false)).toBe('Open Image Studio')
    expect(shortcutTitle('en', true)).toBe('Close Image Studio')
  })

  it('follows a locale switch while mounted and unsubscribes on cleanup', () => {
    const locale = localeStore('zh-CN')
    const store = shortcutLangStore(locale)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    expect(store.getSnapshot()).toBe('zh')

    locale.switchTo('en-US')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe('en')

    locale.switchTo('zh-CN')
    expect(store.getSnapshot()).toBe('zh')
    unsubscribe()
    expect(locale.listeners.size).toBe(0)
  })

  it('falls back to Chinese without a locale service', () => {
    const store = shortcutLangStore(undefined)
    expect(store.getSnapshot()).toBe('zh')
    expect(() => store.subscribe(() => {})()).not.toThrow()
  })
})

function pillScope(showProviderPill?: boolean) {
  const listeners = new Set<() => void>()
  let value: { showProviderPill?: boolean } | undefined = showProviderPill === undefined ? undefined : { showProviderPill }
  return {
    getSnapshot: () => ({ value }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    toggle(next: boolean) { value = { showProviderPill: next }; for (const fn of listeners) fn() },
  }
}

describe('composer studio shortcut visibility', () => {
  it('shares the provider pill toggle, off by default', () => {
    expect(shortcutVisible(undefined)).toBe(false)
    expect(shortcutVisible(pillScope())).toBe(false)
    expect(shortcutVisible(pillScope(false))).toBe(false)
    expect(shortcutVisible(pillScope(true))).toBe(true)
  })

  it('follows the toggle when it flips', () => {
    const scope = pillScope(false)
    scope.toggle(true)
    expect(shortcutVisible(scope)).toBe(true)
    scope.toggle(false)
    expect(shortcutVisible(scope)).toBe(false)
  })

  it('renders nothing while the pill toggle is off', () => {
    const markup = (scope?: ReturnType<typeof pillScope>) => renderToStaticMarkup(
      createElement(StudioShortcutButton, { sidebarRight: sidebar(), studioTab, scope }),
    )
    expect(markup()).toBe('')
    expect(markup(pillScope(false))).toBe('')
    expect(markup(pillScope(true))).toContain('<button')
  })
})

describe('composer studio shortcut button', () => {
  const render = (props: Partial<StudioShortcutProps>) => renderToStaticMarkup(
    createElement(StudioShortcutButton, { sidebarRight: sidebar(), studioTab, scope: pillScope(true), ...props }),
  )

  it('renders an icon only, with the localized tooltip as its accessible name', () => {
    const zh = render({ locale: localeStore('zh-CN') })
    expect(zh).toContain('<svg')
    expect(zh).toContain('title="打开图像工作台"')
    expect(zh).toContain('aria-label="打开图像工作台"')
    expect(zh).not.toMatch(/<span|>图像</)

    const en = render({ locale: localeStore('en-US') })
    expect(en).toContain('title="Open Image Studio"')
    expect(en).not.toContain('>Image<')
  })
})

describe('composer studio shortcut toggle', () => {
  it('opens the studio tab when none is open', () => {
    const sidebarRight = sidebar()
    expect(toggleStudio({ sidebarRight, studioTab })).toBe('opened')
    expect(sidebarRight.openTab).toHaveBeenCalledWith(studioTab.kind, { revealIfOpened: true })
    expect(sidebarRight.close).not.toHaveBeenCalled()
  })

  it("closes this session's open studio tab", () => {
    const sidebarRight = sidebar([{ sessionId: 's1', tabId: 'dsh-image-gen/studio:1', kind: studioTab.kind }])
    expect(toggleStudio({ sidebarRight, studioTab, sessionId: 's1' })).toBe('closed')
    expect(sidebarRight.close).toHaveBeenCalledWith('dsh-image-gen/studio:1')
    expect(sidebarRight.openTab).not.toHaveBeenCalled()
  })

  it("leaves another session's studio tab alone", () => {
    const sidebarRight = sidebar([{ sessionId: 's2', tabId: 'dsh-image-gen/studio:2', kind: studioTab.kind }])
    expect(toggleStudio({ sidebarRight, studioTab, sessionId: 's1' })).toBe('opened')
    expect(sidebarRight.close).not.toHaveBeenCalled()
  })

  it('closes the active studio tab on hosts without a tab inventory', () => {
    const sidebarRight = { ...sidebar(), openTabs: undefined, active: () => ({ id: 'dsh-image-gen/studio', kind: studioTab.kind }) }
    expect(toggleStudio({ sidebarRight, studioTab })).toBe('closed')
    expect(sidebarRight.close).toHaveBeenCalledWith('dsh-image-gen/studio')
  })
})
