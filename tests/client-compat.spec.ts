import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as plugin from '../src/client/index.js'

interface ClientHarness {
  ctx: Context
  registrations: Map<string, () => unknown>
  injectedCredentials: () => unknown
}

function clientHarness(options: {
  connection: unknown
  remote: object
  remoteCredentials?: unknown
}): ClientHarness {
  const registrations = new Map<string, () => unknown>()
  let credentialsFace: unknown
  const slots = {
    register: vi.fn((registration: { name?: string; inject?: () => { credentials?: unknown } }) => {
      if (registration.name === 'settings.plugin.item') credentialsFace = registration.inject?.().credentials
      return vi.fn()
    }),
    inject: vi.fn((name: string, factory: () => unknown) => { registrations.set(name, factory) }),
  }
  const style = { dataset: {} as Record<string, string>, textContent: '', remove: vi.fn() }
  vi.stubGlobal('document', {
    createElement: vi.fn(() => style),
    head: { appendChild: vi.fn() },
  })

  const ctx = new Context()
  ctx.provide('slots', slots)
  ctx.provide('connection', options.connection)
  ctx.provide('remote', options.remote)
  if (options.remoteCredentials !== undefined) ctx.provide('remote.credentials', options.remoteCredentials)
  ctx.provide('settingsScope', {
    bind: vi.fn(() => ({ getSnapshot: vi.fn(), subscribe: vi.fn(), set: vi.fn() })),
  })
  ctx.provide('locale', {})
  return { ctx, registrations, injectedCredentials: () => credentialsFace }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('DSH client compatibility', () => {
  it('activates on npm DSH 0.1.1-rc.2 and adapts connection credentials', async () => {
    const describeCredential = vi.fn(async () => ({
      result: { ok: true, value: { credentials: { GEMINI_API_KEY: { configured: true } } } },
    }))
    const setCredential = vi.fn(async () => ({ result: { ok: true, value: {} } }))
    const harness = clientHarness({
      connection: { api: { credentials: { describe: describeCredential, set: setCredential } } },
      remote: {},
    })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    expect(fiber.state).toBe(2)
    const injectSettingsCard = harness.registrations.get('settings.plugin.item')
    expect(injectSettingsCard).toBeTypeOf('function')
    expect(() => injectSettingsCard?.()).not.toThrow()
    const credentials = harness.injectedCredentials() as {
      describe(refs: string[]): Promise<unknown>
      set(ref: string, value: string): Promise<unknown>
    }
    await expect(credentials.describe(['GEMINI_API_KEY'])).resolves.toEqual({
      ok: true,
      value: { GEMINI_API_KEY: { configured: true } },
    })
    await expect(credentials.set('GEMINI_API_KEY', 'test-key')).resolves.toEqual({ ok: true })
    expect(describeCredential).toHaveBeenCalledWith({ refs: ['GEMINI_API_KEY'] })
    expect(setCredential).toHaveBeenCalledWith({ ref: 'GEMINI_API_KEY', value: 'test-key' })

    await fiber.dispose()
  })

  it('uses credentials supplied by the latest DSH Remote service', async () => {
    const credentials = { describe: vi.fn(), set: vi.fn() }
    const harness = clientHarness({
      connection: {},
      remote: { credentials },
      remoteCredentials: credentials,
    })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    expect(fiber.state).toBe(2)
    const injectSettingsCard = harness.registrations.get('settings.plugin.item')
    expect(injectSettingsCard).toBeTypeOf('function')
    expect(() => injectSettingsCard?.()).not.toThrow()
    expect(harness.injectedCredentials()).toBe(credentials)

    await fiber.dispose()
  })

  it('waits for latest DSH Remote credentials without leaving the plugin pending', async () => {
    const credentials = { describe: vi.fn(), set: vi.fn() }
    const harness = clientHarness({ connection: {}, remote: {} })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    expect(fiber.state).toBe(2)
    expect(harness.registrations.has('settings.plugin.item')).toBe(false)

    harness.ctx.provide('remote.credentials', credentials)
    await vi.waitFor(() => {
      expect(harness.registrations.get('settings.plugin.item')).toBeTypeOf('function')
    })
    expect(() => harness.registrations.get('settings.plugin.item')?.()).not.toThrow()
    expect(harness.injectedCredentials()).toBe(credentials)

    await fiber.dispose()
  })
})
