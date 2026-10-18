import { afterEach, describe, expect, it, vi } from 'vitest'
import { startConversationLandings, type CanvasSessions } from '../src/client/tl/conversation-landings.js'
import { clearTlLandings, registerTlLandingConsumer } from '../src/client/tl/tl-canvas-bridge.js'

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of listeners) listener() },
    listeners,
  }
}

function event(seq: number, id = 'image') {
  return { type: 'event', event: { type: 'tool/result', seq, data: { meta: {
    kind: 'dsh-image-gen', prompt: 'a cat', provider: 'google', model: 'gemini', output: '1K',
    attachment: { attachmentId: `sha256:${id}`, mediaType: 'image/png', bytes: 8, width: 1, height: 1 },
  } } } }
}
function feed() {
  const source = store({ entries: [] as ReturnType<typeof event>[], change: { kind: 'append', entries: [] as ReturnType<typeof event>[] } })
  return { source, emit(seq: number, id?: string, kind = 'append') {
    const next = event(seq, id)
    source.set({ entries: [...source.getSnapshot().entries, next], change: { kind, entries: [next] } })
  } }
}

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); clearTlLandings() })
function harness(snapshot: object, current?: ReturnType<typeof store<{ key?: string }>>) {
  const first = feed(), second = feed()
  const list = store(snapshot)
  const sessions = { list, binding: vi.fn((id: string) => ({ eventSource: id === 's2' ? second.source : first.source })) }
  const consumer = vi.fn(async () => true)
  stops.push(registerTlLandingConsumer(consumer))
  stops.push(startConversationLandings(sessions as unknown as CanvasSessions, current))
  return { first, second, list, sessions, consumer }
}

describe('conversation images landing on the active canvas', () => {
  it('keeps the legacy current session path', () => {
    const h = harness({ current: 's1' })
    h.first.emit(1)
    expect(h.consumer).toHaveBeenCalledWith([expect.objectContaining({ galleryId: 'sha256:image', prompt: 'a cat', fromConversation: true })])
  })

  it('follows the retained main view when a modern session list has no current field', () => {
    const h = harness({ ids: ['s1', 's2'], byId: { s1: { id: 's1', retainedBy: { sidebar: 1 } }, s2: { id: 's2', retainedBy: { mainView: 1 } } } })
    h.second.emit(1)
    expect(h.sessions.binding).toHaveBeenCalledWith('s2')
    expect(h.consumer).toHaveBeenCalledTimes(1)
  })

  it('uses uiSession as the authority even with several retained main views', () => {
    const current = store<{ key?: string }>({ key: 's2' })
    const h = harness({ current: 's1', byId: { s1: { id: 's1', retainedBy: { mainView: 1 } }, s2: { id: 's2', retainedBy: { mainView: 1 } } } }, current)
    h.first.emit(1)
    expect(h.consumer).not.toHaveBeenCalled()
    h.second.emit(1)
    expect(h.consumer).toHaveBeenCalledTimes(1)
  })

  it('switches feeds on a uiSession change without a session-list change and releases subscriptions', () => {
    const current = store<{ key?: string }>({ key: 's1' })
    const h = harness({}, current)
    h.second.emit(1, 'history')
    current.set({ key: 's2' })
    h.first.emit(1, 'old-session')
    h.second.emit(2, 'fresh')
    expect(h.consumer).toHaveBeenCalledWith([expect.objectContaining({ galleryId: 'sha256:fresh' })])
    expect(h.consumer).toHaveBeenCalledTimes(1)
    stops.pop()!()
    expect(current.listeners.size).toBe(0)
    expect(h.first.source.listeners.size).toBe(0)
    expect(h.second.source.listeners.size).toBe(0)
    expect(h.list.listeners.size).toBe(0)
  })

  it('does not fall back to another retained session when uiSession has no active binding', () => {
    const h = harness({ current: 's1' }, store<{ key?: string }>({}))
    h.first.emit(1)
    expect(h.sessions.binding).not.toHaveBeenCalled()
    expect(h.consumer).not.toHaveBeenCalled()
  })

  it('does not guess between multiple retained views when uiSession is unavailable', () => {
    const h = harness({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } }, s2: { id: 's2', retainedBy: { mainView: 1 } } } })
    expect(h.sessions.binding).not.toHaveBeenCalled()
  })

  it('does not replay history or repeated events on list updates', () => {
    const h = harness({ current: 's1' })
    h.first.emit(1, 'replay', 'replace')
    h.first.emit(1, 'replay')
    h.list.set({ current: 's1' })
    expect(h.consumer).not.toHaveBeenCalled()
    h.first.emit(2, 'fresh')
    expect(h.consumer).toHaveBeenCalledTimes(1)
  })
})
