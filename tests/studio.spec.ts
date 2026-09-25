import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEFAULT_GOOGLE_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_SEEDREAM_MODEL, DEFAULT_DASHSCOPE_MODEL } from '../src/config.js'
import { generateFromStudio, runPool, studioProfile, describeStudio, openAIRequestSize } from '../src/studio.js'
import { parseStudioGenerateRequest, serveStudio } from '../src/studio-route.js'
import { SUBSCRIPTION_PROVIDERS, DEFAULT_SUBSCRIPTION_MODELS, SUBSCRIPTION_TIMEOUT_MS, STUDIO_PROVIDERS, CLOUD_IMAGE_PROVIDERS, type SubscriptionProvider } from '../src/shared.js'
import type { SubscriptionManager, SubscriptionVendor } from '../src/subscription/manager.js'
import {
  fetchAttachmentBlob,
  clearAttachmentCache,
  evictAttachmentCache,
  getCacheMetrics,
  MAX_CACHE_COUNT,
} from '../src/client/image-cache.js'
import { formatRelativeTime, downloadBlobUrl } from '../src/client/browser-image-utils.js'
import { conversationRegenerateRequest } from '../src/client/conversation-regenerate.js'
import {
  appendConversationImageRevision,
  loadConversationImageRevisionChain,
  selectConversationImageRevision,
} from '../src/client/conversation-image-revisions.js'
import { buildComparisonTargets, initialComparisonProviders } from '../src/client/multi-model-compare.js'

describe('multi-model comparison planning', () => {
  const profiles = [
    studioProfile({}, 'google', true),
    studioProfile({}, 'openai', true),
    studioProfile({}, 'seedream', true),
    studioProfile({}, 'dashscope', false),
  ]

  it('starts with the active provider and one additional configured model', () => {
    expect(initialComparisonProviders(profiles, 'openai')).toEqual(['openai', 'google'])
  })

  it('maps unsupported shared settings to each provider default', () => {
    const targets = buildComparisonTargets(profiles, ['google', 'openai', 'seedream', 'dashscope'], '16:9', '4K')
    expect(targets.map(target => ({
      provider: target.profile.provider,
      ratio: target.ratio,
      quality: target.quality,
      adjusted: target.adjusted,
    }))).toEqual([
      { provider: 'google', ratio: '16:9', quality: '4K', adjusted: false },
      { provider: 'openai', ratio: '1:1', quality: 'standard', adjusted: true },
      { provider: 'seedream', ratio: 'auto', quality: '4K', adjusted: true },
    ])
  })
})

describe('image workbench provider capabilities', () => {
  it('exposes only parameters implemented by each cloud adapter', () => {
    const google = studioProfile({}, 'google', true)
    expect(google).toMatchObject({ model: DEFAULT_GOOGLE_MODEL, defaultRatio: '1:1', defaultQuality: '1K', configured: true })
    expect(google.ratioOptions.map(option => option.value)).toContain('16:9')
    expect(google.qualityOptions.map(option => option.value)).toEqual(['1K', '2K', '4K'])

    const openai = studioProfile({}, 'openai', false)
    expect(openai).toMatchObject({ model: DEFAULT_OPENAI_MODEL, configured: false })
    expect(openai.ratioOptions.map(option => option.value)).toEqual(['1:1', '3:2', '2:3'])
    expect(openai.qualityOptions).toEqual([{ value: 'standard', label: '标准（推荐）' }])

    const seedream = studioProfile({}, 'seedream', true)
    expect(seedream).toMatchObject({ model: DEFAULT_SEEDREAM_MODEL, defaultRatio: 'auto', defaultQuality: '2K', configured: true })
    expect(seedream.qualityOptions.map(o => o.value)).toEqual(['1K', '2K', '4K'])

    const dashscope = studioProfile({}, 'dashscope', true)
    expect(dashscope).toMatchObject({ model: DEFAULT_DASHSCOPE_MODEL, defaultRatio: '1:1', defaultQuality: 'standard', configured: true })
    expect(dashscope.ratioOptions.map(o => o.value)).toEqual(['1:1', '3:2', '2:3', '16:9', '9:16'])
  })

  it('does not expose ComfyUI through the first workbench release', () => {
    expect(() => studioProfile({}, 'comfyui' as never, true)).toThrow()
  })

  it('lists subscription channels after the cloud rows', () => {
    expect(STUDIO_PROVIDERS).toEqual([...CLOUD_IMAGE_PROVIDERS, ...SUBSCRIPTION_PROVIDERS])
    expect(STUDIO_PROVIDERS).not.toContain('comfyui')
  })
})

