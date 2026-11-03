/**
 * Chromium positions a native <datalist> popup once, when it opens, and does not
 * move it with the page or a scroll container. After a scroll or a resize the
 * popup floats over unrelated UI, so close it by blurring the owning input;
 * focusing the field again reopens the list.
 */

type Listener = () => void

interface EventTargetLike {
  addEventListener(type: string, listener: Listener, capture?: boolean): void
}

/** The part of an element this fix needs; keeps the helper testable off-DOM. */
export interface FocusableElement {
  tagName: string
  hasAttribute(name: string): boolean
  blur(): void
}

export interface DatalistScrollFixEnvironment {
  window: EventTargetLike & Record<string, unknown>
  document: EventTargetLike & { activeElement: FocusableElement | null }
  /** Frame scheduler; defaults to requestAnimationFrame in the browser. */
  schedule?: (callback: Listener) => void
}

const GUARD = '__dshIgDatalistScrollFix'

/** True when the element is an input backed by a native datalist. */
export function isDatalistInput(element: FocusableElement | null): boolean {
  return element !== null && element.tagName === 'INPUT' && element.hasAttribute('list')
}

/** Close the popup for a focused input; returns whether it blurred one. */
export function closeDatalistPopup(element: FocusableElement | null): boolean {
  if (!isDatalistInput(element)) return false
  element!.blur()
  return true
}

/**
 * Install the scroll/resize handler once per window. Returns false when there
 * is no browser environment or the handler is already installed.
 */
export function installDatalistScrollFix(environment?: DatalistScrollFixEnvironment): boolean {
  const env = environment ?? browserEnvironment()
  if (env === undefined || env.window[GUARD] === true) return false
  env.window[GUARD] = true

  let queued = false
  const schedule = (): void => {
    if (queued) return
    queued = true
    const run = (): void => {
      queued = false
      closeDatalistPopup(env.document.activeElement)
    }
    if (env.schedule !== undefined) env.schedule(run)
    // Some embedded webviews expose no requestAnimationFrame; a macrotask is
    // enough here and keeps `queued` from staying true forever.
    else if (typeof setTimeout === 'function') setTimeout(run, 0)
    else run()
  }

  env.document.addEventListener('scroll', schedule, true)
  env.window.addEventListener('scroll', schedule, true)
  env.window.addEventListener('resize', schedule, true)
  return true
}

function browserEnvironment(): DatalistScrollFixEnvironment | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
  const schedule = typeof requestAnimationFrame === 'function'
    ? (callback: Listener): void => { requestAnimationFrame(callback) }
    : undefined
  return {
    window: window as unknown as DatalistScrollFixEnvironment['window'],
    document: document as unknown as DatalistScrollFixEnvironment['document'],
    ...(schedule === undefined ? {} : { schedule }),
  }
}
