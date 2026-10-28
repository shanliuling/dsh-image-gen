import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index.js'
import { createImageResultDefinition } from '../src/client/image-result-node.js'

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

/** Tool exec carrying a latest user message with the given inline images. */
function execWithUserImages(...ids: string[]): never {
  return {
    signal: new AbortController().signal,
    agent: {
      session: {
        header: {},
        deriveMessages: () => [{
          source: { kind: 'user' },
          content: ids.map(id => ({ type: 'image', attachment: attachment(id) })),
        }],
      },
    },
  } as never
}

function harnessContext(options: { webServer?: boolean } = {}): { ctx: Context; tools: ToolDefinition[]; installSection: ReturnType<typeof vi.fn> } {
  const tools: ToolDefinition[] = []
  const installSection = vi.fn()
  const hasWebServer = options.webServer ?? true
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool) } },
    effect: (setup: () => unknown) => setup(),
    ...(hasWebServer ? { webServer: { register: vi.fn(() => () => {}) } } : {}),
    credentials: { resolve: vi.fn(async () => ({ value: 'test-key' })) },
    inject: (services: readonly string[], callback: (owner: unknown) => void) => {
      if (services.includes('webServer')) {
        if (hasWebServer) callback(ctx)
        return
      }
      if (services.includes('settings')) callback({ settings: { installSection } })
    },
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
  return { ctx, tools, installSection }
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

