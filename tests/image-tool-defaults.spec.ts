import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { SubscriptionManager } from '../src/subscription.js'

function harness() {
  const tools: any[] = []
  const contexts: Array<{ name: string; text: () => string }> = []
  const promptDisposers: Array<() => void> = []
  const credentialListeners = new Map<string, () => void>()
  const config = { provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay-generate', openaiCompatEditModel: 'relay-edit', saveToWorkspace: false }
  const ref = { attachmentId: 'sha256:source', mediaType: 'image/png', bytes: 8, width: 1, height: 1 }
  const resolveCredential = vi.fn(async () => ({ value: 'offline-test-key' } as { value: string } | undefined))
  const ctx = {
    tools: { register: (tool: unknown) => tools.push(tool) }, effect: (setup: () => unknown) => setup(),
    webServer: { register: () => () => {} }, credentials: { resolve: resolveCredential },
    inject: (services: string[], callback: (owner: unknown) => void) => {
      if (services.includes('credentials')) callback({ on: (event: string, listener: () => void) => { credentialListeners.set(event, listener) } })
      if (services.includes('settings')) callback({ settings: { installSection: vi.fn() } })
      if (services.includes('systemPrompt')) callback({
        effect: (setup: () => unknown) => {
          const dispose = setup()
          if (typeof dispose === 'function') promptDisposers.push(dispose as () => void)
        },
        systemPrompt: {
          context: (item: { name: string; text: () => string }) => {
            contexts.push(item)
            return () => { contexts.splice(contexts.indexOf(item), 1) }
          },
        },
      })
    },
    attachments: { imageLimits: { maxImageBytes: 1024, mediaTypes: ['image/png'] }, readImage: vi.fn(async () => ({ ref, data: new Uint8Array([137,80,78,71]) })), saveImage: vi.fn(async () => ref) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  apply(ctx, config as never)
  const exec = { signal: new AbortController().signal, agent: { session: { header: {}, deriveMessages: () => [{ source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] }] } } }
  return { config, contexts, promptDisposers, credentialListeners, resolveCredential, tool: (name: string) => tools.find(tool => tool.name === name), exec }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('image tool defaults and placeholders', () => {
  it('exposes live defaults and credential-free configured providers', async () => {
    const h = harness()
    const context = h.contexts.find(item => item.name === 'dsh-image-gen:image-defaults')
    expect(context).toBeDefined()
    await vi.waitFor(() => { expect(context!.text()).toContain('openai-compat (channel: default)') })
    expect(context!.text()).toContain('relay-generate')
    expect(context!.text()).toContain('relay-edit')
    expect(context!.text()).not.toContain('relay.example')
    expect(context!.text()).not.toContain('offline-test-key')
    h.config.provider = 'chatgpt-sub'
    expect(context!.text()).toContain('chatgpt-sub')
    expect(context!.text()).toContain('image_size')
    expect(context!.text()).not.toContain('relay-generate')
    h.resolveCredential.mockResolvedValue(undefined)
    h.credentialListeners.get('credentials/reference-updated')!()
    await vi.waitFor(() => { expect(context!.text()).toContain(': none.') })
    expect(context!.text()).not.toContain('offline-test-key')
  })
  it('requires an explicit user request before model arguments are supplied', () => {
    const h = harness()
    for (const name of ['generate_image', 'generate_images', 'edit_image']) {
      expect(h.tool(name).parameters.properties.model.description).toContain('OMIT unless the user explicitly requests')
    }
  })
  it('disposes image and canvas prompt contexts with their Cordis scope', () => {
    const h = harness()
    expect(h.contexts).toHaveLength(2)
    expect(h.promptDisposers).toHaveLength(2)
    for (const dispose of h.promptDisposers) dispose()
    expect(h.contexts).toHaveLength(0)
  })
  it('cleans size placeholders for subscription generation, batch and edits', async () => {
    const generate = vi.spyOn(SubscriptionManager.prototype, 'generate').mockResolvedValue([{ b64_json: 'iVBORw0KGgo=' }])
    const h = harness()
    const args = { prompt: 'boat', provider: 'chatgpt-sub', size: '  ', aspect_ratio: '1:1' }
    await h.tool('generate_image').execute(args, h.exec)
    await h.tool('generate_images').execute({ ...args, prompts: ['one', 'two'] }, h.exec)
    await h.tool('edit_image').execute(args, h.exec)
    expect(generate).toHaveBeenCalledTimes(4)
    expect(generate.mock.calls.every(([call]) => call.size === '1024x1024')).toBe(true)
  })
  it('keeps the configured provider, omits blank size/quality and selects the edit model only for edits', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const h = harness()
    const one = await h.tool('generate_image').execute({ prompt: 'boat', size: '', quality: ' ' }, h.exec)
    const edit = await h.tool('edit_image').execute({ prompt: 'blue boat', size: '', quality: ' ' }, h.exec)
    expect(one).toMatchObject({ provider: 'openai-compat', model: 'relay-generate' })
    expect(edit).toMatchObject({ provider: 'openai-compat', model: 'relay-edit' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ model: 'relay-generate', prompt: 'boat', size: '1024x1024' })
    await h.tool('edit_image').execute({ prompt: 'boat', model: 'explicit-edit' }, h.exec)
    expect((fetchMock.mock.calls[2]![1]!.body as FormData).get('model')).toBe('explicit-edit')
  })
  it('preserves explicit provider overrides and real unsupported parameter errors', async () => {
    vi.spyOn(SubscriptionManager.prototype, 'generate').mockResolvedValue([{ b64_json: 'iVBORw0KGgo=' }])
    const h = harness()
    expect(await h.tool('generate_image').execute({ prompt: 'boat', provider: 'google-sub' }, h.exec)).toMatchObject({ provider: 'google-sub' })
    await expect(h.tool('generate_image').execute({ prompt: 'boat', provider: 'chatgpt-sub', size: '', aspect_ratio: '1:1', image_size: '1K' }, h.exec)).rejects.toThrow('image_size')
    await expect(h.tool('generate_image').execute({ prompt: 'boat', provider: 'chatgpt-sub', size: '1024x1024', aspect_ratio: '1:1' }, h.exec)).rejects.toThrow('只选一个')
  })
})