describe('image workbench request validation', () => {
  const base = {
    mode: 'generate' as const,
    provider: 'google' as const,
    model: DEFAULT_GOOGLE_MODEL,
    prompt: '  a warm editorial portrait  ',
    ratio: '2:3',
    quality: '2K',
  }

  it('normalizes a cloud generation request', () => {
    expect(parseStudioGenerateRequest(base)).toEqual({ ...base, prompt: 'a warm editorial portrait' })
  })

  it('requires a valid reference for image editing', () => {
    expect(() => parseStudioGenerateRequest({ ...base, mode: 'edit' })).toThrow('参考图')
    expect(parseStudioGenerateRequest({
      ...base,
      mode: 'edit',
      reference: {
        attachment: {
          attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 8, width: 32, height: 32,
        },
      },
    })).toMatchObject({ mode: 'edit', reference: { attachment: { attachmentId: 'sha256:image' } } })
  })

  it('supports multiple references for image editing and enforces 5 images max', () => {
    const ref = {
      attachment: {
        attachmentId: 'sha256:image', mediaType: 'image/png' as const, bytes: 8, width: 32, height: 32,
      },
    }
    const result = parseStudioGenerateRequest({
      ...base,
      mode: 'edit',
      references: [ref, ref],
    })
    expect(result.references).toHaveLength(2)
    expect(() => parseStudioGenerateRequest({
      ...base,
      mode: 'edit',
      references: [ref, ref, ref, ref, ref, ref],
    })).toThrow('5')
  })

  it('rejects ComfyUI and oversized prompts at the browser boundary', () => {
    expect(() => parseStudioGenerateRequest({ ...base, provider: 'comfyui' as never })).toThrow('Provider')
    expect(() => parseStudioGenerateRequest({ ...base, prompt: 'x'.repeat(2_001) })).toThrow('2000')
  })

  it('preserves valid workspaceRoot when provided', () => {
    const result = parseStudioGenerateRequest({
      ...base,
      workspaceRoot: 'D:\\z\\standalone',
    })
    expect(result.workspaceRoot).toBe('D:\\z\\standalone')
  })

  it('validates image generation count (1 to 4)', () => {
    expect(parseStudioGenerateRequest({ ...base, count: 1 })).toMatchObject({ count: 1 })
    expect(parseStudioGenerateRequest({ ...base, count: 4 })).toMatchObject({ count: 4 })
    expect(parseStudioGenerateRequest({ ...base })).not.toHaveProperty('count')

    expect(() => parseStudioGenerateRequest({ ...base, count: 0 })).toThrow('生成数量仅支持 1 到 4 张')
    expect(() => parseStudioGenerateRequest({ ...base, count: 5 })).toThrow('生成数量仅支持 1 到 4 张')
    expect(() => parseStudioGenerateRequest({ ...base, count: -1 })).toThrow('生成数量仅支持 1 到 4 张')
    expect(() => parseStudioGenerateRequest({ ...base, count: 2.5 })).toThrow('生成数量仅支持 1 到 4 张')
    expect(() => parseStudioGenerateRequest({ ...base, count: '2' as never })).toThrow('生成数量仅支持 1 到 4 张')
  })

  it('accepts subscription providers for both text-to-image and edits at the boundary', () => {
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      expect(parseStudioGenerateRequest({ ...base, provider, model: DEFAULT_SUBSCRIPTION_MODELS[provider], ratio: 'auto', quality: 'auto' }))
        .toMatchObject({ provider, ratio: 'auto', quality: 'auto' })
    }
    expect(parseStudioGenerateRequest({
      ...base,
      provider: 'chatgpt-sub',
      model: DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
      mode: 'edit',
      reference: {
        attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 8, width: 32, height: 32 },
      },
    })).toMatchObject({ provider: 'chatgpt-sub', mode: 'edit' })
  })
})

describe('subscription workbench profiles', () => {
  it('builds a stub SubscriptionManager whose loginStatus reflects credentials', async () => {
    const manager = stubSubscriptionManager({ 'chatgpt-sub': { state: 'logged-in', email: 'user@example.com' } })
    expect((await manager.loginStatus('codex')).state).toBe('logged-in')
    expect((await manager.loginStatus('grok')).state).toBe('logged-out')
  })

  it('exposes signed-in subscriptions as configured rows with channel-default parameters', async () => {
    const manager = stubSubscriptionManager({
      'chatgpt-sub': { state: 'logged-in', email: 'user@example.com' },
      'grok-sub': { state: 'logged-in', email: 'user@example.com' },
      'google-sub': { state: 'logged-out' },
    })
    const config = await describeStudio(studioCtx(), {}, manager)
    const byProvider = new Map(config.providers.map(profile => [profile.provider, profile]))
    expect([...byProvider.keys()]).toEqual([...CLOUD_IMAGE_PROVIDERS, ...SUBSCRIPTION_PROVIDERS])

    const chatgpt = byProvider.get('chatgpt-sub')!
    expect(chatgpt).toMatchObject({
      label: 'ChatGPT 订阅',
      model: DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
      configured: true,
      supportsEditing: true,
      defaultRatio: 'auto',
      defaultQuality: 'auto',
    })
    expect(chatgpt.ratioOptions).toEqual([{ value: 'auto', label: '通道默认' }])
    expect(chatgpt.qualityOptions).toEqual([{ value: 'auto', label: '通道默认' }])

    expect(byProvider.get('grok-sub')!.configured).toBe(true)
    expect(byProvider.get('google-sub')!.configured).toBe(false)
  })

  it('falls back to the first configured provider when the preference cannot drive the workbench', async () => {
    const manager = stubSubscriptionManager({})
    const config = await describeStudio(studioCtx(), { provider: 'comfyui' }, manager)
    expect(config.activeProvider).toBe('google')
  })

  it('keeps a preferred subscription provider as the active workbench provider', async () => {
    const manager = stubSubscriptionManager({
      'chatgpt-sub': { state: 'logged-in', email: 'user@example.com' },
    })
    const config = await describeStudio(studioCtx(), { provider: 'chatgpt-sub' }, manager)
    expect(config.activeProvider).toBe('chatgpt-sub')
  })
})