describe('image tool registration', () => {
  it('routes native Google generation, batch generation and edits through the configured protocol', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', googleNative: true, googleEndpoint: 'https://relay.example/v1beta', googleModel: 'gemini-3-pro-image', saveToWorkspace: false })
    const exec = { signal: new AbortController().signal } as never
    await toolByName(tools, 'generate_image').execute({ prompt: 'one' }, exec)
    await toolByName(tools, 'generate_images').execute({ prompts: ['two', 'three'], image_size: '2K', aspect_ratio: '16:9' }, exec)
    vi.mocked(ctx.attachments.readImage).mockResolvedValue({ data: new Uint8Array([137, 80, 78, 71]), ref: attachment('source') } as never)
    await toolByName(tools, 'edit_image').execute({ prompt: 'edit' }, execWithUserImages('source'))
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.every(([url]) => url === 'https://relay.example/v1beta/models/gemini-3-pro-image:generateContent')).toBe(true)
    expect(calls.map(([, init]) => JSON.parse(String(init.body)).contents[0].parts.at(-1))).toEqual([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'edit' }])
    expect(JSON.parse(String(calls[1]![1].body)).generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' })
    expect(JSON.parse(String(calls[3]![1].body)).contents[0].parts[0].inlineData).toBeDefined()
  })

  it('forwards compatible quality and generation extras through single, batch and edit tools', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay', openaiCompatQuality: 'high', openaiCompatExtraBody: { watermark: false }, openaiCompatEditFormat: 'jsonImageUrlArray', openaiCompatEditSizeMode: 'selected', saveToWorkspace: false })
    const exec = { signal: new AbortController().signal } as never
    await toolByName(tools, 'generate_image').execute({ prompt: 'one', size: '2048x1152' }, exec)
    await toolByName(tools, 'generate_images').execute({ prompts: ['two', 'three'], size: '2048x1152', quality: 'low' }, exec)
    expect(fetchMock.mock.calls.slice(0, 3).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { model: 'relay', prompt: 'one', size: '2048x1152', quality: 'high', watermark: false },
      { model: 'relay', prompt: 'two', size: '2048x1152', quality: 'low', watermark: false },
      { model: 'relay', prompt: 'three', size: '2048x1152', quality: 'low', watermark: false },
    ])
    vi.mocked(ctx.attachments.readImage).mockResolvedValue({ data: new Uint8Array([137, 80, 78, 71]), ref: attachment('source') } as never)
    await toolByName(tools, 'edit_image').execute({ prompt: 'edit', size: '2048x1152', quality: 'medium' }, execWithUserImages('source'))
    const editBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))
    expect(editBody).toMatchObject({ size: '2048x1152', quality: 'medium' })
    expect(editBody).not.toHaveProperty('watermark')
    vi.unstubAllGlobals()
  })

  it('routes a named compat channel with its own credential and returns its channel id', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'openai-compat',
      openaiCompatBaseURL: 'https://legacy.example/v1',
      openaiCompatModel: 'legacy-model',
      openaiCompatChannels: [{
        id: 'relay-b', label: 'Relay B', keyRef: '', baseURL: 'https://relay-b.example/v1', model: 'relay-b-model',
        models: ['relay-b-model'], quality: 'high', extraBody: { watermark: false },
      }],
      saveToWorkspace: false,
    })

    const result = await toolByName(tools, 'generate_image').execute(
      { prompt: 'one', channel: 'relay-b' },
      { signal: new AbortController().signal } as never,
    ) as { channel?: string }
    expect(result.channel).toBe('relay-b')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://relay-b.example/v1/images/generations')
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-key' })
    expect(JSON.parse(String(init.body))).toEqual({ model: 'relay-b-model', prompt: 'one', size: '1024x1024', quality: 'high', watermark: false })
    expect(JSON.stringify(vi.mocked(ctx.credentials.resolve).mock.calls)).toContain('DSH_IMAGE_GEN_OPENAI_COMPAT_KEY_RELAY_B')
    await expect(toolByName(tools, 'generate_image').execute(
      { prompt: 'one', channel: 'missing' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('Unknown OpenAI-compatible channel')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('applies the configured cloud timeout to conversation generation', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, tools } = harnessContext()
      let upstreamSignal: AbortSignal | null | undefined
      let started!: () => void
      const generating = new Promise<void>(resolve => { started = resolve })
      vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
        upstreamSignal = init?.signal
        started()
        upstreamSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })))
      apply(ctx, {
        provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay',
        cloudTimeoutMs: 5_000, saveToWorkspace: false,
      })

      const executing = toolByName(tools, 'generate_image').execute(
        { prompt: 'one' },
        { signal: new AbortController().signal } as never,
      )
      const rejection = expect(executing).rejects.toThrow('生图超时（5 秒未返回），请检查网络或代理后重试；上游可能已扣费或仍在生成，请到服务商后台确认')
      await generating
      await vi.advanceTimersByTimeAsync(4_999)
      expect(upstreamSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await rejection
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('does not apply the cloud timeout to ComfyUI conversation generation', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, tools } = harnessContext()
      let historySignal: AbortSignal | null | undefined
      let started!: () => void
      const polling = new Promise<void>(resolve => { started = resolve })
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
        .mockImplementationOnce((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
          historySignal = init?.signal
          started()
          historySignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })))
      apply(ctx, {
        provider: 'comfyui',
        comfyuiWorkflowJson: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }),
        cloudTimeoutMs: 5_000, comfyuiTimeoutMs: 10_000, saveToWorkspace: false,
      })

      const executing = toolByName(tools, 'generate_image').execute(
        { prompt: 'a portrait' },
        { signal: new AbortController().signal } as never,
      )
      const rejection = expect(executing).rejects.toThrow('ComfyUI generation timed out after 10000 ms')
      await polling
      await vi.advanceTimersByTimeAsync(5_000)
      expect(historySignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      await rejection
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('installs the settings section through the modern service API', () => {
    const { ctx, tools, installSection } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    expect(tools.map(tool => tool.name)).toEqual(['canvas_state', 'view_canvas', 'generate_image', 'generate_images', 'edit_image', 'find_inspiration'])
    expect(installSection).toHaveBeenCalledTimes(1)
    const [owner, ns, schema, entry, hooks] = installSection.mock.calls[0] as unknown as [Context, string, unknown, unknown, { setSource(): void; onChange(): void }]
    expect(owner).toBe(ctx)
    expect(ns).toBe('image-generation')
    expect((schema as { toJSON?(): unknown }).toJSON).toBeTypeOf('function')
    expect(entry).toMatchObject({ provider: 'google', saveToWorkspace: false })
    expect(hooks.setSource).toBeTypeOf('function')
    expect(hooks.onChange).toBeTypeOf('function')
    // setSource must rewire the live config the tools read through.
    hooks.setSource(() => ({ provider: 'openai', saveToWorkspace: false }))
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('registers canvas tools, generate_image, and edit_image', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    expect(tools.map(tool => tool.name)).toEqual(['canvas_state', 'view_canvas', 'generate_image', 'generate_images', 'edit_image', 'find_inspiration'])
  })

  it('does not require webServer, so headless, acp and sdk profiles can activate it', async () => {
    const plugin = await import('../src/index.js')
    expect(plugin.inject).not.toContain('webServer')
  })

  it('registers every tool without a webServer and mounts no routes', async () => {
    const { ctx, tools } = harnessContext({ webServer: false })
    apply(ctx, { provider: 'google', googleNative: true, googleEndpoint: 'https://relay.example/v1beta', googleModel: 'gemini-3-pro-image', saveToWorkspace: false })
    expect(tools.map(tool => tool.name)).toEqual(['canvas_state', 'view_canvas', 'generate_image', 'generate_images', 'edit_image', 'find_inspiration'])
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await toolByName(tools, 'generate_image').execute({ prompt: 'one' }, { signal: new AbortController().signal } as never)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('mounts the same HTTP routes as before when a webServer is present', () => {
    const { ctx } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const paths = vi.mocked((ctx as unknown as { webServer: { register: (route: { path: string }) => unknown } }).webServer.register).mock.calls.map(([route]) => route.path)
    expect(paths).toHaveLength(12)
    expect(new Set(paths).size).toBe(12)
  })

  it('serves reusable inspiration prompts to the agent with bounded hits', async () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const tool = toolByName(tools, 'find_inspiration')
    const value = await tool.execute({ query: '水彩', source: 'handraw-style' }, { signal: new AbortController().signal } as never) as { total: number; hits: { sourceId: string; title: string; prompt: string }[] }
    expect(value.total).toBeGreaterThan(0)
    expect(value.hits.length).toBeLessThanOrEqual(8)
    for (const hit of value.hits) {
      expect(hit.sourceId).toBe('handraw-style')
      expect(hit.prompt.length).toBeGreaterThan(0)
    }
    expect(value.hits.some(hit => `${hit.title}\n${hit.prompt}`.includes('水彩'))).toBe(true)
    const rendered = tool.output.render({}, { total: value.total, hits: value.hits } as never)
    expect(rendered[0]!.type).toBe('text')
    expect((rendered[0] as { text: string }).text).toContain(value.hits[0]!.prompt)
  })

  it('declares the ComfyUI seed in both tool output schemas', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'comfyui', saveToWorkspace: false })

    for (const name of ['generate_image', 'edit_image']) {
      const schema = toolByName(tools, name).output.schema as {
        properties?: Record<string, unknown>
      }
      expect(schema.properties?.seed).toEqual({ type: 'integer' })
    }
  })

  it('renders a real image block and exposes the full attachment id for both tools', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const ref = attachment('sha256:full-attachment-id')
    const value = { attachment: ref, provider: 'google', model: 'gemini-3.1-flash-image', output: '1:1, 1K' }

    for (const name of ['generate_image', 'edit_image']) {
      const tool = toolByName(tools, name)
      const content = tool.output.render({ prompt: 'test prompt' }, value)
      expect(content).toHaveLength(2)
      expect(content[0]).toMatchObject({ type: 'text' })
      expect(content[0]?.type === 'text' ? content[0].text : '').toContain('Attachment ID: sha256:full-attachment-id')
      expect(content[1]).toEqual({ type: 'image', attachment: ref })
    }
  })

  it('exposes provider-neutral size control on edit_image', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai', saveToWorkspace: false })
    const edit = toolByName(tools, 'edit_image')
    const parameters = edit.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toHaveProperty('size')
    expect(parameters.properties).toHaveProperty('aspect_ratio')
    expect(parameters.properties).toHaveProperty('image_size')
    expect(parameters.properties).toHaveProperty('source_attachment_ids')
    expect(parameters.properties).toHaveProperty('source_paths')
  })

  it('tells the agent to use current inline attachments without workspace discovery', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const edit = toolByName(tools, 'edit_image')

    expect(edit.description).toContain('NEVER call read_image, glob, or shell')
    expect(edit.description).toContain('call edit_image immediately with prompt only')
  })

  it('routes ComfyUI generation without resolving an API credential', async () => {
    const { ctx, tools } = harnessContext()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })))
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflowJson: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }),
      comfyuiWorkflowName: 'portrait.json',
      saveToWorkspace: false,
    })

    const value = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait' },
      { signal: new AbortController().signal } as never,
    ) as { provider: string; model: string; attachment: ImageAttachmentRef }

    expect(value).toMatchObject({ provider: 'comfyui', model: 'portrait.json', attachment: attachment('sha256:saved-image') })
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
  })

  it('runs the ComfyUI workflow named by the call instead of the active one', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflows: [
        { name: 'gen.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }) },
        { name: 'alt.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: 'ALT {{prompt}}' } } }) },
      ],
      comfyuiActiveWorkflow: 'gen.json',
      saveToWorkspace: false,
    })

    const value = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait', workflow: 'alt.json' },
      { signal: new AbortController().signal } as never,
    ) as { provider: string; model: string }

    const submitted = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as { prompt: { 6: { inputs: { text: string } } } }
    expect(submitted.prompt[6].inputs.text).toBe('ALT a portrait')
    expect(value.model).toBe('alt.json')
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
  })

  it('prepends the workflow preset before the user prompt on ComfyUI calls', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflows: [
        { name: 'gen.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }), presetPrompt: 'masterpiece, best quality, ' },
      ],
      comfyuiActiveWorkflow: 'gen.json',
      saveToWorkspace: false,
    })

    await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait' },
      { signal: new AbortController().signal } as never,
    )

    const submitted = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as { prompt: { 6: { inputs: { text: string } } } }
    expect(submitted.prompt[6].inputs.text).toBe('masterpiece, best quality, a portrait')
  })

  it('omits the separator entirely when the workflow has no preset', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflows: [
        { name: 'gen.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }), presetPrompt: '' },
      ],
      comfyuiActiveWorkflow: 'gen.json',
      saveToWorkspace: false,
    })

    await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait' },
      { signal: new AbortController().signal } as never,
    )

    const submitted = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as { prompt: { 6: { inputs: { text: string } } } }
    expect(submitted.prompt[6].inputs.text).toBe('a portrait')
  })

  it('uses the active ComfyUI workflow when the call does not name one', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflows: [
        { name: 'gen.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }) },
        { name: 'alt.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: 'ALT {{prompt}}' } } }) },
      ],
      comfyuiActiveWorkflow: 'alt.json',
      saveToWorkspace: false,
    })

    const value = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait' },
      { signal: new AbortController().signal } as never,
    ) as { model: string }

    const submitted = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as { prompt: { 6: { inputs: { text: string } } } }
    expect(submitted.prompt[6].inputs.text).toBe('ALT a portrait')
    expect(value.model).toBe('alt.json')
  })

  it('lists configured ComfyUI workflows when the call names an unknown one', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflows: [
        { name: 'gen.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }) },
        { name: 'img2img.json', json: JSON.stringify({
          1: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
          6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
        }) },
      ],
      saveToWorkspace: false,
    })

    await expect(toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait', workflow: 'missing.json' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('No ComfyUI workflow named "missing.json" is configured. Available workflows: gen.json, img2img.json.')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
  })

  it('fails clearly before image lookup when ComfyUI editing is requested', async () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'comfyui', saveToWorkspace: false })

    await expect(toolByName(tools, 'edit_image').execute(
      { prompt: 'restyle it' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('edit_image requires an active DSH agent session')
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
  })

  it('routes ComfyUI editing through upload and the imported workflow', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.readImage).mockResolvedValue({
      ref: { mediaType: 'image/png', attachmentId: 'sha256:source-image' as ImageAttachmentRef['attachmentId'], bytes: 3, width: 4, height: 4 },
      data: new Uint8Array([1, 2, 3]),
    } as never)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'source.png', subfolder: '' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 9]), { status: 200, headers: { 'content-type': 'image/png' } })))
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflowJson: JSON.stringify({
        1: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      }),
      comfyuiWorkflowName: 'img2img.json',
      saveToWorkspace: false,
    })

    const value = await toolByName(tools, 'edit_image').execute(
      { prompt: 'restyle it' },
      execWithUserImages('sha256:source-image'),
    ) as { provider: string; model: string; attachment: ImageAttachmentRef; seed?: number }

    expect(value).toMatchObject({ provider: 'comfyui', model: 'img2img.json', attachment: attachment('sha256:saved-image') })
    expect(value.seed).toBeTypeOf('number')
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
  })

  it('rejects ComfyUI editing of several images with a selector hint', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.readImage).mockResolvedValue({
      ref: { mediaType: 'image/png', attachmentId: 'sha256:a' as ImageAttachmentRef['attachmentId'], bytes: 1, width: 2, height: 2 },
      data: new Uint8Array([1]),
    } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'comfyui', saveToWorkspace: false })

    await expect(toolByName(tools, 'edit_image').execute(
      { prompt: 'restyle it' },
      execWithUserImages('sha256:a', 'sha256:b'),
    )).rejects.toThrow('exactly one source image')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['empty', { value: '' }],
    ['whitespace-only', { value: '   ' }],
  ] as const)('rejects generate_image with a user-facing hint when the credential is %s', async (_label, resolveValue) => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.credentials.resolve).mockResolvedValue(resolveValue as never)
    const fetchMock = vi.fn(() => { throw new Error('fetch must not be called') })
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', saveToWorkspace: false })

    await expect(toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('generate_image requires the Google Gemini API key; configure it in Settings > Plugins > Image generation.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects edit_image with the same provider-named hint when the credential is missing', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.readImage).mockResolvedValue({
      ref: { mediaType: 'image/png', attachmentId: 'sha256:a' as ImageAttachmentRef['attachmentId'], bytes: 1, width: 2, height: 2 },
      data: new Uint8Array([1]),
    } as never)
    vi.mocked(ctx.credentials.resolve).mockResolvedValue(undefined as never)
    const fetchMock = vi.fn(() => { throw new Error('fetch must not be called') })
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'openai', saveToWorkspace: false })

    await expect(toolByName(tools, 'edit_image').execute(
      { prompt: 'restyle it' },
      execWithUserImages('sha256:source-image'),
    )).rejects.toThrow('edit_image requires the OpenAI API key; configure it in Settings > Plugins > Image generation.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes subscription edit_image through the subscription channel with a clear not-logged-in error', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.readImage).mockResolvedValue({
      ref: { mediaType: 'image/png', attachmentId: 'sha256:a' as ImageAttachmentRef['attachmentId'], bytes: 1, width: 2, height: 2 },
      data: new Uint8Array([1]),
    } as never)
    // Every credential ref resolves empty: the subscription blob is absent,
    // so the call must fail with the login hint, not an API-key hint.
    vi.mocked(ctx.credentials.resolve).mockResolvedValue(undefined as never)
    const fetchMock = vi.fn(() => { throw new Error('fetch must not be called') })
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'chatgpt-sub', saveToWorkspace: false })

    await expect(toolByName(tools, 'edit_image').execute(
      { prompt: 'restyle it' },
      execWithUserImages('sha256:source-image'),
    )).rejects.toThrow('ChatGPT 订阅 未登录')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still generates after trimming a credential stored with surrounding whitespace', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.credentials.resolve).mockResolvedValue({ value: '  sk-live-key  ' } as never)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_image: { data: Buffer.from('fake').toString('base64'), mime_type: 'image/jpeg' },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', saveToWorkspace: false })

    const value = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait' },
      { signal: new AbortController().signal } as never,
    ) as { provider: string }
    expect(value.provider).toBe('google')
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('sk-live-key')
  })

  it('generates a batch sequentially and isolates per-item failures', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_image: { data: Buffer.from('one').toString('base64'), mime_type: 'image/jpeg' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_image: { data: Buffer.from('two').toString('base64'), mime_type: 'image/jpeg' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', saveToWorkspace: false })

    const value = await toolByName(tools, 'generate_images').execute(
      { prompts: ['first prompt', 'second prompt', 'third prompt'] },
      { signal: new AbortController().signal } as never,
    ) as { images: { prompt: string; provider: string; attachment: { attachmentId: string } }[]; failures: { index: number; error: string }[] }
    expect(value.images).toHaveLength(2)
    expect(value.images.map(image => image.prompt)).toEqual(['first prompt', 'second prompt'])
    for (const image of value.images) {
      expect(image.provider).toBe('google')
      expect(image.attachment.attachmentId).toContain('sha256:')
    }
    expect(value.failures).toEqual([{ index: 2, prompt: 'third prompt', error: expect.stringContaining('500') }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const rendered = toolByName(tools, 'generate_images').output.render({}, value as never)
    expect(rendered[0]!.type).toBe('text')
    expect((rendered[0] as { text: string }).text).toContain('Generated 2 of 3 images')
  })

  it('rejects empty and oversized generate_images batches before generating', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const tool = toolByName(tools, 'generate_images')
    await expect(tool.execute({ prompts: [] }, { signal: new AbortController().signal } as never)).rejects.toThrow('at least one prompt')
    await expect(tool.execute({ prompts: Array.from({ length: 11 }, () => 'p') }, { signal: new AbortController().signal } as never)).rejects.toThrow('at most 10')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('displays every successful batch image through native and PTC conversation results', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const tool = toolByName(tools, 'generate_images')
    const prompts = ['first prompt', 'failed prompt', 'last prompt']
    const images = [
      { attachment: attachment('sha256:first'), prompt: prompts[0], provider: 'google', model: 'gemini', output: '2:3', savedTo: 'images/first.png' },
      { attachment: attachment('sha256:last'), prompt: prompts[2], provider: 'google', model: 'gemini', output: '2:3' },
    ]
    const value = { images, failures: [{ index: 1, prompt: prompts[1], error: 'quota' }] }
    const content = tool.output.render({ prompts }, value as never)
    expect(content.filter(block => block.type === 'image')).toEqual(images.map(image => ({ type: 'image', attachment: image.attachment })))
    const meta = tool.output.presentationMeta?.({ prompts }, value as never)
    expect(meta).toMatchObject({ kind: 'dsh-image-gen-batch', images })

    const definition = createImageResultDefinition()
    const native = { type: 'tool/result', seq: 10, data: { turn: 1, meta } }
    const ptc = { type: 'tool/ptc-dispatch', seq: 11, data: {
      name: 'generate_images', subCallId: 'batch-1', arguments: { prompts }, isError: false, content,
    } }
    for (const event of [native, ptc]) {
      const identity = definition.match(event)
      expect(identity).toMatchObject({ role: 'start' })
      const match = { event, location: { kind: 'session' } }
      const context = { key: `images:${identity!.id}`, id: identity!.id, matches: [match] }
      const state = definition.start(context, match, {})
      expect(definition.buildViewNode({ ...context, state })).toMatchObject({
        anchorSeq: event.seq, location: { kind: 'session' }, data: { results: images },
      })
    }
    expect(tool.presentResult?.({ prompts }, { meta } as never)).toMatchObject({
      card: 'generic', content: images.map(image => ({ type: 'image', attachment: image.attachment })),
    })
  })

  it('reports an all-failed batch without publishing an empty image card', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const tool = toolByName(tools, 'generate_images')
    const args = { prompts: ['failed prompt'] }
    const value = { images: [], failures: [{ index: 0, prompt: 'failed prompt', error: 'quota' }] }
    const content = tool.output.render(args, value as never)
    expect(content).toEqual([{ type: 'text', text: expect.stringContaining('failed: quota') }])
    const meta = tool.output.presentationMeta?.(args, value as never)
    const definition = createImageResultDefinition()
    expect(definition.match({ type: 'tool/result', seq: 10, data: { turn: 1, meta } })).toBeNull()
    expect(definition.match({ type: 'tool/ptc-dispatch', seq: 11, data: {
      name: 'generate_images', subCallId: 'batch-1', arguments: args, isError: false, content,
    } })).toBeNull()
    expect(tool.presentResult?.(args, { meta } as never)).toBeUndefined()
  })

  it('honours a per-call provider override without touching the saved config', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('openai')
        ? { data: [{ b64_json: Buffer.from('fake').toString('base64') }] }
        : { output_image: { data: Buffer.from('fake').toString('base64'), mime_type: 'image/jpeg' } }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', saveToWorkspace: false })

    const value = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait', provider: 'openai', model: 'gpt-image-1.5-max' },
      { signal: new AbortController().signal } as never,
    ) as { provider: string; model: string }

    expect(value).toMatchObject({ provider: 'openai', model: 'gpt-image-1.5-max' })
    const url = String(fetchMock.mock.calls[0]?.[0])
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as { model: string }
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect(body.model).toBe('gpt-image-1.5-max')
    // The default provider in settings stays untouched for later calls.
    const next = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait' },
      { signal: new AbortController().signal } as never,
    ) as { provider: string }
    expect(next.provider).toBe('google')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('https://generativelanguage.googleapis.com')
  })

  it('rejects an unknown provider override with the supported list before any request', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(() => { throw new Error('fetch must not be called') })
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', saveToWorkspace: false })

    // The declared enum makes the framework reject unknown providers with the full list.
    await expect(toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait', provider: 'midjourney' } as never,
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('"provider" must be one of')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes a per-call ComfyUI provider override to the configured workflow', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'google',
      comfyuiWorkflowJson: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }),
      comfyuiWorkflowName: 'portrait.json',
      saveToWorkspace: false,
    })

    const value = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait', provider: 'comfyui' },
      { signal: new AbortController().signal } as never,
    ) as { provider: string; model: string }

    expect(value).toMatchObject({ provider: 'comfyui', model: 'portrait.json' })
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
  })
})
