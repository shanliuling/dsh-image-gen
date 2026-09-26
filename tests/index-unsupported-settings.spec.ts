import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index.js'

/**
 * Hosts whose settings service cannot take an installSection call: DSH 0.1.7
 * (SettingsForms serves the entry's Config schema through the loader, keyed by
 * entry id) and a bare host with no settings service at all (the inject
 * callback never fires). Both must boot, register tools, and stay silent —
 * the composition entry is what the settings UI degrades to, by design.
 */
function harness(options: { settingsService?: unknown } = {}): { ctx: Context; tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = []
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool) } },
    effect: (setup: () => unknown) => setup(),
    webServer: { register: vi.fn(() => () => {}) },
    credentials: { resolve: vi.fn(async () => ({ value: 'test-key' })) },
    inject: vi.fn((services: string[], callback: (owner: Context) => void) => {
      if (services.includes('settings') && options.settingsService !== undefined) {
        callback({ settings: options.settingsService } as unknown as Context)
      }
    }),
    attachments: {
      imageLimits: {
        maxImageBytes: 10 * 1024 * 1024,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      readImage: vi.fn(),
      saveImage: vi.fn(async () => ({
        attachmentId: 'sha256:saved-image', mediaType: 'image/png', bytes: 12, width: 32, height: 24,
      })),
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, tools }
}

describe('settings degradation without an installSection service', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('stays silent on a 0.1.7 settings service, which the loader serves instead', () => {
    const { ctx, tools } = harness({ settingsService: { describe: vi.fn(), update: vi.fn() } })

    expect(() => apply(ctx, { provider: 'google', saveToWorkspace: false })).not.toThrow()

    // Tools still work off the composition entry; the settings form comes from
    // the loader's projection of this entry's Config schema, so nothing here
    // registers and nothing warns.
    expect(tools.map(tool => tool.name)).toEqual(['canvas_state', 'view_canvas', 'generate_image', 'edit_image'])
    expect(ctx.inject).toHaveBeenCalledWith(['settings'], expect.any(Function))
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('degrades quietly when the host exposes no settings service', () => {
    const { ctx, tools } = harness()

    expect(() => apply(ctx, { provider: 'google', saveToWorkspace: false })).not.toThrow()

    expect(tools.map(tool => tool.name)).toEqual(['canvas_state', 'view_canvas', 'generate_image', 'edit_image'])
    expect(ctx.logger.warn).not.toHaveBeenCalled()
    // Optional service injection for the canvas system-prompt context:
    // declaring a dependency that this bare host never provides is safe (the
    // callback never fires), which is exactly the graceful degradation this
    // test guards.
    expect(ctx.inject).toHaveBeenCalledWith(['systemPrompt'], expect.any(Function))
  })
})
