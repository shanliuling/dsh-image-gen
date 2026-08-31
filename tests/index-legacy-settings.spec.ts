import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-settings', () => ({
  // Absent from the real <= 0.1.1-rc.2 module; vitest throws on namespace
  // access to an unmocked key, so the key must exist to emulate a missing
  // ESM export, which reads back as undefined at runtime.
  SettingsProvider: undefined,
  settingsNamespace: (value: string) => `ns:${value}`,
  installSettingsSection: vi.fn(),
}))

import { apply } from '../src/index.js'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'

function attachment(id: string): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 12,
    width: 32,
    height: 24,
    name: 'image.png',
  }
}

function legacyHarness(): { ctx: Context; tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = []
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool) } },
    effect: (setup: () => unknown) => setup(),
    webServer: { register: vi.fn(() => () => {}) },
    credentials: { resolve: vi.fn(async () => ({ value: 'test-key' })) },
    // ctx.inject must never be reached on the legacy path.
    inject: vi.fn(),
    attachments: {
      imageLimits: {
        maxImageBytes: 10 * 1024 * 1024,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      readImage: vi.fn(),
      saveImage: vi.fn(async () => attachment('sha256:saved-image')),
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, tools }
}

describe('legacy dsh-settings (<= 0.1.1-rc.2) compatibility', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('wires the namespace through the legacy top-level relay', () => {
    const { ctx, tools } = legacyHarness()
    apply(ctx, { provider: 'google', saveToWorkspace: false })

    expect(tools.map(tool => tool.name)).toEqual(['generate_image', 'edit_image'])
    expect(installSettingsSection).toHaveBeenCalledTimes(1)
    const [relayCtx, ns, schema, entry] = vi.mocked(installSettingsSection).mock.calls[0] as unknown as [Context, string, unknown, unknown]
    expect(relayCtx).toBe(ctx)
    expect(ns).toBe('ns:image-generation')
    expect((schema as { toJSON?(): unknown }).toJSON).toBeTypeOf('function')
    expect(entry).toMatchObject({ provider: 'google', saveToWorkspace: false })
    expect(ctx.inject).not.toHaveBeenCalled()
  })

  it('never throws when the install relay itself rejects', () => {
    vi.mocked(installSettingsSection).mockImplementation(() => { throw new Error('boom') })
    const { ctx, tools } = legacyHarness()
    expect(() => apply(ctx, { provider: 'google', saveToWorkspace: false })).toThrow('boom')
    expect(tools).toHaveLength(0)
  })
})
