import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeDatalistPopup, installDatalistScrollFix, isDatalistInput, type FocusableElement } from '../src/client/datalist-scroll-fix.js'

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers() })

function input(tagName = 'INPUT', hasList = true): FocusableElement {
  return { tagName, hasAttribute: name => hasList && name === 'list', blur: vi.fn() }
}

function environment(activeElement: FocusableElement | null = input()) {
  const listeners = new Map<string, (event?: { key?: string; target?: unknown }) => void>()
  const frames: Array<() => void> = []
  const target = (prefix: string) => ({
    addEventListener: (type: string, fn: (event?: { key?: string; target?: unknown }) => void) => { listeners.set(prefix + ':' + type, fn) },
    removeEventListener: (type: string) => { listeners.delete(prefix + ':' + type) },
  })
  const env = {
    window: target('window'), document: { ...target('document'), activeElement },
    schedule: (fn: () => void) => { frames.push(fn) },
  }
  const stop = installDatalistScrollFix(env)
  if (stop) stops.push(stop)
  return { env, listeners, frames, stop, fire: (type: string, event?: { key?: string; target?: unknown }) => listeners.get(type)?.(event), flush: () => frames.splice(0).forEach(fn => fn()) }
}

describe('datalist scroll lifecycle', () => {
  it('recognizes datalist inputs and leaves other controls alone', () => {
    expect(isDatalistInput(input())).toBe(true)
    expect(isDatalistInput(input('INPUT', false))).toBe(false)
    expect(isDatalistInput(input('TEXTAREA'))).toBe(false)
    expect(closeDatalistPopup(null)).toBe(false)
  })
  it('closes the same input after deliberate scrolling', () => {
    const active = input(), e = environment(active)
    e.fire('document:wheel'); e.fire('document:scroll'); e.flush()
    expect(active.blur).toHaveBeenCalledOnce()
  })
  it('does not blur a newly focused off-screen input on automatic scroll/resize', () => {
    const active = input(), e = environment(active)
    e.fire('document:focusin'); e.fire('document:scroll'); e.fire('window:resize'); e.flush()
    expect(active.blur).not.toHaveBeenCalled()
  })
  it('does not blur a different input focused before the queued callback', () => {
    const previous = input(), next = input(), e = environment(previous)
    e.fire('document:wheel'); e.fire('document:scroll')
    e.env.document.activeElement = next
    e.fire('document:focusin'); e.flush()
    expect(previous.blur).not.toHaveBeenCalled()
    expect(next.blur).not.toHaveBeenCalled()
  })
  it('does not treat Tab as an explicit scroll gesture', () => {
    const active = input(), e = environment(active)
    e.fire('document:keydown', { key: 'Tab' }); e.fire('document:scroll'); e.flush()
    expect(active.blur).not.toHaveBeenCalled()
  })
  it('preserves editing focus when the input scrolls its own text', () => {
    const active = input(), e = environment(active)
    e.fire('document:pointerdown'); e.fire('document:scroll', { target: active }); e.flush()
    e.fire('document:keydown', { key: ' ' }); e.fire('document:scroll'); e.flush()
    expect(active.blur).not.toHaveBeenCalled()
  })
  it('expires old gestures rather than applying them to later programmatic scrolling', () => {
    vi.useFakeTimers()
    const active = input(), e = environment(active)
    e.fire('document:pointerdown'); vi.advanceTimersByTime(251)
    e.fire('document:scroll'); e.flush()
    expect(active.blur).not.toHaveBeenCalled()
  })
  it('coalesces duplicate scroll events and removes every listener on unload', () => {
    const active = input(), e = environment(active)
    expect(installDatalistScrollFix(e.env)).toBe(false)
    e.fire('document:wheel'); e.fire('document:scroll'); e.fire('window:scroll')
    expect(e.frames).toHaveLength(1)
    if (e.stop) e.stop()
    e.flush()
    expect(active.blur).not.toHaveBeenCalled()
    expect(e.listeners.size).toBe(0)
    const replacement = installDatalistScrollFix(e.env)
    expect(typeof replacement).toBe('function')
    if (replacement) replacement()
  })
  it('leaves host controls outside this plugin untouched', () => {
    const active = input(), e = environment(active)
    if (e.stop) e.stop()
    const stop = installDatalistScrollFix({ ...e.env, ownsInput: () => false })
    if (stop) stops.push(stop)
    e.fire('document:wheel'); e.fire('document:scroll'); e.flush()
    expect(active.blur).not.toHaveBeenCalled()
  })
  it('is a no-op without a browser', () => expect(installDatalistScrollFix()).toBe(false))
})
