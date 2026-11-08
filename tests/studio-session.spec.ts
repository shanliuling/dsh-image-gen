import { describe, expect, it, vi } from 'vitest'
import { createStudioSession, studioSession, type StudioViewState } from '../src/client/studio-session.js'
import type { GalleryItem } from '../src/client/gallery-store.js'

const item = (id: string) => ({ id, attachment: { attachmentId: id }, prompt: 'p', provider: 'google', model: 'm', createdAt: 1 }) as unknown as GalleryItem
const viewOf = (id: string): StudioViewState => ({ selected: item(id), currentBatch: null, selectedBatchIds: [], batchKind: null })

describe('workbench session (#99)', () => {
  it('keeps a generation running and delivers its result to the workbench mounted when it lands', () => {
    const session = createStudioSession()
    const listener = vi.fn()
    session.subscribe(listener)
    const controller = new AbortController()
    expect(session.start(controller)).toBe(true)
    expect(session.getSnapshot().generating).toBe(true)
    // The workbench is left: its view is kept, the request is not aborted.
    session.keepView(viewOf('before'))
    expect(controller.signal.aborted).toBe(false)
    session.settle(controller, { view: viewOf('result'), notice: 'done' })
    expect(session.getSnapshot()).toMatchObject({ generating: false, outcome: { seq: 1, notice: 'done' } })
    // A workbench mounting now restores the result, not the view left behind.
    expect(session.view()?.selected?.id).toBe('result')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('shows an outcome once: a remount after it was shown does not repeat it', () => {
    const session = createStudioSession()
    const controller = new AbortController()
    session.start(controller)
    session.settle(controller, { error: 'upstream failed' })
    const seq = session.getSnapshot().outcome!.seq
    expect(session.delivered(seq)).toBe(false)
    session.markDelivered(seq)
    expect(session.delivered(seq)).toBe(true)
  })

  it('runs one generation at a time and ignores a cancelled or stale request', () => {
    const session = createStudioSession()
    const first = new AbortController()
    expect(session.start(first)).toBe(true)
    expect(session.start(new AbortController())).toBe(false)
    session.cancel()
    expect(first.signal.aborted).toBe(true)
    expect(session.getSnapshot().generating).toBe(false)
    // The cancelled request settling late changes nothing.
    session.settle(first, { view: viewOf('late') })
    expect(session.getSnapshot().outcome).toBeUndefined()
    expect(session.view()).toBeUndefined()
    // An ending without a result keeps the last view and outcome.
    const second = new AbortController()
    session.start(second)
    session.keepView(viewOf('kept'))
    session.settle(second)
    expect(session.getSnapshot()).toMatchObject({ generating: false, outcome: undefined })
    expect(session.view()?.selected?.id).toBe('kept')
  })

  it('gives the main workbench and the sidebar workbench separate sessions', () => {
    expect(studioSession('preview')).toBe(studioSession('preview'))
    expect(studioSession('preview')).not.toBe(studioSession('infinite'))
  })
})

describe('workbench selection across gallery reloads (#99)', () => {
  it('keeps an unsaved result, refreshes a saved one and drops a deleted one', async () => {
    const { keepSelection } = await import('../src/client/studio-view.js')
    const saved = item('saved')
    const unsaved = item('unsaved')
    // First load after a remount: nothing known yet, the unsaved result stays.
    expect(keepSelection(unsaved, [saved], undefined)).toBe(unsaved)
    // A later refresh: still not in the gallery and never was, so it stays.
    expect(keepSelection(unsaved, [saved], new Set(['saved']))).toBe(unsaved)
    const refreshed = { ...saved, isFavorite: true }
    expect(keepSelection(saved, [refreshed], new Set(['saved']))).toBe(refreshed)
    expect(keepSelection(saved, [], new Set(['saved']))).toBeNull()
  })
})