describe('subscription workbench generation', () => {
  it('routes prompt-only subscription requests through generateSubscriptionImage', async () => {
    const manager = stubSubscriptionManager({ 'chatgpt-sub': { state: 'logged-in', email: 'user@example.com' } })
    const ctx = studioCtx()
    const result = await generateFromStudio(
      ctx,
      {},
      {
        mode: 'generate',
        provider: 'chatgpt-sub',
        model: DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
        prompt: 'a warm editorial portrait',
        ratio: 'auto',
        quality: 'auto',
      },
      new AbortController().signal,
      undefined,
      manager,
    )
    expect(manager.generateCalls.map(call => call.vendor)).toEqual(['codex'])
    expect(result.output).toBe('通道默认')
    expect(result.provider).toBe('chatgpt-sub')
    expect(result.model).toBe(DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'])
    expect(result.items).toHaveLength(1)
    expect(ctx.attachments.saveImage).toHaveBeenCalledTimes(1)
  })

  it('passes reference images through to the subscription manager for edits', async () => {
    const manager = stubSubscriptionManager({ 'grok-sub': { state: 'logged-in', email: 'user@example.com' } })
    const ctx = studioCtx()
    const result = await generateFromStudio(
      ctx,
      {},
      {
        mode: 'edit',
        provider: 'grok-sub',
        model: DEFAULT_SUBSCRIPTION_MODELS['grok-sub'],
        prompt: 'a warm editorial portrait',
        ratio: 'auto',
        quality: 'auto',
        references: [{ data: Buffer.from('stub-image').toString('base64'), mediaType: 'image/png' }],
      },
      new AbortController().signal,
      undefined,
      manager,
    )
    expect(manager.generateCalls).toHaveLength(1)
    expect(manager.generateCalls[0]!.vendor).toBe('grok')
    expect(manager.generateCalls[0]!.referenceImages).toHaveLength(1)
    expect(result.provider).toBe('grok-sub')
    expect(result.items).toHaveLength(1)
    expect(ctx.attachments.saveImage).toHaveBeenCalledTimes(1)
  })

  it('rejects subscription edits that arrive without any reference image', async () => {
    const manager = stubSubscriptionManager({ 'grok-sub': { state: 'logged-in', email: 'user@example.com' } })
    await expect(generateFromStudio(
      studioCtx(),
      {},
      {
        mode: 'edit',
        provider: 'grok-sub',
        model: DEFAULT_SUBSCRIPTION_MODELS['grok-sub'],
        prompt: 'a warm editorial portrait',
        ratio: 'auto',
        quality: 'auto',
      },
      new AbortController().signal,
      undefined,
      manager,
    )).rejects.toThrow('图生图需要至少一张参考图')
    expect(manager.generateCalls).toHaveLength(0)
  })

  it('rejects invalid base64 subscription references without falling back to text-to-image', async () => {
    const manager = stubSubscriptionManager({ 'grok-sub': { state: 'logged-in', email: 'user@example.com' } })
    await expect(generateFromStudio(
      studioCtx(),
      {},
      {
        mode: 'edit',
        provider: 'grok-sub',
        model: DEFAULT_SUBSCRIPTION_MODELS['grok-sub'],
        prompt: 'a warm editorial portrait',
        ratio: 'auto',
        quality: 'auto',
        references: [{ data: 'not-valid-base64!!', mediaType: 'image/png' }],
      },
      new AbortController().signal,
      undefined,
      manager,
    )).rejects.toThrow('参考图编码无效')
    expect(manager.generateCalls).toHaveLength(0)
  })

  it('rejects subscription generation when the manager is missing', async () => {
    await expect(generateFromStudio(
      studioCtx(),
      {},
      {
        mode: 'generate',
        provider: 'chatgpt-sub',
        model: DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
        prompt: 'a warm editorial portrait',
        ratio: 'auto',
        quality: 'auto',
      },
      new AbortController().signal,
    )).rejects.toThrow('订阅管理器未初始化')
  })

  it('runs multi-image subscription batches through the same 2-slot pool', async () => {
    const manager = stubSubscriptionManager({ 'google-sub': { state: 'logged-in', email: 'user@example.com' } })
    const ctx = studioCtx()
    const result = await generateFromStudio(
      ctx,
      {},
      {
        mode: 'generate',
        provider: 'google-sub',
        model: DEFAULT_SUBSCRIPTION_MODELS['google-sub'],
        prompt: 'a warm editorial portrait',
        ratio: 'auto',
        quality: 'auto',
        count: 3,
      },
      new AbortController().signal,
      undefined,
      manager,
    )
    expect(manager.generateCalls).toHaveLength(3)
    expect(result.requestedCount).toBe(3)
    expect(result.failedCount).toBe(0)
    expect(result.items).toHaveLength(3)
    expect(ctx.attachments.saveImage).toHaveBeenCalledTimes(3)
  })
})

describe('mixed subscription and API comparison planning', () => {
  const subProfile = (provider: SubscriptionProvider, configured: boolean) => ({
    provider,
    label: provider,
    model: DEFAULT_SUBSCRIPTION_MODELS[provider],
    configured,
    supportsEditing: true,
    ratioOptions: [{ value: 'auto', label: '通道默认' }],
    qualityOptions: [{ value: 'auto', label: '通道默认' }],
    defaultRatio: 'auto',
    defaultQuality: 'auto',
  })

  it('keeps API-key rows adjustable while subscription rows fall back to channel defaults', () => {
    const profiles = [
      studioProfile({}, 'google', true),
      studioProfile({}, 'openai', true),
      subProfile('chatgpt-sub', true),
      subProfile('grok-sub', false),
    ]
    const targets = buildComparisonTargets(profiles, ['google', 'openai', 'chatgpt-sub', 'grok-sub'], '16:9', '4K')
    expect(targets.map(target => ({
      provider: target.profile.provider,
      ratio: target.ratio,
      quality: target.quality,
    }))).toEqual([
      { provider: 'google', ratio: '16:9', quality: '4K' },
      { provider: 'openai', ratio: '1:1', quality: 'standard' },
      { provider: 'chatgpt-sub', ratio: 'auto', quality: 'auto' },
    ])
  })

  it('starts mixed comparisons from the active provider regardless of channel kind', () => {
    const profiles = [
      studioProfile({}, 'google', true),
      subProfile('chatgpt-sub', true),
      subProfile('grok-sub', true),
    ]
    expect(initialComparisonProviders(profiles, 'chatgpt-sub')).toEqual(['chatgpt-sub', 'google'])
    expect(initialComparisonProviders(profiles, 'grok-sub')).toEqual(['grok-sub', 'google'])
  })
})

describe('multi-image worker pool', () => {
  it('strictly limits concurrency to 2 and preserves task order', async () => {
    let active = 0
    let peak = 0
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

    const tasks = [
      async () => {
        active++
        peak = Math.max(peak, active)
        await delay(30)
        active--
        return 'task1'
      },
      async () => {
        active++
        peak = Math.max(peak, active)
        await delay(10)
        active--
        return 'task2'
      },
      async () => {
        active++
        peak = Math.max(peak, active)
        await delay(20)
        active--
        return 'task3'
      },
      async () => {
        active++
        peak = Math.max(peak, active)
        await delay(10)
        active--
        return 'task4'
      },
    ]

    const results = await runPool(tasks, 2)
    expect(peak).toBeLessThanOrEqual(2)
    expect(results).toEqual([
      { status: 'fulfilled', value: 'task1' },
      { status: 'fulfilled', value: 'task2' },
      { status: 'fulfilled', value: 'task3' },
      { status: 'fulfilled', value: 'task4' },
    ])
  })

  it('captures rejections without aborting other concurrent tasks', async () => {
    const tasks = [
      async () => 'ok1',
      async () => { throw new Error('fail2') },
      async () => 'ok3',
    ]
    const results = await runPool(tasks, 2)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok1' })
    expect(results[1]).toMatchObject({ status: 'rejected' })
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok3' })
  })
})

describe('conversation and gallery image regeneration', () => {
  it('reuses provider output settings while allowing the prompt to change', () => {
    expect(conversationRegenerateRequest({
      provider: 'google', model: DEFAULT_GOOGLE_MODEL, output: '2:3, 2K',
    }, '  softer evening light  ')).toEqual({
      mode: 'generate', provider: 'google', model: DEFAULT_GOOGLE_MODEL,
      prompt: 'softer evening light', ratio: '2:3', quality: '2K',
    })
    expect(conversationRegenerateRequest({
      provider: 'openai', model: DEFAULT_OPENAI_MODEL, output: '1536x1024',
    }, 'another version')).toMatchObject({ ratio: '3:2', quality: 'standard' })
    expect(conversationRegenerateRequest({
      provider: 'dashscope', model: DEFAULT_DASHSCOPE_MODEL, output: '928*1664',
    }, 'another version')).toMatchObject({ ratio: '9:16', quality: 'standard' })
  })

  it('supports gallery items with undefined output and explicit ratio/quality', () => {
    const request = conversationRegenerateRequest(
      { provider: 'google', model: DEFAULT_GOOGLE_MODEL },
      'new prompt',
      { ratio: '16:9', quality: '4K' },
    )
    expect(request).toEqual({
      mode: 'generate',
      provider: 'google',
      model: DEFAULT_GOOGLE_MODEL,
      prompt: 'new prompt',
      ratio: '16:9',
      quality: '4K',
    })
  })

  it('rejects providers not supported by the API workbench', () => {
    expect(() => conversationRegenerateRequest({
      provider: 'comfyui', model: 'workflow', output: 'API workflow',
    }, 'another version')).toThrow('Provider')
  })

  it('persists revisions and the selected in-place version', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    const originId = 'sha256:origin'
    const revision = {
      attachment: {
        attachmentId: 'sha256:revision' as any,
        mediaType: 'image/png' as const,
        bytes: 8,
        width: 32,
        height: 32,
      },
      prompt: 'a revised image',
      provider: 'google' as const,
      model: DEFAULT_GOOGLE_MODEL,
      output: '1:1, 1K',
      createdAt: 123,
      ratio: '1:1',
      quality: '1K',
    }

    expect(appendConversationImageRevision(originId, revision)).toMatchObject({ currentIndex: 1 })
    expect(loadConversationImageRevisionChain(originId).revisions).toEqual([revision])
    expect(selectConversationImageRevision(originId, 0).currentIndex).toBe(0)
    expect(loadConversationImageRevisionChain(originId).currentIndex).toBe(0)
    vi.unstubAllGlobals()
  })
})

