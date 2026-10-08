import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSettingsHealth, settingsState } from '../src/client/settings-state.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('settings capability diagnostics', () => {
  it('identifies the incompatible modern schema and retains legacy compatibility', () => {
    const snapshot = { value: undefined, writable: true, status: 'unavailable' as const }
    expect(settingsState(snapshot, { settings: 'live', liveSchema: false })).toBe('incompatible')
    expect(settingsState({ value: {}, writable: true }, { settings: 'legacy', liveSchema: false })).toBe('ready')
  })

  it('keeps a remote connection read-only even with a healthy host schema', () => {
    expect(settingsState({ value: {}, writable: true, mode: 'memory' }, { settings: 'live', liveSchema: true })).toBe('remote')
  })

  it('accepts only the non-secret host capability response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ settings: 'live', liveSchema: false }))))
    expect(await fetchSettingsHealth(new AbortController().signal)).toEqual({ settings: 'live', liveSchema: false })
  })

  it.each([null, {}, { settings: 'other', liveSchema: false }, { settings: 'live', liveSchema: 'false' }])('does not diagnose a dependency problem from malformed data: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
    expect(await fetchSettingsHealth(new AbortController().signal)).toBeUndefined()
  })

  it('preserves the host state when an older server has no probe route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const health = await fetchSettingsHealth(new AbortController().signal)
    expect(health).toBeUndefined()
    expect(settingsState({ value: {}, writable: true, status: 'ready', mode: 'host' }, health)).toBe('ready')
  })
})
