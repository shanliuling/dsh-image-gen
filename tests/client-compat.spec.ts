import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as plugin from '../src/client/index.js'
import { imageRef } from '../src/client/image-ref.js'
import { IMAGE_RESULT_NODE_KIND } from '../src/client/image-result-node.js'

const imageResultNodeShape = expect.objectContaining({
  kind: IMAGE_RESULT_NODE_KIND,
  target: 'chat',
})

interface ClientHarness {
  ctx: Context
  registrations: Map<string, () => unknown>
  slotInjections: Array<{ name: string; factory: () => unknown }>
  slotRegistrations: Array<{ options: Record<string, unknown>; component: unknown }>
  injectedCredentials: () => unknown
  settingsFace: () => { credentials?: unknown; credentialsAvailable?: () => boolean } | undefined
  legacyBind: ReturnType<typeof vi.fn>
}

function clientHarness(options: {
  connection: unknown
  remote: object
  remoteCredentials?: unknown
  uiConversation?: unknown
  /** Settings service generation the host ships; DSH 0.1.7+: configForms, 0.1.5/0.1.6: settingsScope. */
  settingsGeneration?: 'configForms' | 'settingsScope' | 'none'
}): ClientHarness {
  const registrations = new Map<string, () => unknown>()
  const slotInjections: Array<{ name: string; factory: () => unknown }> = []
  const slotRegistrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
  let credentialsFace: unknown
  let face: { credentials?: unknown; credentialsAvailable?: () => boolean } | undefined
  const slots = {
    register: vi.fn((registration: { name?: string; inject?: () => { credentials?: unknown; credentialsAvailable?: () => boolean } }, component: unknown) => {
      if (registration.name === 'settings.plugins.tab') {
        face = registration.inject?.()
        credentialsFace = face?.credentials
      }
      slotRegistrations.push({ options: registration as Record<string, unknown>, component })
      return vi.fn()
    }),
    inject: vi.fn((name: string, factory: () => unknown) => {
      registrations.set(name, factory)
      slotInjections.push({ name, factory })
    }),
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
  if (options.uiConversation !== undefined) ctx.provide('uiConversation', options.uiConversation)
  const legacyBind = vi.fn((options_: { namespace: string }) => ({
    getSnapshot: vi.fn(() => ({ value: undefined, writable: true })),
    subscribe: vi.fn(),
    set: vi.fn(async () => {}),
  }))
  const generation = options.settingsGeneration ?? 'configForms'
  if (generation === 'configForms') {
    ctx.provide('configForms', {
      get: vi.fn(() => ({ getSnapshot: vi.fn(() => ({ value: undefined })), subscribe: vi.fn(), set: vi.fn() })),
    })
  } else if (generation === 'settingsScope') {
    ctx.provide('settingsScope', { bind: legacyBind })
  }
  ctx.provide('locale', {})
  return { ctx, registrations, slotInjections, slotRegistrations, injectedCredentials: () => credentialsFace, settingsFace: () => face, legacyBind }
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
    const injectSettingsCard = harness.registrations.get('settings.plugins.tab')
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

  it('binds the legacy settingsScope namespaces on hosts without configForms', async () => {
    const harness = clientHarness({
      connection: {},
      remote: { credentials: { describe: vi.fn(), set: vi.fn() } },
      settingsGeneration: 'settingsScope',
    })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    // DSH 0.1.5/0.1.6: no configForms service exists, so the plugin must probe
    // settingsScope and bind both namespaces through it (issue #55 in reverse).
    expect(fiber.state).toBe(2)
    expect(harness.legacyBind).toHaveBeenCalledWith({ namespace: 'image-generation' })
    expect(harness.legacyBind).toHaveBeenCalledWith({ namespace: 'ui-chat' })
    const injectSettingsCard = harness.registrations.get('settings.plugins.tab')
    expect(() => injectSettingsCard?.()).not.toThrow()

    await fiber.dispose()
  })

  it('degrades to a read-only scope when the host has no settings service', async () => {
    const harness = clientHarness({
      connection: {},
      remote: { credentials: { describe: vi.fn(), set: vi.fn() } },
      settingsGeneration: 'none',
    })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    // Neither generation: the fiber still mounts and the card degrades its
    // settings UI instead of parking or crashing.
    expect(fiber.state).toBe(2)
    expect(harness.legacyBind).not.toHaveBeenCalled()
    const injectSettingsCard = harness.registrations.get('settings.plugins.tab')
    expect(() => injectSettingsCard?.()).not.toThrow()
    const scope = (harness.settingsFace() as unknown as { scope: { getSnapshot(): unknown } }).scope
    expect(scope.getSnapshot()).toEqual({ value: undefined, writable: false })
    await expect(scope.set('provider', 'google' as never)).resolves.toBe(false)

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
    const injectSettingsCard = harness.registrations.get('settings.plugins.tab')
    expect(injectSettingsCard).toBeTypeOf('function')
    expect(() => injectSettingsCard?.()).not.toThrow()
    // The face carries a stable delegating proxy, never the raw remote: the
    // host caches inject results, so identity must not change per render.
    expect(harness.injectedCredentials()).not.toBe(credentials)
    expect(harness.settingsFace()?.credentialsAvailable?.()).toBe(true)

    await fiber.dispose()
  })

  it('promotes image results only when modern DSH exposes uiConversation events', async () => {
    const registerEvent = vi.fn((_definition: unknown) => vi.fn())
    const harness = clientHarness({
      connection: {},
      remote: { credentials: { describe: vi.fn(), set: vi.fn() } },
      uiConversation: { events: { register: registerEvent } },
    })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    expect(registerEvent).toHaveBeenCalledWith(imageResultNodeShape)
    const definition = registerEvent.mock.calls[0]?.[0] as {
      buildViewNode(context: unknown): { anchorSeq: number } | null
    }
    // The ui-chat form has not loaded in this harness. Keep a finished image
    // beside the answer until its transcript mode is known.
    expect(definition.buildViewNode({
      key: 'image:1', id: '1', matches: [],
      state: { results: [{ seq: 4 }], answerSeq: 7, endSeq: 8 },
    })).toMatchObject({ anchorSeq: 7 })
    expect(harness.slotInjections.some(injection => injection.name === 'conversation.chat.node')).toBe(true)

    for (const injection of harness.slotInjections.filter(candidate => candidate.name === 'tool.call.toolview')) {
      injection.factory()
    }
    const toolRegistrations = harness.slotRegistrations.filter(({ options }) =>
      options.name === 'tool.call.toolview')
    expect(toolRegistrations).toHaveLength(2)
    for (const { options } of toolRegistrations) {
      expect((options.inject as () => unknown)()).toMatchObject({ promoted: true })
    }

    await fiber.dispose()
  })

  it('keeps the legacy tool card when modern conversation events are absent', async () => {
    const harness = clientHarness({ connection: {}, remote: { credentials: { describe: vi.fn(), set: vi.fn() } } })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    expect(harness.slotInjections.some(injection => injection.name === 'conversation.chat.node')).toBe(false)
    for (const injection of harness.slotInjections.filter(candidate => candidate.name === 'tool.call.toolview')) {
      injection.factory()
    }
    for (const { options } of harness.slotRegistrations.filter(({ options }) => options.name === 'tool.call.toolview')) {
      expect((options.inject as () => unknown)()).toMatchObject({ promoted: false })
    }

    await fiber.dispose()
  })

  it('activates promotion when uiConversation is provided after plugin startup', async () => {
    const registerEvent = vi.fn(() => vi.fn())
    const harness = clientHarness({ connection: {}, remote: { credentials: { describe: vi.fn(), set: vi.fn() } } })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()
    expect(registerEvent).not.toHaveBeenCalled()

    harness.ctx.provide('uiConversation', { events: { register: registerEvent } })
    await vi.waitFor(() => {
      expect(registerEvent).toHaveBeenCalledWith(imageResultNodeShape)
    })
    expect(harness.slotInjections.some(injection => injection.name === 'conversation.chat.node')).toBe(true)

    for (const injection of harness.slotInjections.filter(candidate => candidate.name === 'tool.call.toolview')) {
      injection.factory()
    }
    for (const { options } of harness.slotRegistrations.filter(({ options }) => options.name === 'tool.call.toolview')) {
      expect((options.inject as () => unknown)()).toMatchObject({ promoted: true })
    }

    await fiber.dispose()
  })

  it('waits for latest DSH Remote credentials without leaving the plugin pending', async () => {
    const credentials = { describe: vi.fn(async () => ({ ok: false })), set: vi.fn(async () => ({ ok: true })) }
    const harness = clientHarness({ connection: {}, remote: {} })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    expect(fiber.state).toBe(2)
    // #32 regression guard: the settings card and the composer pill mount even
    // before any credentials service exists; only the key UI degrades.
    expect(harness.registrations.has('settings.plugins.tab')).toBe(true)
    // Hosts that predate the Plugins tab row only ship the per-plugin seat;
    // the same build must keep the card reachable there.
    expect(harness.registrations.has('settings.plugin.item')).toBe(true)
    expect(harness.registrations.has('conversation.input.right')).toBe(true)
    expect(() => harness.registrations.get('settings.plugins.tab')?.()).not.toThrow()
    // The legacy per-plugin seat must stay mountable on the very same build.
    expect(() => harness.registrations.get('settings.plugin.item')?.()).not.toThrow()
    expect(harness.settingsFace()?.credentialsAvailable?.()).toBe(false)
    const degraded = harness.injectedCredentials() as {
      describe(refs: string[]): Promise<unknown>
      set(ref: string, value: string): Promise<unknown>
    }
    await expect(degraded.describe(['GEMINI_API_KEY'])).resolves.toEqual({ ok: false })
    await expect(degraded.set('GEMINI_API_KEY', 'test-key')).resolves.toMatchObject({ ok: false })

    harness.ctx.provide('remote.credentials', credentials)
    await vi.waitFor(() => {
      expect(harness.settingsFace()?.credentialsAvailable?.()).toBe(true)
    })
    // The same stable proxy now delegates to the late service.
    expect(harness.injectedCredentials()).toBe(degraded)
    await expect(degraded.describe(['GEMINI_API_KEY'])).resolves.toEqual({ ok: false })
    expect(credentials.describe).toHaveBeenCalledWith(['GEMINI_API_KEY'])

    await fiber.dispose()
  })

  it('mounts the settings card on cores that never expose a credentials service (#32)', async () => {
    const harness = clientHarness({ connection: {}, remote: {} })

    const fiber = harness.ctx.plugin(plugin)
    await fiber.await()

    expect(fiber.state).toBe(2)
    expect(harness.registrations.get('settings.plugins.tab')).toBeTypeOf('function')
    expect(() => harness.registrations.get('settings.plugins.tab')?.()).not.toThrow()
    expect(harness.registrations.has('conversation.input.right')).toBe(true)
    // The key UI reports the degraded state instead of hiding the card.
    expect(harness.settingsFace()?.credentialsAvailable?.()).toBe(false)
    const degraded = harness.injectedCredentials() as {
      describe(refs: string[]): Promise<unknown>
    }
    await expect(degraded.describe(['GEMINI_API_KEY'])).resolves.toEqual({ ok: false })

    await fiber.dispose()
  })

  describe('imageRef dual-path compatibility', () => {
    const attachment = {
      attachmentId: 'sha256:test1234',
      mediaType: 'image/jpeg' as const,
      bytes: 4096,
      width: 512,
      height: 512,
    }

    it('resolves image attachment from legacy rc.2 resultView.content', () => {
      const block = {
        kind: 'tool-result' as const,
        seq: 1,
        time: 1000,
        callId: 'call-1',
        call: { name: 'generate_image', argsRaw: '{}' },
        callTime: 900,
        content: [{ type: 'text' as const, text: 'Generated one image' }],
        isError: false,
        callView: null,
        resultView: {
          card: 'generic' as const,
          title: 'Generated image',
          content: [{ type: 'image' as const, attachment }],
        },
        subCalls: [],
      }
      expect(imageRef(block)).toEqual(attachment)
    })

    it('resolves image attachment from new DSH block.content without resultView fields', () => {
      const block = {
        kind: 'tool-result' as const,
        seq: 2,
        time: 2000,
        callId: 'call-2',
        call: { name: 'generate_image', argsRaw: '{}' },
        callTime: 1900,
        content: [
          { type: 'text' as const, text: 'Generated one image' },
          { type: 'image' as const, attachment },
        ],
        isError: false,
        subCalls: [],
      }
      expect(imageRef(block as never)).toEqual(attachment)
    })

    it('returns undefined while tool is running or when no image exists', () => {
      const runningCall = {
        callId: 'call-3',
        name: 'generate_image',
        argsRaw: '{}',
        turn: 1,
        step: 1,
        time: 3000,
        subCalls: [],
      }
      expect(imageRef(runningCall as never)).toBeUndefined()

      const textOnlyResult = {
        kind: 'tool-result' as const,
        seq: 4,
        time: 4000,
        callId: 'call-4',
        call: { name: 'generate_image', argsRaw: '{}' },
        callTime: 3900,
        content: [{ type: 'text' as const, text: 'no image' }],
        isError: false,
        subCalls: [],
      }
      expect(imageRef(textOnlyResult as never)).toBeUndefined()
    })
  })
})