describe('real HTTP server cancellation with Fetch Abort', () => {
  let server: Server
  let serverUrl: string
  let serverAbortFired: boolean
  let serverPromiseResolve: () => void

  beforeEach(async () => {
    serverAbortFired = false
    new Promise<void>((resolve) => {
      serverPromiseResolve = resolve
    })

    server = createServer(async (req, res) => {
      await serveStudio(req, res, {
        describe: async () => ({ providers: [], activeProvider: 'google' }),
        generate: async (_input, signal) => {
          signal.addEventListener('abort', () => {
            serverAbortFired = true
            serverPromiseResolve()
          })
          // Wait indefinitely until aborted by client disconnect
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
          throw new Error('should not reach here')
        },
        maxBodyBytes: 1024 * 1024,
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo
        serverUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('triggers upstream abort signal when browser fetch is aborted after body upload', async () => {
    const clientController = new AbortController()
    const payload = JSON.stringify({
      mode: 'generate',
      provider: 'google',
      model: DEFAULT_GOOGLE_MODEL,
      prompt: 'a tranquil lake at dawn',
      ratio: '1:1',
      quality: '1K',
    })

    const fetchPromise = fetch(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: serverUrl,
      },
      body: payload,
      signal: clientController.signal,
    })

    // Give server time to parse the body and enter the generate() call
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Client actively aborts the ongoing request
    clientController.abort()

    await expect(fetchPromise).rejects.toThrow()

    // Wait for the server-side abort handler to complete
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(serverAbortFired).toBe(true)
  })
})

describe('image-cache bounded LRU & lifecycle', () => {
  beforeEach(() => {
    clearAttachmentCache()
  })

  afterEach(() => {
    clearAttachmentCache()
    vi.unstubAllGlobals()
  })

  it('deduplicates concurrent fetches for the same attachment', async () => {
    const mockBlob = new Blob(['bytes'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(mockBlob, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const ref = { attachmentId: 'sha256:same' as any, mediaType: 'image/png' as const, bytes: 5 }
    const [b1, b2] = await Promise.all([fetchAttachmentBlob(ref), fetchAttachmentBlob(ref)])

    expect(b1).toBe(b2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes LRU order when an entry is accessed again', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++
      return new Response(new Blob([`blob-${callCount}`]), { status: 200 })
    }))

    // Fill up to MAX_CACHE_COUNT
    for (let i = 1; i <= MAX_CACHE_COUNT; i++) {
      await fetchAttachmentBlob({ attachmentId: `sha256:${i}` as any, mediaType: 'image/png' as const, bytes: 10 })
    }
    expect(getCacheMetrics().count).toBe(MAX_CACHE_COUNT)

    // Touch item 1 again so it moves to MRU
    await fetchAttachmentBlob({ attachmentId: 'sha256:1' as any, mediaType: 'image/png' as const, bytes: 10 })

    // Now insert item 31, which should evict item 2 (the new oldest), NOT item 1
    await fetchAttachmentBlob({ attachmentId: 'sha256:31' as any, mediaType: 'image/png' as const, bytes: 10 })

    expect(getCacheMetrics().count).toBe(MAX_CACHE_COUNT)

    // Verify item 1 is still in cache (no new fetch)
    const currentFetches = callCount
    await fetchAttachmentBlob({ attachmentId: 'sha256:1' as any, mediaType: 'image/png' as const, bytes: 10 })
    expect(callCount).toBe(currentFetches)
  })

  it('evicts cached items when byte limit is exceeded', async () => {
    // 50MB blobs
    const bigBlobBytes = 50 * 1024 * 1024
    vi.stubGlobal('fetch', vi.fn(async () => {
      const fakeBlob = { size: bigBlobBytes, type: 'image/png' } as unknown as Blob
      return { ok: true, blob: async () => fakeBlob } as Response
    }))

    // 1st item: 50MB
    await fetchAttachmentBlob({ attachmentId: 'sha256:big1' as any, mediaType: 'image/png' as const, bytes: bigBlobBytes })
    // 2nd item: 50MB (total 100MB, <= 128MB)
    await fetchAttachmentBlob({ attachmentId: 'sha256:big2' as any, mediaType: 'image/png' as const, bytes: bigBlobBytes })
    expect(getCacheMetrics().count).toBe(2)
    expect(getCacheMetrics().bytes).toBe(100 * 1024 * 1024)

    // 3rd item: 50MB (total 150MB > 128MB, must evict big1)
    await fetchAttachmentBlob({ attachmentId: 'sha256:big3' as any, mediaType: 'image/png' as const, bytes: bigBlobBytes })
    expect(getCacheMetrics().count).toBe(2)
    expect(getCacheMetrics().bytes).toBe(100 * 1024 * 1024)
  })

  it('removes failed requests immediately from cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))

    const ref = { attachmentId: 'sha256:fail' as any, mediaType: 'image/png' as const, bytes: 0 }
    await expect(fetchAttachmentBlob(ref)).rejects.toThrow()
    expect(getCacheMetrics().count).toBe(0)
  })

  it('evicts targeted item when deleted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['hello']), { status: 200 })))
    const ref = { attachmentId: 'sha256:del' as any, mediaType: 'image/png' as const, bytes: 5 }
    await fetchAttachmentBlob(ref)
    expect(getCacheMetrics().count).toBe(1)

    evictAttachmentCache('sha256:del')
    expect(getCacheMetrics().count).toBe(0)
  })
})

describe('browser-image-utils', () => {
  it('formats relative time accurately for zh and en', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 10_000, 'zh')).toBe('刚刚')
    expect(formatRelativeTime(now - 10_000, 'en')).toBe('Just now')

    expect(formatRelativeTime(now - 5 * 60_000, 'zh')).toBe('5 分钟前')
    expect(formatRelativeTime(now - 5 * 60_000, 'en')).toBe('5m ago')

    expect(formatRelativeTime(now - 3 * 3600_000, 'zh')).toBe('3 小时前')
    expect(formatRelativeTime(now - 3 * 3600_000, 'en')).toBe('3h ago')

    expect(formatRelativeTime(now - 2 * 86400_000, 'zh')).toBe('2 天前')
    expect(formatRelativeTime(now - 2 * 86400_000, 'en')).toBe('2d ago')
  })

  it('safely downloads blob URL by mounting and unmounting anchor', () => {
    let clickCalled = false
    let appended = false
    let removed = false
    const mockAnchor = {
      href: '',
      download: '',
      click: () => { clickCalled = true },
    }
    const mockDocument = {
      createElement: (tag: string) => (tag === 'a' ? mockAnchor : {}),
      body: {
        appendChild: (node: any) => { if (node === mockAnchor) appended = true },
        removeChild: (node: any) => { if (node === mockAnchor) removed = true },
      },
    }
    vi.stubGlobal('document', mockDocument)

    downloadBlobUrl('blob:http://test/123', 'sample.png')

    expect(mockAnchor.href).toBe('blob:http://test/123')
    expect(mockAnchor.download).toBe('sample.png')
    expect(appended).toBe(true)
    expect(clickCalled).toBe(true)
    expect(removed).toBe(true)

    vi.unstubAllGlobals()
  })
})

