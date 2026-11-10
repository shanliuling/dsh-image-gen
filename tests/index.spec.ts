import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { gifBytes } from './gif-fixture.js'
import { THUMB_ROUTE, VAULT_DELETE_ROUTE, VAULT_REFS_ROUTE, ZIP_ROUTE } from '../src/shared.js'
import { createImageResultDefinition, imageResultsFromPtcDispatch } from '../src/client/image-result-node.js'

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

  it('gives a conversation GIF the longer GIF timeout while the cloud timeout is left at its default', async () => {
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
      apply(ctx, { provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay', saveToWorkspace: false })

      const executing = toolByName(tools, 'generate_image').execute(
        { prompt: 'one', output_format: 'gif' },
        { signal: new AbortController().signal } as never,
      )
      const rejection = expect(executing).rejects.toThrow('生图超时（300 秒未返回）')
      await generating
      await vi.advanceTimersByTimeAsync(299_999)
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
    expect(paths).toHaveLength(21)
    expect(new Set(paths).size).toBe(21)
    expect(paths).toContain(ZIP_ROUTE)
    expect(paths).toContain(THUMB_ROUTE)
    expect(paths).toContain(VAULT_DELETE_ROUTE)
    expect(paths).toContain(VAULT_REFS_ROUTE)
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

  it('tells the model when a ComfyUI workflow cannot take the requested size (#97)', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': { status: { status_str: 'success', completed: true }, outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflows: [{ name: 'fixed.json', json: JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }) }],
      comfyuiActiveWorkflow: 'fixed.json',
      saveToWorkspace: false,
    })

    const generate = toolByName(tools, 'generate_image')
    const args = { prompt: 'a portrait', aspect_ratio: '16:9' }
    const value = await generate.execute(args, { signal: new AbortController().signal } as never) as { notice?: string }

    expect(value.notice).toContain('the requested 16:9 was not applied')
    const rendered = (generate.output as { render: (a: unknown, v: unknown) => { type: string; text?: string }[] }).render(args, value)
    expect(rendered[0]?.text).toContain('sets its own frame size')
  })

  it('injects the requested aspect ratio into ComfyUI width and height placeholders', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': { status: { status_str: 'success', completed: true }, outputs: { save: { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] } } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflows: [{ name: 'sized.json', json: JSON.stringify({
        5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      }) }],
      comfyuiActiveWorkflow: 'sized.json',
      saveToWorkspace: false,
    })

    const value = await toolByName(tools, 'generate_image').execute(
      { prompt: 'a portrait', aspect_ratio: '9:16' },
      { signal: new AbortController().signal } as never,
    ) as { notice?: string }

    const submitted = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as { prompt: { 5: { inputs: { width: number; height: number } } } }
    expect(submitted.prompt[5].inputs).toEqual({ width: 768, height: 1344 })
    expect(value.notice).toBeUndefined()
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

  it('rejects ComfyUI editing whose image count does not match the workflow before uploading', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.readImage).mockResolvedValue({
      ref: { mediaType: 'image/png', attachmentId: 'sha256:a' as ImageAttachmentRef['attachmentId'], bytes: 1, width: 2, height: 2 },
      data: new Uint8Array([1]),
    } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, {
      provider: 'comfyui',
      comfyuiWorkflowJson: JSON.stringify({ 1: { class_type: 'LoadImage', inputs: { image: '{{image}}' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }),
      comfyuiWorkflowName: 'img2img.json',
      saveToWorkspace: false,
    })

    await expect(toolByName(tools, 'edit_image').execute(
      { prompt: 'restyle it' },
      execWithUserImages('sha256:a', 'sha256:b'),
    )).rejects.toThrow('this call has 2 source image(s); pass exactly 1')
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

describe('GIF output through the conversation tools', () => {
  const gifResponse = (frames = 2) => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(gifBytes(frames)).toString('base64') }] }), { headers: { 'content-type': 'application/json' } })
  const pngResponse = () => new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), { headers: { 'content-type': 'application/json' } })
  const exec = () => ({ signal: new AbortController().signal }) as never
  const compatConfig = { provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay', saveToWorkspace: false } as const
  const stillNote = 'Requested a GIF, but the provider returned a still image (no animation frames); the model or relay may not support GIF output.'
  const baseText = (savedTo?: string) => `Generated one image with openai-compat/relay (auto). Attachment ID: sha256:gif. It is already attached to the conversation.${savedTo === undefined ? ' It has no local file path.' : ` It was also saved to the workspace as ${savedTo}.`} Respond to the user without reading or searching for the image.`
  const gifValue = (overrides: Record<string, unknown> = {}) => ({
    attachment: { ...attachment('sha256:gif'), mediaType: 'image/webp' as const },
    provider: 'openai-compat', model: 'relay', output: 'auto',
    animation: { frames: 8, frameDurationMs: 120, durationMs: 960 },
    ...overrides,
  })
  function renderText(tools: ToolDefinition[], name: string, args: unknown, value: unknown): string {
    const content = toolByName(tools, name).output.render(args, value as never)
    const block = content[0]
    return block?.type === 'text' ? block.text : ''
  }

  it('rejects GIF parameters on providers without an OpenAI images contract before any request', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    for (const args of [{ output_format: 'gif' }, { frame_count: 4 }, { frame_duration_ms: 100 }]) {
      await expect(toolByName(tools, 'generate_image').execute({ prompt: 'wave', ...args }, exec())).rejects.toThrow('only supported with provider=openai or openai-compat')
    }
    await expect(toolByName(tools, 'generate_images').execute({ prompts: ['wave'], output_format: 'gif' }, exec())).resolves.toMatchObject({ failures: [{ index: 0, error: expect.stringContaining('provider=openai or openai-compat') }] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends GIF fields after the channel extras and omits the default size for a GIF', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => gifResponse())
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { ...compatConfig, openaiCompatExtraBody: { watermark: false, frame_count: 8 } })
    const value = await toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif', frame_count: 4, frame_duration_ms: 120 }, exec()) as { output: string; animation?: unknown }
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ model: 'relay', prompt: 'wave', watermark: false, output_format: 'gif', frame_count: 4, frame_duration_ms: 120 })
    expect(value.output).toBe('auto')
    expect(value.animation).toEqual({ frames: 2, frameDurationMs: 100, durationMs: 200 })

    await toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif', size: '768x768', quality: 'low' }, exec())
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ size: '768x768', quality: 'low', output_format: 'gif' })

    fetchMock.mockResolvedValueOnce(pngResponse())
    const still = await toolByName(tools, 'generate_image').execute({ prompt: 'wave' }, exec()) as { output: string; animation?: unknown }
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ model: 'relay', prompt: 'wave', size: '1024x1024', watermark: false, frame_count: 8 })
    expect(still.output).toBe('1024x1024')
    expect(still).not.toHaveProperty('animation')
    // An empty placeholder never reaches the request: the declared enum rejects it like an unknown provider.
    await expect(toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: '' } as never, exec())).rejects.toThrow('"output_format" must be one of')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats a channel configured for GIF output as a GIF request: no default size, and frame parameters alone are accepted', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => gifResponse())
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { ...compatConfig, openaiCompatExtraBody: { output_format: 'gif', frame_count: 8 }, openaiCompatQuality: 'low' })
    const value = await toolByName(tools, 'generate_image').execute({ prompt: 'wave' }, exec()) as { output: string }
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ model: 'relay', prompt: 'wave', quality: 'low', output_format: 'gif', frame_count: 8 })
    expect(value.output).toBe('auto, quality=low')
    // The channel already asked for a GIF, so a call that only tunes the frames must not be told to add output_format.
    await toolByName(tools, 'generate_image').execute({ prompt: 'wave', frame_count: 4, frame_duration_ms: 120 }, exec())
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ model: 'relay', prompt: 'wave', quality: 'low', output_format: 'gif', frame_count: 4, frame_duration_ms: 120 })
  })

  it('returns an SVG as markup plus a saved .svg file instead of a chat attachment', async () => {
    const { ctx, tools } = harnessContext()
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#F59E0B"/></svg>'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(svg).toString('base64') }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-svg-'))
    apply(ctx, { ...compatConfig, saveToWorkspace: true })
    const svgExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } } } as never
    const value = await toolByName(tools, 'generate_image').execute({ prompt: 'icon', output_format: 'svg', size: '1024x1024' }, svgExec) as { svg?: string; savedTo?: string; attachment?: unknown; notice?: string; output: string; svgBytes?: number }
    // A vector result carries no pixel size, so the still-image default never reaches the request.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ model: 'relay', prompt: 'icon', output_format: 'svg' })
    expect(value.output).toBe('svg')
    expect(value.svg).toBe(svg)
    expect(value.svgBytes).toBe(Buffer.byteLength(svg))
    expect(value.attachment).toBeUndefined()
    expect(value.savedTo?.endsWith('.svg')).toBe(true)
    expect(await readFile(String(value.savedTo), 'utf8')).toBe(svg)
    expect(value.notice).toContain('do not apply to an SVG')
    expect(ctx.attachments.saveImage).not.toHaveBeenCalled()
    expect(renderText(tools, 'generate_image', { prompt: 'icon', output_format: 'svg' }, value)).toContain('the conversation card renders it directly from this markup')
    const content = toolByName(tools, 'generate_image').output.render({ prompt: 'icon', output_format: 'svg' }, value as never)
    expect(content.map(block => block.type)).toEqual(['text', 'text'])
    expect(content[1]).toEqual({ type: 'text', text: svg })
    await rm(workspace, { recursive: true, force: true })
  })

  it('reports a raster result when the relay ignores output_format=svg', async () => {
    const { ctx, tools } = harnessContext()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { ...compatConfig })
    const value = await toolByName(tools, 'generate_image').execute({ prompt: 'icon', output_format: 'svg' }, exec()) as { svg?: string; output: string; notice?: string }
    expect(value.svg).toBeUndefined()
    expect(value.output).toBe('auto')
    expect(value.notice).toContain('returned a PNG raster image')
  })

  it('checks an official GIF frame size by the per-frame contract and forwards the GIF fields', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => gifResponse())
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, { provider: 'openai', openaiModel: 'gpt-image-2', saveToWorkspace: false })
    await toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif', frame_count: 2, size: '768x768' }, exec())
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ model: 'gpt-image-2', prompt: 'wave', size: '768x768', output_format: 'gif', frame_count: 2 })
    await expect(toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif', size: '1000x1000' }, exec())).rejects.toThrow('16 的倍数')
    await expect(toolByName(tools, 'generate_image').execute({ prompt: 'wave', size: '768x768' }, exec())).rejects.toThrow('尺寸')
    await expect(toolByName(tools, 'generate_image').execute({ prompt: 'wave', frame_count: 4 }, exec())).rejects.toThrow('output_format=gif')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats a single-frame GIF as a still image and fills the animation summary for every GIF in a batch', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => gifResponse(1))
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, compatConfig)
    const args = { prompt: 'wave', output_format: 'gif', frame_count: 2 }
    const single = await toolByName(tools, 'generate_image').execute(args, exec()) as Record<string, unknown>
    expect(single).not.toHaveProperty('animation')
    expect(renderText(tools, 'generate_image', args, single)).toContain(stillNote)

    fetchMock.mockImplementation(async () => gifResponse(3))
    const batchArgs = { prompts: ['one', 'two'], output_format: 'gif', frame_count: 3 }
    const batch = await toolByName(tools, 'generate_images').execute(batchArgs, exec()) as { images: { animation?: unknown }[] }
    expect(batch.images.map(image => image.animation)).toEqual([{ frames: 3, frameDurationMs: 100, durationMs: 300 }, { frames: 3, frameDurationMs: 100, durationMs: 300 }])
    const texts = toolByName(tools, 'generate_images').output.render(batchArgs, batch as never).flatMap(block => block.type === 'text' ? [block.text] : [])
    expect(texts.filter(text => text.includes('animated GIF: 3 frames × 100 ms (0.3s loop)'))).toHaveLength(2)
    expect(texts.some(text => text.includes('Requested'))).toBe(false)
  })

  it('declares the animation summary in both tool output schemas with closed object nodes', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai', saveToWorkspace: false })
    // defineTool projects the authoring DSL into JSON Schema, so the node is compared in that form.
    const expected = { type: 'object', additionalProperties: false, properties: { frames: { type: 'integer' }, frameDurationMs: { type: 'integer' }, durationMs: { type: 'integer' } }, required: ['frames', 'frameDurationMs', 'durationMs'] }
    const single = toolByName(tools, 'generate_image').output.schema as { properties?: Record<string, unknown> }
    expect(single.properties?.animation).toEqual(expected)
    const batch = toolByName(tools, 'generate_images').output.schema as { properties?: { images?: { items?: { properties?: Record<string, unknown> } } } }
    expect(batch.properties?.images?.items?.properties?.animation).toEqual(expected)
  })

  it('keeps the fixed summary sentence and appends the animation facts with a workspace embed', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai-compat', saveToWorkspace: false })
    const text = renderText(tools, 'generate_image', { prompt: 'wave', output_format: 'gif' }, gifValue({ savedTo: '/ws/images/image-abc.gif' }))
    expect(text.startsWith(baseText('/ws/images/image-abc.gif'))).toBe(true)
    expect(text).toContain('animated GIF: 8 frames × 120 ms (0.96s loop)')
    expect(text).toContain('do not regenerate or redraw individual frames')
    expect(text).toContain('The attached preview shows only its first frame.')
    expect(text).toContain('![animated GIF](</ws/images/image-abc.gif>)')
    expect(text).not.toContain('Requested')
  })

  it('writes the embed path with forward slashes without touching the savedTo field', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai-compat', saveToWorkspace: false })
    const value = gifValue({ savedTo: 'C:\\Users\\me\\_proj\\image.gif' })
    const text = renderText(tools, 'generate_image', { prompt: 'wave' }, value)
    expect(text).toContain('saved to the workspace as C:\\Users\\me\\_proj\\image.gif.')
    expect(text).toContain('![animated GIF](<C:/Users/me/_proj/image.gif>)')
    expect(value.savedTo).toBe('C:\\Users\\me\\_proj\\image.gif')
  })

  it('skips the embed and the first-frame note when there is no file or the attachment is itself a GIF', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai-compat', saveToWorkspace: false })
    const unsaved = renderText(tools, 'generate_image', { prompt: 'wave' }, gifValue())
    expect(unsaved).toContain('The attached preview shows only its first frame.')
    expect(unsaved).not.toContain('![animated GIF]')
    // A GIF attachment animates on every card, so the embed would show it twice.
    const native = renderText(tools, 'generate_image', { prompt: 'wave' }, gifValue({ attachment: { ...attachment('sha256:gif'), mediaType: 'image/gif' }, savedTo: '/ws/a.gif' }))
    expect(native).toContain('animated GIF: 8 frames')
    expect(native).not.toContain('first frame')
    expect(native).toContain('The result card in the conversation already plays the animation and where it was saved; do not embed the image or link its file in your reply unless the user asks.')
    expect(native).not.toContain('![animated GIF]')
  })

  it('tells the model when the provider ignored the requested frame parameters or returned a still image', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai-compat', saveToWorkspace: false })
    const frames = renderText(tools, 'generate_image', { prompt: 'wave', output_format: 'gif', frame_count: 4 }, gifValue())
    expect(frames).toContain('Requested 4 frames but received 8; the provider may have ignored the GIF parameters.')
    const timing = renderText(tools, 'generate_image', { prompt: 'wave', output_format: 'gif', frame_duration_ms: 205 }, gifValue())
    expect(timing).toContain('Requested 205 ms per frame but received 120 ms; the provider may have ignored the GIF parameters.')
    const both = renderText(tools, 'generate_image', { prompt: 'wave', output_format: 'gif', frame_count: 4, frame_duration_ms: 205 }, gifValue())
    expect(both).toContain('Requested 4 frames but received 8. Requested 205 ms per frame but received 120 ms; the provider may have ignored the GIF parameters.')
    // GIF delays are stored in 10 ms ticks: anything short of a full tick is the provider's rounding, whichever way it rounds.
    for (const requested of [123, 125, 115]) {
      expect(renderText(tools, 'generate_image', { prompt: 'wave', output_format: 'gif', frame_count: 8, frame_duration_ms: requested }, gifValue())).not.toContain('Requested')
    }
    const tick = renderText(tools, 'generate_image', { prompt: 'wave', output_format: 'gif', frame_duration_ms: 130 }, gifValue())
    expect(tick).toContain('Requested 130 ms per frame but received 120 ms')
    const still = renderText(tools, 'generate_image', { prompt: 'wave', output_format: 'gif' }, gifValue({ animation: undefined, attachment: attachment('sha256:gif') }))
    expect(still).toContain(stillNote)
    expect(still).not.toContain('animated GIF')
  })

  it('survives PTC dispatch parsing with the animation notes appended to the fixed summary', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai-compat', saveToWorkspace: false })
    const args = { prompt: 'a waving cat', output_format: 'gif', frame_count: 8 }
    const original = { key: 'a'.repeat(64), bytes: 500, mediaType: 'image/gif' }
    const content = toolByName(tools, 'generate_image').output.render(args, gifValue({ savedTo: '/ws/images/image-1.gif', original }) as never)
    const definition = createImageResultDefinition()
    const event = { type: 'tool/ptc-dispatch', seq: 21, data: { name: 'generate_image', subCallId: 'sub-2', arguments: args, isError: false, content } }
    const identity = definition.match(event)
    expect(identity).toMatchObject({ role: 'start' })
    const match = { event, location: { kind: 'session' } }
    const context = { key: `images:${identity!.id}`, id: identity!.id, matches: [match] }
    const state = definition.start(context, match, {})
    expect(definition.buildViewNode({ ...context, state })).toMatchObject({
      data: { results: [{ prompt: 'a waving cat', provider: 'openai-compat', model: 'relay', output: 'auto', savedTo: '/ws/images/image-1.gif' }] },
    })
  })

  it('tells the model the card already shows a still image and its saved file, adding nothing else', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai-compat', saveToWorkspace: false })
    const value = { attachment: attachment('sha256:gif'), provider: 'openai-compat', model: 'relay', output: 'auto' }
    expect(renderText(tools, 'generate_image', { prompt: 'wave' }, value)).toBe(`${baseText()} The result card in the conversation already shows the image; do not embed the image or link its file in your reply unless the user asks.`)
    expect(renderText(tools, 'generate_image', { prompt: 'wave' }, { ...value, savedTo: '/ws/images/a.png' })).toBe(`${baseText('/ws/images/a.png')} The result card in the conversation already shows the image and where it was saved; do not embed the image or link its file in your reply unless the user asks.`)
  })

  it('passes the batch arguments to every item so GIF notes appear per image', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => pngResponse())
    vi.stubGlobal('fetch', fetchMock)
    apply(ctx, compatConfig)
    const value = await toolByName(tools, 'generate_images').execute({ prompts: ['one', 'two'], output_format: 'gif', frame_count: 2 }, exec()) as { images: unknown[] }
    expect(value.images).toHaveLength(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ model: 'relay', prompt: 'two', output_format: 'gif', frame_count: 2 })
    const content = toolByName(tools, 'generate_images').output.render({ prompts: ['one', 'two'], output_format: 'gif', frame_count: 2 }, value as never)
    const notes = content.filter(block => block.type === 'text' && block.text.includes(stillNote))
    expect(notes).toHaveLength(2)
  })

  describe('edit_image', () => {
    const editExec = () => execWithUserImages('source')
    const formOf = (fetchMock: { mock: { calls: unknown[][] } }, index: number) => (fetchMock.mock.calls[index]?.[1] as RequestInit).body as FormData
    const sourceImage = (ctx: Context) => vi.mocked(ctx.attachments.readImage).mockResolvedValue({ data: new Uint8Array([137, 80, 78, 71]), ref: attachment('source') } as never)

    it('animates the reference images: each GIF field reaches the multipart form once, and a GIF without a size sends none', async () => {
      const { ctx, tools } = harnessContext()
      const fetchMock = vi.fn(async () => gifResponse())
      vi.stubGlobal('fetch', fetchMock)
      apply(ctx, { ...compatConfig, openaiCompatExtraBody: { watermark: false } })
      sourceImage(ctx)
      const value = await toolByName(tools, 'edit_image').execute({ prompt: 'make the cat wave', output_format: 'gif', frame_count: 4, frame_duration_ms: 120 }, editExec()) as { output: string; animation?: unknown }
      const form = formOf(fetchMock, 0)
      expect(form.getAll('output_format')).toEqual(['gif'])
      expect(form.getAll('frame_count')).toEqual(['4'])
      expect(form.getAll('frame_duration_ms')).toEqual(['120'])
      expect(form.has('size')).toBe(false)
      expect(form.get('image')).toBeInstanceOf(Blob)
      // Channel extras stay generation-only, as for still edits.
      expect(form.has('watermark')).toBe(false)
      expect(value.output).toBe('auto')
      expect(value.animation).toEqual({ frames: 2, frameDurationMs: 100, durationMs: 200 })

      await toolByName(tools, 'edit_image').execute({ prompt: 'make the cat wave', output_format: 'gif', size: '768x768' }, editExec())
      expect(formOf(fetchMock, 1).get('size')).toBe('768x768')
      expect(formOf(fetchMock, 1).getAll('output_format')).toEqual(['gif'])
    })

    it('leaves a still edit request exactly as before', async () => {
      const { ctx, tools } = harnessContext()
      const fetchMock = vi.fn(async () => pngResponse())
      vi.stubGlobal('fetch', fetchMock)
      apply(ctx, compatConfig)
      sourceImage(ctx)
      const value = await toolByName(tools, 'edit_image').execute({ prompt: 'make the cat wave' }, editExec()) as { output: string; animation?: unknown }
      const form = formOf(fetchMock, 0)
      expect([...form.keys()]).toEqual(['image', 'prompt', 'model', 'size', 'response_format'])
      expect(form.get('size')).toBe('1024x1024')
      expect(value.output).toBe('1024x1024')
      expect(value).not.toHaveProperty('animation')
    })

    it('rejects GIF parameters on providers without an OpenAI images contract before any request', async () => {
      const { ctx, tools } = harnessContext()
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      apply(ctx, { provider: 'google', saveToWorkspace: false })
      sourceImage(ctx)
      for (const args of [{ output_format: 'gif' }, { frame_count: 4 }, { frame_duration_ms: 100 }]) {
        await expect(toolByName(tools, 'edit_image').execute({ prompt: 'wave', ...args }, editExec())).rejects.toThrow('only supported with provider=openai or openai-compat')
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('checks an official GIF frame size by the per-frame contract', async () => {
      const { ctx, tools } = harnessContext()
      const fetchMock = vi.fn(async () => gifResponse())
      vi.stubGlobal('fetch', fetchMock)
      apply(ctx, { provider: 'openai', openaiModel: 'gpt-image-2', saveToWorkspace: false })
      sourceImage(ctx)
      await toolByName(tools, 'edit_image').execute({ prompt: 'wave', output_format: 'gif', frame_count: 2, size: '768x768' }, editExec())
      expect(formOf(fetchMock, 0).get('size')).toBe('768x768')
      expect(formOf(fetchMock, 0).getAll('frame_count')).toEqual(['2'])
      await expect(toolByName(tools, 'edit_image').execute({ prompt: 'wave', output_format: 'gif', size: '1000x1000' }, editExec())).rejects.toThrow('16 的倍数')
      await expect(toolByName(tools, 'edit_image').execute({ prompt: 'wave', frame_count: 4 }, editExec())).rejects.toThrow('output_format=gif')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('reports the animation of an edited GIF like a generated one', () => {
      const { ctx, tools } = harnessContext()
      apply(ctx, compatConfig)
      const text = renderText(tools, 'edit_image', { prompt: 'wave', output_format: 'gif', frame_count: 8 }, gifValue({ savedTo: '/ws/images/image-1.gif' }))
      expect(text).toMatch(/^Edited one image with openai-compat\/relay \(auto\)\./)
      expect(text).toContain('animated GIF: 8 frames')
      expect(text).toContain('![animated GIF](</ws/images/image-1.gif>)')
    })

    it('points the agent at edit_image for animating a referenced subject', () => {
      const { ctx, tools } = harnessContext()
      apply(ctx, compatConfig)
      const properties = (toolByName(tools, 'edit_image').parameters as { properties: Record<string, { enum?: string[]; description?: string }> }).properties
      expect(properties.output_format?.enum).toEqual(['gif'])
      expect(properties).toHaveProperty('frame_count')
      expect(properties).toHaveProperty('frame_duration_ms')
      expect(properties.output_format?.description).toContain('reference image')
      // The inline-attachment shortcut must not read as a ban on output options.
      expect(toolByName(tools, 'edit_image').description).toContain('output_format=gif when the user wants an animation')
      const generate = (toolByName(tools, 'generate_image').parameters as { properties: Record<string, { description?: string }> }).properties
      expect(generate.output_format?.description).toContain('edit_image with output_format=gif')
    })
  })
})

describe('GIF originals kept for the conversation card', () => {
  const dirs: string[] = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })
  const vaultDir = async () => { const dir = await mkdtemp(join(tmpdir(), 'dsh-gif-vault-')); dirs.push(dir); return dir }
  const gif = gifBytes(3)
  const key = createHash('sha256').update(gif).digest('hex')
  const original = { key, bytes: gif.byteLength, mediaType: 'image/gif' }
  const webp = () => ({ ...attachment('sha256:gif'), mediaType: 'image/webp' as const, bytes: 48 })
  const jsonResponse = (b64: string) => new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { headers: { 'content-type': 'application/json' } })
  const gifResponse = () => jsonResponse(Buffer.from(gif).toString('base64'))
  const compat = (vaultDir: string, extra: Record<string, unknown> = {}) => ({ provider: 'openai-compat' as const, openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay', saveToWorkspace: false, vaultDir, ...extra })
  const exec = () => ({ signal: new AbortController().signal }) as never
  const gifFiles = async (dir: string) => (await readdir(dir, { recursive: true })).filter(entry => entry.endsWith('.gif'))
  const schemaOf = (tool: ToolDefinition) => tool.output.schema as { properties: Record<string, unknown> & { images?: { items: { properties: Record<string, unknown> } } } }
  const metaOf = (tool: ToolDefinition, args: unknown, value: unknown) => (tool.output as unknown as { presentationMeta(args: unknown, value: unknown): Record<string, unknown> }).presentationMeta(args, value)

  it('stores the raw GIF the host normalized and exposes the reference in the value, the meta and every output schema', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.saveImage).mockResolvedValue(webp())
    vi.stubGlobal('fetch', vi.fn(async () => gifResponse()))
    const dir = await vaultDir()
    apply(ctx, compat(dir))
    const value = await toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif' }, exec()) as Record<string, unknown>
    expect(value.original).toEqual(original)
    await expect(stat(join(dir, key.slice(0, 2), `${key}.gif`))).resolves.toMatchObject({ size: gif.byteLength })
    expect(metaOf(toolByName(tools, 'generate_image'), { prompt: 'wave' }, value).original).toEqual(original)
    const expected = { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, bytes: { type: 'integer' }, mediaType: { type: 'string' } }, required: ['key', 'bytes', 'mediaType'] }
    expect(schemaOf(toolByName(tools, 'generate_image')).properties.original).toEqual(expected)
    expect(schemaOf(toolByName(tools, 'edit_image')).properties.original).toEqual(expected)
    expect(schemaOf(toolByName(tools, 'generate_images')).properties.images?.items.properties.original).toEqual(expected)
  })

  it('carries the original through a run_code dispatch, whose card sees only the rendered text', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.saveImage).mockResolvedValue(webp())
    vi.stubGlobal('fetch', vi.fn(async () => gifResponse()))
    apply(ctx, compat(await vaultDir()))
    for (const name of ['generate_image', 'generate_images'] as const) {
      const tool = toolByName(tools, name)
      const args = name === 'generate_image' ? { prompt: 'wave', output_format: 'gif' } : { prompts: ['wave'], output_format: 'gif' }
      const value = await tool.execute(args as never, exec())
      const content = tool.output.render(args, value as never)
      const [result] = imageResultsFromPtcDispatch({ type: 'tool/ptc-dispatch', data: { name, arguments: args, isError: false, content } } as never)
      expect(result?.original).toEqual(original)
      // The prompt of a batch item is still read from after the summary.
      expect(result?.prompt).toBe('wave')
    }
  })

  it('keeps no original when the host returns the same GIF bytes, when a still image was normalized, or when the vault is off', async () => {
    const { ctx, tools } = harnessContext()
    const fetchMock = vi.fn(async () => gifResponse())
    vi.stubGlobal('fetch', fetchMock)
    const dir = await vaultDir()
    apply(ctx, compat(dir))
    vi.mocked(ctx.attachments.saveImage).mockResolvedValueOnce({ ...attachment('sha256:gif'), mediaType: 'image/gif', bytes: gif.byteLength })
    expect(await toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif' }, exec())).not.toHaveProperty('original')
    vi.mocked(ctx.attachments.saveImage).mockResolvedValueOnce(webp())
    fetchMock.mockResolvedValueOnce(jsonResponse('iVBORw0KGgo='))
    expect(await toolByName(tools, 'generate_image').execute({ prompt: 'wave' }, exec())).not.toHaveProperty('original')
    // A single-frame GIF is a still image (as the animation notes say), so nothing animates to keep.
    vi.mocked(ctx.attachments.saveImage).mockResolvedValueOnce(webp())
    fetchMock.mockResolvedValueOnce(jsonResponse(Buffer.from(gifBytes(1)).toString('base64')))
    expect(await toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif' }, exec())).not.toHaveProperty('original')
    expect(await gifFiles(dir)).toEqual([])

    const off = harnessContext()
    vi.mocked(off.ctx.attachments.saveImage).mockResolvedValue(webp())
    apply(off.ctx, compat(dir, { vaultEnabled: false }))
    expect(await toolByName(off.tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif' }, exec())).not.toHaveProperty('original')
    expect(await gifFiles(dir)).toEqual([])
  })

  it('still returns the image and only warns when the vault cannot be written', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.saveImage).mockResolvedValue(webp())
    vi.stubGlobal('fetch', vi.fn(async () => gifResponse()))
    const blocker = join(await vaultDir(), 'not-a-directory')
    await writeFile(blocker, 'x')
    apply(ctx, compat(blocker))
    const value = await toolByName(tools, 'generate_image').execute({ prompt: 'wave', output_format: 'gif' }, exec()) as Record<string, unknown>
    expect(value.attachment).toEqual(webp())
    expect(value).not.toHaveProperty('original')
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('original'))
  })

  it('shares one stored file across a batch of identical GIFs and reports it on every item', async () => {
    const { ctx, tools } = harnessContext()
    vi.mocked(ctx.attachments.saveImage).mockResolvedValue(webp())
    vi.stubGlobal('fetch', vi.fn(async () => gifResponse()))
    const dir = await vaultDir()
    apply(ctx, compat(dir))
    const batch = await toolByName(tools, 'generate_images').execute({ prompts: ['one', 'two'], output_format: 'gif' }, exec()) as { images: Record<string, unknown>[] }
    expect(batch.images.map(image => image.original)).toEqual([original, original])
    const meta = metaOf(toolByName(tools, 'generate_images'), { prompts: ['one', 'two'] }, batch) as { images: Record<string, unknown>[] }
    expect(meta.images.map(image => image.original)).toEqual([original, original])
    expect(await gifFiles(dir)).toHaveLength(1)
  })

  it('tells the model the card plays the animation and never hands it an embed to copy then', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'openai-compat', saveToWorkspace: false })
    const value = { attachment: webp(), provider: 'openai-compat', model: 'relay', output: 'auto', savedTo: '/ws/images/image-abc.gif', animation: { frames: 8, frameDurationMs: 120, durationMs: 960 } }
    const render = (candidate: unknown) => {
      const block = toolByName(tools, 'generate_image').output.render({ prompt: 'wave', output_format: 'gif' }, candidate as never)[0]
      return block?.type === 'text' ? block.text : ''
    }
    const played = render({ ...value, original })
    expect(played).toContain('animated GIF: 8 frames × 120 ms (0.96s loop)')
    expect(played).toContain('The result card in the conversation already plays the animation and where it was saved; do not embed the image or link its file in your reply unless the user asks.')
    // A ready-made embed is copied even when the text says not to, showing the animation twice.
    expect(played).not.toContain('![animated GIF]')
    expect(played).not.toContain('run_code')
    const unsaved = render({ ...value, original, savedTo: undefined })
    expect(unsaved).toContain('The result card in the conversation already plays the animation; do not embed the image or link its file in your reply unless the user asks.')
    expect(unsaved).not.toContain('![animated GIF]')
    // A host that keeps the GIF attachment plays it on every card.
    const attached = render({ ...value, attachment: { ...webp(), mediaType: 'image/gif' } })
    expect(attached).toContain('The result card in the conversation already plays the animation and where it was saved; do not embed the image or link its file in your reply unless the user asks.')
    expect(attached).not.toContain('![animated GIF]')
    expect(attached).not.toContain('first frame')
    const embedded = render(value)
    expect(embedded).toContain('To show the animation, embed the saved file in your reply with Markdown: ![animated GIF](</ws/images/image-abc.gif>)')
    expect(embedded).not.toContain('plays the animation')
  })
})
