import { describe, expect, it, vi } from 'vitest'
import { closeDatalistPopup, installDatalistScrollFix, isDatalistInput, type FocusableElement } from '../src/client/datalist-scroll-fix.js'

function element(tagName: string, hasList: boolean, blur = vi.fn()): FocusableElement {
  return { tagName, hasAttribute: name => hasList && name === 'list', blur }
}

function environment(activeElement: FocusableElement | null) {
  const listeners = new Map<string, () => void>()
  const schedule = (callback: () => void): void => { callback() }
  return {
    listeners,
    env: {
      window: { addEventListener: (type: string, listener: () => void) => { listeners.set('window:' + type, listener) } },
      document: {
        activeElement,
        addEventListener: (type: string, listener: () => void) => { listeners.set('document:' + type, listener) },
      },
      schedule,
    },
  }
}

describe('datalist scroll fix', () => {
  it('recognizes only inputs backed by a datalist', () => {
    expect(isDatalistInput(element('INPUT', true))).toBe(true)
    expect(isDatalistInput(element('INPUT', false))).toBe(false)
    expect(isDatalistInput(element('DIV', true))).toBe(false)
    expect(isDatalistInput(null)).toBe(false)
  })

  it('closes a focused datalist input on scroll and resize', () => {
    const input = element('INPUT', true)
    const { env, listeners } = environment(input)
    expect(installDatalistScrollFix(env)).toBe(true)
    expect([...listeners.keys()].sort()).toEqual(['document:scroll', 'window:resize', 'window:scroll'])

    listeners.get('document:scroll')?.()
    expect(input.blur).toHaveBeenCalledTimes(1)

    listeners.get('window:scroll')?.()
    expect(input.blur).toHaveBeenCalledTimes(2)
  })

  it('leaves other focused elements alone', () => {
    const other = element('TEXTAREA', false)
    const { env, listeners } = environment(other)
    installDatalistScrollFix(env)
    listeners.get('window:resize')?.()
    expect(other.blur).not.toHaveBeenCalled()
  })

  it('installs at most once per window', () => {
    const { env } = environment(element('INPUT', true))
    expect(installDatalistScrollFix(env)).toBe(true)
    expect(installDatalistScrollFix(env)).toBe(false)
  })

  it('is a no-op without a browser environment', () => {
    expect(installDatalistScrollFix()).toBe(false)
  })

  it('coalesces bursts into one close', () => {
    const input = element('INPUT', true)
    const callbacks: Array<() => void> = []
    const env = {
      window: { addEventListener: vi.fn() },
      document: { activeElement: input, addEventListener: vi.fn() },
      schedule: (callback: () => void) => { callbacks.push(callback) },
    }
    installDatalistScrollFix(env)
    const handler = env.document.addEventListener.mock.calls[0]?.[1] as () => void
    handler()
    handler()
    handler()
    expect(callbacks).toHaveLength(1)
    callbacks[0]?.()
    expect(input.blur).toHaveBeenCalledTimes(1)
  })
})