describe('generateFromStudio multi-image execution', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('generates multiple images with count = 3 and concurrency 2', async () => {
    let callCount = 0
    let activeCalls = 0
    let peakConcurrency = 0

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      activeCalls++
      peakConcurrency = Math.max(peakConcurrency, activeCalls)
      await new Promise(resolve => setTimeout(resolve, 20))
      activeCalls--
      return new Response(JSON.stringify({
        output_image: {
          data: Buffer.from('fake-image-bytes').toString('base64'),
          mime_type: 'image/jpeg',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const ctx = {
      credentials: {
        resolve: vi.fn().mockResolvedValue({ value: 'fake-key' }),
      },
      attachments: {
        imageLimits: {
          maxImageBytes: 10 * 1024 * 1024,
          mediaTypes: ['image/jpeg', 'image/png'],
        },
        saveImage: vi.fn().mockImplementation(async ({ mediaType }) => ({
          attachmentId: `att-${callCount}`,
          mediaType,
          bytes: 100,
        })),
      },
      logger: { warn: vi.fn() },
    } as any

    const controller = new AbortController()
    const result = await generateFromStudio(
      ctx,
      {},
      {
        mode: 'generate',
        provider: 'google',
        model: DEFAULT_GOOGLE_MODEL,
        prompt: 'test prompt',
        ratio: '1:1',
        quality: '1K',
        count: 3,
      },
      controller.signal,
    )

    expect(callCount).toBe(3)
    expect(peakConcurrency).toBeLessThanOrEqual(2)
    expect(result.requestedCount).toBe(3)
    expect(result.failedCount).toBe(0)
    expect(result.items).toHaveLength(3)
    expect(result.attachment).toBeDefined()
    expect(result.attachment).toEqual(result.items![0].attachment)
  })

  it('supports partial success when 1 out of 2 requests fails', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 2) {
        return new Response('Rate limit reached', { status: 429 })
      }
      return new Response(JSON.stringify({
        output_image: {
          data: Buffer.from('fake-image-bytes').toString('base64'),
          mime_type: 'image/jpeg',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const ctx = {
      credentials: {
        resolve: vi.fn().mockResolvedValue({ value: 'fake-key' }),
      },
      attachments: {
        imageLimits: {
          maxImageBytes: 10 * 1024 * 1024,
          mediaTypes: ['image/jpeg', 'image/png'],
        },
        saveImage: vi.fn().mockImplementation(async ({ mediaType }) => ({
          attachmentId: `att-${callCount}`,
          mediaType,
          bytes: 100,
        })),
      },
      logger: { warn: vi.fn() },
    } as any

    const controller = new AbortController()
    const result = await generateFromStudio(
      ctx,
      {},
      {
        mode: 'generate',
        provider: 'google',
        model: DEFAULT_GOOGLE_MODEL,
        prompt: 'test prompt',
        ratio: '1:1',
        quality: '1K',
        count: 2,
      },
      controller.signal,
    )

    expect(result.requestedCount).toBe(2)
    expect(result.failedCount).toBe(1)
    expect(result.items).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors![0].index).toBe(1)
    expect(result.attachment).toBeDefined()
  })

  it('throws error when all requests in batch fail', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Upstream error', { status: 500 }))

    const ctx = {
      credentials: {
        resolve: vi.fn().mockResolvedValue({ value: 'fake-key' }),
      },
      attachments: {
        imageLimits: {
          maxImageBytes: 10 * 1024 * 1024,
          mediaTypes: ['image/jpeg'],
        },
        saveImage: vi.fn(),
      },
      logger: { warn: vi.fn() },
    } as any

    const controller = new AbortController()
    await expect(generateFromStudio(
      ctx,
      {},
      {
        mode: 'generate',
        provider: 'google',
        model: DEFAULT_GOOGLE_MODEL,
        prompt: 'test prompt',
        ratio: '1:1',
        quality: '1K',
        count: 2,
      },
      controller.signal,
    )).rejects.toThrow()
  })

  it('rejects with a configuration hint when the credential is missing', async () => {
    // The missing/empty/whitespace classification itself is covered by the
    // tool-level suite against the shared resolver; this only wires the studio
    // entry point to that shared behaviour.
    const ctx = {
      credentials: { resolve: vi.fn().mockResolvedValue(undefined) },
      attachments: {
        imageLimits: { maxImageBytes: 10 * 1024 * 1024, mediaTypes: ['image/jpeg'] },
        saveImage: vi.fn(),
      },
      logger: { warn: vi.fn() },
    } as any
    const fetchMock = vi.fn(() => { throw new Error('fetch must not be called') })
    globalThis.fetch = fetchMock as any

    await expect(generateFromStudio(
      ctx,
      {},
      {
        mode: 'generate',
        provider: 'seedream',
        model: DEFAULT_SEEDREAM_MODEL,
        prompt: 'test prompt',
        ratio: 'auto',
        quality: '2K',
      },
      new AbortController().signal,
    )).rejects.toThrow('Seedream 尚未配置 API Key，请先到 设置 > 插件 > 图像生成 配置')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test doubles shared by the subscription workbench suites.
// ---------------------------------------------------------------------------

/** Minimal Context shape the studio paths touch (credentials + attachments). */
function studioCtx(): any {
  return {
    credentials: {
      resolve: vi.fn().mockResolvedValue(undefined),
    },
    attachments: {
      imageLimits: {
        maxImageBytes: 10 * 1024 * 1024,
        mediaTypes: ['image/jpeg', 'image/png'],
      },
      saveImage: vi.fn().mockImplementation(async ({ mediaType }: { mediaType: string }) => ({
        attachmentId: `att-${saveImageSeq++}`,
        mediaType,
        bytes: 100,
      })),
      readImage: vi.fn(async (ref: { attachmentId: string }) => ({
        ref: { attachmentId: ref.attachmentId, mediaType: 'image/png' },
        data: new Uint8Array(10),
      })),
      validateImage: vi.fn(async ({ data }: { data: Uint8Array }) => {
        if (data.byteLength === 0) throw new Error('参考图编码无效')
      }),
    },
    logger: { warn: vi.fn() },
  }
}

let saveImageSeq = 0

interface StubSubscriptionManager extends SubscriptionManager {
  generateCalls: Array<{ vendor: SubscriptionVendor; prompt: string; referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }> }>
}

/** 1x1 PNG the stub generate() returns; passes the format sniffing. */
const TINY_PNG = 'iVBORw0KGgo='

/** In-memory SubscriptionManager: status per provider, generated PNGs, no network. */
function stubSubscriptionManager(statuses: Partial<Record<SubscriptionProvider, { state: 'logged-in'; email: string } | { state: 'logged-out' }>>): StubSubscriptionManager {
  const generateCalls: Array<{ vendor: SubscriptionVendor; prompt: string; referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }> }> = []
  const manager = {
    generateCalls,
    async loginStatus(vendor: SubscriptionVendor) {
      const provider = vendor === 'codex' ? 'chatgpt-sub' as const
        : vendor === 'antigravity' ? 'google-sub' as const
        : 'grok-sub' as const
      const status = statuses[provider]
      return status?.state === 'logged-in' ? { state: 'logged-in' as const, email: status.email } : { state: 'logged-out' as const }
    },
    async generate(options: { vendor: SubscriptionVendor; prompt: string; referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }> }) {
      const vendor = options.vendor
      const provider = vendor === 'codex' ? 'chatgpt-sub' as const
        : vendor === 'antigravity' ? 'google-sub' as const
        : 'grok-sub' as const
      const status = statuses[provider]
      if (status?.state !== 'logged-in') throw new Error(`${String(vendor)} is not logged in`)
      generateCalls.push({ vendor, prompt: options.prompt, ...(options.referenceImages !== undefined ? { referenceImages: options.referenceImages } : {}) })
      return [{ b64_json: TINY_PNG }]
    },
  }
  return manager as unknown as StubSubscriptionManager
}

describe('openai-compat size table', () => {
  const table = {
    '1:1': { '1K': '1024x1024', '4K': '4096x4096' },
    '16:9': { '1K': '1536x864', '2K': '2048x1152', '4K': '3840x2160' },
  }

  it('keeps the legacy standard profile when no table is configured', () => {
    const legacy = studioProfile({}, 'openai-compat', true)
    expect(legacy.ratioOptions.map(option => option.value)).toEqual(['1:1', '3:2', '2:3'])
    expect(legacy.qualityOptions).toEqual([{ value: 'standard', label: '标准（推荐）' }])
    expect(legacy.defaultQuality).toBe('standard')
    expect(openAIRequestSize({}, '3:2', 'standard')).toBe('1536x1024')
  })

  it('derives ratio and tier options from the configured table', () => {
    const derived = studioProfile({ openaiCompatSizes: table, openaiCompatModel: 'image-2', openaiCompatBaseURL: 'https://relay.example/v1' }, 'openai-compat', true)
    expect(derived.ratioOptions.map(option => option.value)).toEqual(['1:1', '16:9'])
    expect(derived.qualityOptions.map(option => option.value)).toEqual(['1K', '2K', '4K'])
    expect(derived.defaultRatio).toBe('1:1')
    expect(derived.defaultQuality).toBe('2K')
  })

  it('sends the exact configured size for a supported combination', () => {
    expect(openAIRequestSize({ openaiCompatSizes: table }, '16:9', '2K')).toBe('2048x1152')
  })

  it('falls down to the largest tier below the request, never up', () => {
    expect(openAIRequestSize({ openaiCompatSizes: table }, '16:9', '4K')).toBe('3840x2160')
    expect(openAIRequestSize({ openaiCompatSizes: table }, '1:1', '2K')).toBe('1024x1024')
  })

  it('rejects a ratio that offers nothing at or below the requested tier', () => {
    expect(() => openAIRequestSize({ openaiCompatSizes: { '1:1': { '4K': '4096x4096' } } }, '1:1', '1K')).toThrow('清晰度')
  })

  it('keeps the legacy trio mapping for ratios outside the table', () => {
    expect(openAIRequestSize({ openaiCompatSizes: table }, '2:3', '1K')).toBe('1024x1536')
  })
})
