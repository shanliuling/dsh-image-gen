import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Neither API generation: a future dsh-settings that removed both shapes.
// The keys must exist (valued undefined) because vitest throws on namespace
// access to an unmocked key, while a real ESM export gap reads as undefined.
vi.mock('@deepseek-ai/dsh-settings', () => ({
  SettingsProvider: undefined,
  installSettingsSection: undefined,
  settingsNamespace: undefined,
}))

import { apply } from '../src/index.js'

function bareHarness(): { ctx: Context; tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = []
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool) } },
    effect: (setup: () => unknown) => setup(),
    webServer: { register: vi.fn(() => () => {}) },
    credentials: { resolve: vi.fn(async () => ({ value: 'test-key' })) },
    inject: vi.fn(),
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

describe('unsupported dsh-settings degradation', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('keeps registering tools and only warns when neither API generation exists', () => {
    const { ctx, tools } = bareHarness()

    expect(() => apply(ctx, { provider: 'google', saveToWorkspace: false })).not.toThrow()

    // Tools still work off the composition entry; the settings UI is what degrades.
    expect(tools.map(tool => tool.name)).toEqual(['generate_image', 'edit_image'])
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.logger.warn).mock.calls[0]?.[0]).toContain('neither settings API generation')
    expect(ctx.inject).not.toHaveBeenCalled()
  })
})
