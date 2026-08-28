import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../src/client/index.js'

describe('latest DSH client compatibility', () => {
  it('registers the settings card with credentials supplied by the Remote service', () => {
    const credentials = { describe: vi.fn(), set: vi.fn() }
    const registrations = new Map<string, () => unknown>()
    let injectedCredentials: unknown
    const register = vi.fn((options: { name?: string; inject?: () => { credentials?: unknown } }) => {
      if (options.name === 'settings.plugin.item') injectedCredentials = options.inject?.().credentials
      return vi.fn()
    })
    const ctx = {
      remote: { credentials },
      get: vi.fn((name: string) => name === 'connection' ? {} : undefined),
      settingsScope: { bind: vi.fn(() => ({ getSnapshot: vi.fn(), subscribe: vi.fn(), set: vi.fn() })) },
      effect: vi.fn(),
      slots: {
        register,
        inject: vi.fn((name: string, factory: () => unknown) => { registrations.set(name, factory) }),
      },
    } as unknown as Context

    apply(ctx)

    const injectSettingsCard = registrations.get('settings.plugin.item')
    expect(injectSettingsCard).toBeTypeOf('function')
    expect(() => injectSettingsCard?.()).not.toThrow()
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'settings.plugin.item', key: 'image-generation' }),
      expect.any(Function),
    )
    expect(injectedCredentials).toBe(credentials)
  })
})
