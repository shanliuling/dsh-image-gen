import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { DEFAULT_GOOGLE_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_SEEDREAM_MODEL, DEFAULT_DASHSCOPE_MODEL, DEFAULT_XAI_MODEL, DEFAULT_ZHIPU_MODEL } from '../src/config.js'
import { generateFromStudio, runPool, studioProfile, describeStudio, openAIRequestSize } from '../src/studio.js'
import { parseStudioGenerateRequest, serveStudio } from '../src/studio-route.js'
import { SUBSCRIPTION_PROVIDERS, DEFAULT_SUBSCRIPTION_MODELS, SUBSCRIPTION_TIMEOUT_MS, STUDIO_PROVIDERS, CLOUD_IMAGE_PROVIDERS, studioModelOptionsForMode, type StudioProvider, type SubscriptionProvider } from '../src/shared.js'
import { SUBSCRIPTION_CAPABILITIES } from '../src/capabilities.js'
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
import { buildComparisonTargets, comparisonOptionUnion, initialComparisonProviders } from '../src/client/multi-model-compare.js'

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

  it('keeps named compat channels as independent comparison targets', () => {
    const config = {
      openaiCompatBaseURL: 'https://legacy.example/v1', openaiCompatModel: 'legacy-model',
      openaiCompatChannels: [{ id: 'relay-b', label: 'Relay B', keyRef: '', baseURL: 'https://relay-b.example/v1', model: 'relay-b-model' }],
    }
    const channelProfiles = [
      studioProfile(config, 'openai-compat', true, 'default'),
      studioProfile(config, 'openai-compat', true, 'relay-b'),
    ]
    expect(initialComparisonProviders(channelProfiles, 'openai-compat', 'relay-b')).toEqual(['openai-compat:relay-b', 'openai-compat:default'])
    expect(buildComparisonTargets(channelProfiles, ['openai-compat:default', 'openai-compat:relay-b'], '1:1', 'standard')
      .map(target => target.profile.channel)).toEqual(['default', 'relay-b'])
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
      // openai speaks 16:9 now but tops out at low/medium/high, so only the
      // quality falls back to its default.
      { provider: 'openai', ratio: '16:9', quality: 'auto', adjusted: true },
      { provider: 'seedream', ratio: '16:9', quality: '4K', adjusted: false },
    ])
  })

  it('unions configured profile options for the shared comparison pickers in canonical order', () => {
    const chatgptSub = {
      provider: 'chatgpt-sub' as StudioProvider,
      label: 'ChatGPT 订阅',
      model: DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
      configured: true,
      supportsEditing: true,
      ...SUBSCRIPTION_CAPABILITIES['chatgpt-sub'],
    }
    const unionProfiles = [...profiles, chatgptSub]
    expect(comparisonOptionUnion(unionProfiles, 'ratioOptions').map(option => option.value)).toEqual([
      'auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9',
    ])
    // dashscope is signed out above, so its `standard` tier stays out of the union.
    expect(comparisonOptionUnion(unionProfiles, 'qualityOptions').map(option => option.value)).toEqual([
      'auto', '1K', '2K', '3K', '4K', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
  })
})

describe('image workbench provider capabilities', () => {
  it('exposes only parameters implemented by each cloud adapter', () => {
    const google = studioProfile({}, 'google', true)
    expect(google).toMatchObject({ model: DEFAULT_GOOGLE_MODEL, defaultRatio: '1:1', defaultQuality: '1K', configured: true })
    expect(google.ratioOptions.map(option => option.value)).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'])
    expect(google.qualityOptions.map(option => option.value)).toEqual(['1K', '2K', '4K'])

    const openai = studioProfile({}, 'openai', false)
    expect(openai).toMatchObject({ model: DEFAULT_OPENAI_MODEL, defaultRatio: '1:1', defaultQuality: 'auto', configured: false })
    expect(openai.ratioOptions.map(option => option.value)).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])
    expect(openai.qualityOptions.map(option => option.value)).toEqual(['auto', 'low', 'medium', 'high'])

    const seedream = studioProfile({}, 'seedream', true)
    expect(seedream).toMatchObject({ model: DEFAULT_SEEDREAM_MODEL, defaultRatio: 'auto', defaultQuality: '2K', configured: true })
    // Seedream 5.0 dropped the 1K tier and gained 3K; picking 1K used to be a
    // guaranteed upstream error.
    expect(seedream.ratioOptions.map(o => o.value)).toEqual(['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'])
    expect(seedream.qualityOptions.map(o => o.value)).toEqual(['2K', '3K', '4K'])

    const dashscope = studioProfile({}, 'dashscope', true)
    expect(dashscope).toMatchObject({ model: DEFAULT_DASHSCOPE_MODEL, defaultRatio: '1:1', defaultQuality: 'standard', configured: true })
    expect(dashscope.ratioOptions.map(o => o.value)).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])

    // xAI takes aspect_ratio+resolution, not size — the profile must not offer
    // pixel tiers it cannot express.
    const xai = studioProfile({}, 'xai', true)
    expect(xai).toMatchObject({ model: DEFAULT_XAI_MODEL, defaultRatio: 'auto', defaultQuality: '1k', configured: true })
    expect(xai.ratioOptions.map(o => o.value)).toEqual(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'])
    expect(xai.qualityOptions.map(o => o.value)).toEqual(['1k', '2k'])

    const zhipu = studioProfile({}, 'zhipu', true)
    expect(zhipu).toMatchObject({ model: DEFAULT_ZHIPU_MODEL, defaultRatio: '1:1', defaultQuality: 'hd', configured: true })
    expect(zhipu.ratioOptions.map(o => o.value)).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])
    expect(zhipu.qualityOptions.map(o => o.value)).toEqual(['hd'])
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

  it('accepts a compat channel id and rejects it for other providers', () => {
    expect(parseStudioGenerateRequest({ ...base, provider: 'openai-compat', model: 'relay-image', channel: ' relay-b ' }))
      .toMatchObject({ provider: 'openai-compat', channel: 'relay-b' })
    expect(() => parseStudioGenerateRequest({ ...base, channel: 'relay-b' })).toThrow('仅 OpenAI 兼容 Provider 支持选择渠道')
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

  it('rejects ComfyUI at the browser boundary and accepts long prompts', () => {
    expect(() => parseStudioGenerateRequest({ ...base, provider: 'comfyui' as never })).toThrow('Provider')
    expect(() => parseStudioGenerateRequest({ ...base, prompt: '' })).toThrow('请输入提示词')
    expect(parseStudioGenerateRequest({ ...base, prompt: 'x'.repeat(20_000) })).toMatchObject({ prompt: 'x'.repeat(20_000) })
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

  it('exposes signed-in subscriptions as configured rows with their full parameter pickers', async () => {
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
    expect(chatgpt.ratioOptions.map(o => o.value)).toEqual(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])
    expect(chatgpt.qualityOptions.map(o => o.value)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])

    const grok = byProvider.get('grok-sub')!
    expect(grok).toMatchObject({ configured: true, defaultRatio: 'auto', defaultQuality: '1k' })
    expect(grok.ratioOptions.map(o => o.value)).toEqual(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'])
    expect(grok.qualityOptions.map(o => o.value)).toEqual(['1k', '2k'])

    const googleSub = byProvider.get('google-sub')!
    expect(googleSub).toMatchObject({ configured: false, defaultRatio: 'auto', defaultQuality: 'standard' })
    expect(googleSub.ratioOptions.map(o => o.value)).toEqual(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'])
    expect(googleSub.qualityOptions.map(o => o.value)).toEqual(['standard', 'hd'])
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
  it('forwards selected subscription ratio and quality through the shared wrapper', async () => {
    for (const [provider, vendor, ratio, quality, size] of [
      ['chatgpt-sub', 'codex', '9:16', 'high', '864x1536'],
      ['grok-sub', 'grok', '9:16', '2k', '9:16'],
      ['google-sub', 'antigravity', '9:16', 'hd', '9:16'],
    ] as const) {
      const manager = stubSubscriptionManager({ [provider]: { state: 'logged-in', email: 'user@example.com' } })
      await generateFromStudio(studioCtx(), {}, {
        mode: 'generate', provider, model: DEFAULT_SUBSCRIPTION_MODELS[provider],
        prompt: 'a warm editorial portrait', ratio, quality,
      }, new AbortController().signal, undefined, manager)
      expect(manager.generateCalls).toEqual([{ vendor, prompt: 'a warm editorial portrait', size, quality }])
    }
  })

  it('reports actual attachment dimensions when the subscription returns a square image for 9:16', async () => {
    const manager = stubSubscriptionManager({ 'chatgpt-sub': { state: 'logged-in', email: 'user@example.com' } })
    vi.spyOn(manager, 'generate').mockResolvedValueOnce([{ b64_json: TINY_PNG, reportedQuality: 'medium' }])
    const ctx = studioCtx()
    ctx.attachments.saveImage.mockImplementation(async ({ mediaType }: { mediaType: string }) => ({
      attachmentId: 'att-square', mediaType, bytes: 100, width: 1254, height: 1254,
    }))
    const result = await generateFromStudio(ctx, {}, {
      mode: 'generate', provider: 'chatgpt-sub', model: DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
      prompt: 'a warm editorial portrait', ratio: '9:16', quality: 'high',
    }, new AbortController().signal, undefined, manager)
    expect(result.output).toContain('请求 9:16, high')
    expect(result.output).toContain('实际 1254×1254')
    expect(result.output).toContain('服务端回报清晰度 medium')
    expect(result.output).toContain('比例未生效')
  })

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
        quality: '1k',
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
        quality: '1k',
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
        quality: '1k',
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
        quality: 'standard',
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
  // Mirror the real subscription pickers from the capability table so the
  // mapping assertions stay honest when the table changes.
  const subProfile = (provider: SubscriptionProvider, configured: boolean) => ({
    provider,
    label: provider,
    model: DEFAULT_SUBSCRIPTION_MODELS[provider],
    configured,
    supportsEditing: true,
    ...SUBSCRIPTION_CAPABILITIES[provider],
  })

  it('maps one shared intent onto mixed API-key and subscription rows', () => {
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
      // Both speak 16:9 now; neither has a 4K tier, so quality alone falls back.
      { provider: 'openai', ratio: '16:9', quality: 'auto' },
      { provider: 'chatgpt-sub', ratio: '16:9', quality: 'auto' },
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
    }, 'another version')).toMatchObject({ ratio: '3:2', quality: 'auto' })
    expect(conversationRegenerateRequest({
      provider: 'dashscope', model: DEFAULT_DASHSCOPE_MODEL, output: '928*1664',
    }, 'another version')).toMatchObject({ ratio: '9:16', quality: 'standard' })
    expect(conversationRegenerateRequest({
      provider: 'openai-compat', channel: 'relay-b', model: 'relay-image', output: '1024x1024',
    }, 'another version')).toMatchObject({ provider: 'openai-compat', channel: 'relay-b' })
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
  generateCalls: Array<{ vendor: SubscriptionVendor; prompt: string; size?: string; quality?: string; referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }> }>
}

/** 1x1 PNG the stub generate() returns; passes the format sniffing. */
const TINY_PNG = 'iVBORw0KGgo='

/** In-memory SubscriptionManager: status per provider, generated PNGs, no network. */
function stubSubscriptionManager(statuses: Partial<Record<SubscriptionProvider, { state: 'logged-in'; email: string } | { state: 'logged-out' }>>): StubSubscriptionManager {
  const generateCalls: StubSubscriptionManager['generateCalls'] = []
  const manager = {
    generateCalls,
    async loginStatus(vendor: SubscriptionVendor) {
      const provider = vendor === 'codex' ? 'chatgpt-sub' as const
        : vendor === 'antigravity' ? 'google-sub' as const
        : 'grok-sub' as const
      const status = statuses[provider]
      return status?.state === 'logged-in' ? { state: 'logged-in' as const, email: status.email } : { state: 'logged-out' as const }
    },
    async generate(options: { vendor: SubscriptionVendor; prompt: string; size?: string; quality?: string; referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }> }) {
      const vendor = options.vendor
      const provider = vendor === 'codex' ? 'chatgpt-sub' as const
        : vendor === 'antigravity' ? 'google-sub' as const
        : 'grok-sub' as const
      const status = statuses[provider]
      if (status?.state !== 'logged-in') throw new Error(`${String(vendor)} is not logged in`)
      generateCalls.push({ vendor, prompt: options.prompt,
        ...(options.size !== undefined ? { size: options.size } : {}),
        ...(options.quality !== undefined ? { quality: options.quality } : {}),
        ...(options.referenceImages !== undefined ? { referenceImages: options.referenceImages } : {}),
      })
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

  it.each([{}, { openaiCompatBaseURL: 'https://relay.example/v1' }, { openaiCompatModel: 'image-2' }])('exposes independent quality before relay setup is complete: %j', config => {
    const incomplete = studioProfile(config, 'openai-compat', true)
    expect(incomplete).toMatchObject({ model: '', configured: false, defaultGenerationQuality: '__default__' })
    expect(incomplete.generationQualityOptions?.map(option => option.value)).toEqual(['__default__', 'auto', 'low', 'medium', 'high'])
    expect(incomplete.resolutionOptions?.['1:1']).toEqual([{ value: 'standard', label: '标准 · 1024x1024' }])
  })

  it('retains custom sizes and quality even before the relay model is configured', () => {
    const incomplete = studioProfile({ openaiCompatSizes: table, openaiCompatQuality: 'best', openaiCompatQualityOptions: ['draft', 'best'] }, 'openai-compat', false)
    expect(incomplete.ratioOptions.map(option => option.value)).toEqual(['1:1', '16:9'])
    expect(incomplete.resolutionOptions?.['16:9']?.map(option => option.label)).toEqual(['1K · 1536x864', '2K · 2048x1152', '4K · 3840x2160'])
    expect(incomplete.generationQualityOptions?.map(option => option.value)).toEqual(['__default__', 'draft', 'best'])
    expect(incomplete.defaultGenerationQuality).toBe('best')
  })

  it('derives ratio and tier options from the configured table', () => {
    const derived = studioProfile({ openaiCompatSizes: table, openaiCompatModel: 'image-2', openaiCompatBaseURL: 'https://relay.example/v1' }, 'openai-compat', true)
    expect(derived.ratioOptions.map(option => option.value)).toEqual(['1:1', '16:9'])
    expect(derived.qualityOptions.map(option => option.value)).toEqual(['1K', '2K', '4K'])
    expect(derived.defaultRatio).toBe('1:1')
    // The 1:1 row tops out at 1K/4K: a global 2K default would silently
    // downsample, so the default quality comes from the default ratio itself.
    expect(derived.defaultQuality).toBe('1K')
  })

  it('keeps the default pair generatable on a sparse table', () => {
    const sparse = { '16:9': { '1K': '1536x864' }, '21:9': { '2K': '5120x2176' } }
    const derived = studioProfile({ openaiCompatSizes: sparse, openaiCompatModel: 'image-2', openaiCompatBaseURL: 'https://relay.example/v1' }, 'openai-compat', true)
    // Old behavior picked the global 2K default here, and 16:9 offers nothing
    // at or below it — the first generate would reject before any user input.
    expect(derived.defaultRatio).toBe('16:9')
    expect(derived.defaultQuality).toBe('1K')
    expect(openAIRequestSize({ openaiCompatSizes: sparse }, derived.defaultRatio, derived.defaultQuality)).toBe('1536x864')
  })

  it('prefers 2K as the default when the default ratio offers it', () => {
    const derived = studioProfile({ openaiCompatSizes: { '1:1': { '1K': '1024x1024', '2K': '2048x2048' } }, openaiCompatModel: 'image-2', openaiCompatBaseURL: 'https://relay.example/v1' }, 'openai-compat', true)
    expect(derived.defaultRatio).toBe('1:1')
    expect(derived.defaultQuality).toBe('2K')
  })

  it('falls back to the default ratio\'s lowest tier when it has no 2K row', () => {
    const derived = studioProfile({ openaiCompatSizes: { '4:3': { '1K': '1536x1152', '4K': '3072x2304' } }, openaiCompatModel: 'image-2', openaiCompatBaseURL: 'https://relay.example/v1' }, 'openai-compat', true)
    expect(derived.defaultRatio).toBe('4:3')
    expect(derived.defaultQuality).toBe('1K')
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

describe('openai-compat model choices', () => {
  const config = {
    openaiCompatBaseURL: 'https://relay.example/v1',
    openaiCompatModel: 'image-2',
    openaiCompatModels: ['image-2.5', 'image-2'],
  }

  it('exposes the configured list and falls back to the legacy single model', () => {
    const current = studioProfile(config, 'openai-compat', true)
    expect(current.model).toBe('image-2')
    expect(studioModelOptionsForMode(current, 'generate').map(option => option.value)).toEqual(['image-2.5', 'image-2'])
    const legacy = studioProfile({ openaiCompatBaseURL: config.openaiCompatBaseURL, openaiCompatModel: config.openaiCompatModel }, 'openai-compat', true)
    expect(studioModelOptionsForMode(legacy, 'generate').map(option => option.value)).toEqual(['image-2'])
  })

  it('keeps the independent edit model ahead of the generation list', () => {
    const editing = studioProfile({ ...config, openaiCompatEditModel: 'image-edit' }, 'openai-compat', true)
    expect(studioModelOptionsForMode(editing, 'edit').map(option => option.value)).toEqual(['image-edit'])
    expect(studioModelOptionsForMode(editing, 'generate').map(option => option.value)).toEqual(['image-2.5', 'image-2'])
  })
})

describe('openai-compat named channels', () => {
  const config = {
    provider: 'openai-compat' as const,
    openaiCompatLabel: 'Legacy relay',
    openaiCompatBaseURL: 'https://legacy.example/v1',
    openaiCompatModel: 'legacy-model',
    openaiCompatModels: ['legacy-model'],
    openaiCompatChannels: [{
      id: 'relay-b', label: 'Relay B', keyRef: '', baseURL: 'https://relay-b.example/v1', model: 'relay-b-model',
      models: ['relay-b-model'], quality: 'high', qualityOptions: ['low', 'high'], extraBody: { watermark: false },
      sizes: { '16:9': { '2K': '2048x1152' } },
    }],
    openaiCompatActiveChannel: 'relay-b',
    saveToWorkspace: false,
  }

  it('describes every channel and resolves credential status independently', async () => {
    const ctx = studioCtx()
    ctx.credentials.resolve.mockImplementation(async (ref: unknown) => JSON.stringify(ref).includes('RELAY_B') ? { value: 'key-b' } : undefined)
    const described = await describeStudio(ctx, config)
    expect(described.activeProvider).toBe('openai-compat')
    expect(described.activeChannel).toBe('relay-b')
    expect(described.providers.filter(profile => profile.provider === 'openai-compat').map(profile => ({
      channel: profile.channel, label: profile.label, model: profile.model, configured: profile.configured,
    }))).toEqual([
      { channel: 'default', label: 'Legacy relay', model: 'legacy-model', configured: false },
      { channel: 'relay-b', label: 'Relay B', model: 'relay-b-model', configured: true },
    ])
  })

  it('uses only the selected channel endpoint, credential and generation fields', async () => {
    const ctx = studioCtx()
    ctx.credentials.resolve.mockImplementation(async (ref: unknown) => ({ value: JSON.stringify(ref).includes('RELAY_B') ? 'key-b' : 'legacy-key' }))
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    try {
      const result = await generateFromStudio(ctx, config, {
        mode: 'generate', provider: 'openai-compat', channel: 'relay-b', model: 'relay-b-model', prompt: 'lake',
        ratio: '16:9', quality: '2K', generationQuality: 'high',
      }, new AbortController().signal)
      expect(result.channel).toBe('relay-b')
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://relay-b.example/v1/images/generations')
      expect(init.headers).toMatchObject({ authorization: 'Bearer key-b' })
      expect(JSON.parse(String(init.body))).toEqual({ model: 'relay-b-model', prompt: 'lake', size: '2048x1152', quality: 'high', watermark: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('OpenAI studio dimensions, quality and generation extras (#73, #74)', () => {
  const signal = new AbortController().signal
  const relayConfig = { openaiCompatModel: 'relay-image', openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatSizes: { '16:9': { '2K': '2048x1152' } }, saveToWorkspace: false }
  afterEach(() => vi.unstubAllGlobals())
  const setup = () => {
    const ctx = studioCtx()
    ctx.credentials.resolve.mockResolvedValue({ value: 'test-key' })
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    return { ctx, fetch }
  }
  it('changes quality without changing the selected official pixel dimensions', async () => {
    const { ctx, fetch } = setup()
    for (const quality of ['low', 'high']) await generateFromStudio(ctx, { saveToWorkspace: false }, { mode: 'generate', provider: 'openai', model: DEFAULT_OPENAI_MODEL, prompt: 'landscape', ratio: '16:9', quality, resolution: '2K' }, signal)
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { model: DEFAULT_OPENAI_MODEL, prompt: 'landscape', size: '2048x1152', quality: 'low' },
      { model: DEFAULT_OPENAI_MODEL, prompt: 'landscape', size: '2048x1152', quality: 'high' },
    ])
  })
  it('forwards false and nested generation fields after the normal request fields', async () => {
    const { ctx, fetch } = setup()
    await generateFromStudio(ctx, { ...relayConfig, openaiCompatQuality: 'high', openaiCompatExtraBody: { watermark: false, prompt_extend: false, vendor: { strength: 0 }, quality: 'low' } }, { mode: 'generate', provider: 'openai-compat', model: 'relay-image', prompt: 'lake', ratio: '16:9', quality: '2K', count: 2 }, signal)
    for (const [, init] of fetch.mock.calls) expect(JSON.parse(String(init?.body))).toMatchObject({ size: '2048x1152', quality: 'low', watermark: false, prompt_extend: false, vendor: { strength: 0 } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('preserves omission for existing compatible configurations', async () => {
    const { ctx, fetch } = setup()
    await generateFromStudio(ctx, relayConfig, { mode: 'generate', provider: 'openai-compat', model: 'relay-image', prompt: 'lake', ratio: '16:9', quality: '2K' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ model: 'relay-image', prompt: 'lake', size: '2048x1152' })
  })
  it('sends a selected configured model and rejects models outside the list', async () => {
    const { ctx, fetch } = setup()
    const config = { ...relayConfig, openaiCompatModels: ['relay-image', 'relay-image-2.5'] }
    await generateFromStudio(ctx, config, { mode: 'generate', provider: 'openai-compat', model: 'relay-image-2.5', prompt: 'lake', ratio: '16:9', quality: '2K' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'relay-image-2.5' })
    await expect(generateFromStudio(ctx, config, { mode: 'generate', provider: 'openai-compat', model: 'unlisted-model', prompt: 'lake', ratio: '16:9', quality: '2K' }, signal)).rejects.toThrow('模型配置已变化')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['multipart', 'formReferenceImages', 'jsonImageUrlArray'] as const)('forwards quality through %s edits without leaking generation extras', async editFormat => {
    const { ctx, fetch } = setup()
    await generateFromStudio(ctx, { ...relayConfig, openaiCompatEditFormat: editFormat, openaiCompatEditSizeMode: 'selected', openaiCompatExtraBody: { watermark: false } }, { mode: 'edit', provider: 'openai-compat', model: 'relay-image', prompt: 'lake', ratio: '16:9', quality: '2K', generationQuality: 'high', reference: { mediaType: 'image/png', data: TINY_PNG } }, signal)
    const body = fetch.mock.calls[0]?.[1]?.body
    const fields = body instanceof FormData ? Object.fromEntries(body.entries()) : JSON.parse(String(body))
    expect(fields).toMatchObject({ quality: 'high', size: '2048x1152' })
    expect(fields).not.toHaveProperty('watermark')
  })
  it('keeps auto sizing for SenseNova JSON edits by default', async () => {
    const { ctx, fetch } = setup()
    await generateFromStudio(ctx, { ...relayConfig, openaiCompatEditFormat: 'jsonImageUrlArray', openaiCompatEditExtra: { watermark: false } }, { mode: 'edit', provider: 'openai-compat', model: 'relay-image', prompt: 'lake', ratio: '16:9', quality: '2K', generationQuality: 'high', reference: { mediaType: 'image/png', data: TINY_PNG } }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ size: 'auto', quality: 'high', watermark: false })
  })
  it('rejects unsupported official dimensions before fetching', async () => {
    const { ctx, fetch } = setup()
    await expect(generateFromStudio(ctx, { openaiSizes: { '1:1': { '4K': '4096x4096' } }, saveToWorkspace: false }, { mode: 'generate', provider: 'openai', model: DEFAULT_OPENAI_MODEL, prompt: 'lake', ratio: '1:1', quality: 'high', resolution: '4K' }, signal)).rejects.toThrow('尺寸')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses the lowest custom official tier for legacy requests without resolution', async () => {
    const { ctx, fetch } = setup()
    await generateFromStudio(ctx, { openaiSizes: { '16:9': { '4K': '3840x2160', '2K': '2048x1152' } }, saveToWorkspace: false }, { mode: 'generate', provider: 'openai', model: DEFAULT_OPENAI_MODEL, prompt: 'lake', ratio: '16:9', quality: 'high' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ size: '2048x1152', quality: 'high' })
  })
  it('parses independent fields while accepting legacy requests', () => {
    const request = { mode: 'generate', provider: 'openai', model: DEFAULT_OPENAI_MODEL, prompt: 'lake', ratio: '16:9', quality: 'high' }
    expect(parseStudioGenerateRequest(request)).not.toHaveProperty('resolution')
    expect(parseStudioGenerateRequest({ ...request, resolution: '2K', generationQuality: 'high' })).toMatchObject({ resolution: '2K', generationQuality: 'high' })
    expect(() => parseStudioGenerateRequest({ ...request, resolution: 2 })).toThrow('分辨率')
  })
  it('shows watermark choices for the known official contract and existing configured fields', () => {
    const official = { openaiCompatBaseURL: 'https://token.sensenova.cn/v1', openaiCompatModel: 'sensenova-u1.5-lite' }
    expect(studioProfile(official, 'openai-compat', false).watermarkOptions?.map(option => option.value)).toEqual(['default', 'off', 'on'])
    expect(studioProfile({ ...relayConfig, openaiCompatModel: 'sensenova-u1.5-lite' }, 'openai-compat', true)).not.toHaveProperty('watermarkOptions')
    expect(studioProfile({ ...relayConfig, openaiCompatExtraBody: { watermark: false } }, 'openai-compat', true).watermarkOptions).toHaveLength(3)
  })
  it('sends an explicit official watermark choice on every image in a batch, without adding it by default', async () => {
    const { ctx, fetch } = setup()
    const config = { openaiCompatBaseURL: 'https://token.sensenova.cn/v1', openaiCompatModel: 'sensenova-u1.5-lite', saveToWorkspace: false }
    const request = { mode: 'generate' as const, provider: 'openai-compat' as const, model: config.openaiCompatModel, prompt: 'lake', ratio: '1:1', quality: 'standard' }
    await generateFromStudio(ctx, config, { ...request, watermark: 'default' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty('watermark')
    fetch.mockClear()
    await generateFromStudio(ctx, config, { ...request, watermark: 'off', count: 2 }, signal)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [, init] of fetch.mock.calls) expect(JSON.parse(String(init?.body))).toMatchObject({ watermark: false })
    fetch.mockClear()
    await generateFromStudio(ctx, { ...config, openaiCompatExtraBody: { watermark: false } }, { ...request, watermark: 'on' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ watermark: true })
  })
  it.each([
    { extra: { watermark: true, prompt_extend: false }, expected: { watermark: false, prompt_extend: false } },
    { extra: { watermark_enabled: true, vendor: { strength: 0 } }, expected: { watermark_enabled: false, vendor: { strength: 0 } } },
    { extra: { parameters: { watermark: true, seed: 0 } }, expected: { parameters: { watermark: false, seed: 0 } } },
  ])('overrides only the configured watermark field: $extra', async ({ extra, expected }) => {
    const { ctx, fetch } = setup()
    const config = { ...relayConfig, openaiCompatExtraBody: extra }
    const request = { mode: 'generate' as const, provider: 'openai-compat' as const, model: 'relay-image', prompt: 'lake', ratio: '16:9', quality: '2K' }
    await generateFromStudio(ctx, config, { ...request, watermark: 'off' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject(expected)
    await generateFromStudio(ctx, config, { ...request, watermark: 'default' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject(extra)
    expect(config.openaiCompatExtraBody).toEqual(extra)
  })
  it('rejects unconfigured watermark requests and edit overrides before fetching', async () => {
    const { ctx, fetch } = setup()
    const request = { mode: 'generate' as const, provider: 'openai-compat' as const, model: 'relay-image', prompt: 'lake', ratio: '16:9', quality: '2K', watermark: 'off' as const }
    await expect(generateFromStudio(ctx, relayConfig, request, signal)).rejects.toThrow('水印控制')
    await expect(generateFromStudio(ctx, { ...relayConfig, openaiCompatExtraBody: { watermark: false } }, { ...request, mode: 'edit', reference: { mediaType: 'image/png', data: TINY_PNG } }, signal)).rejects.toThrow('水印控制')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('accepts the three watermark choices and rejects invalid wire values', () => {
    const request = { mode: 'generate', provider: 'openai-compat', model: 'relay', prompt: 'lake', ratio: '1:1', quality: 'standard' }
    for (const watermark of ['default', 'off', 'on']) expect(parseStudioGenerateRequest({ ...request, watermark }).watermark).toBe(watermark)
    for (const watermark of [false, 'false', '', 'unknown']) expect(() => parseStudioGenerateRequest({ ...request, watermark })).toThrow('水印选项')
  })
})

describe('workbench watermark request mapping', () => {
  const signal = new AbortController().signal
  afterEach(() => vi.unstubAllGlobals())
  const channels = [
    { provider: 'seedream' as const, config: { seedreamWatermark: false, seedreamModel: 'doubao-seedream-4-0-250828' }, model: 'doubao-seedream-4-0-250828', field: 'watermark' },
    { provider: 'dashscope' as const, config: {}, model: 'qwen-image-3.0', field: 'parameters.watermark' },
    { provider: 'openai-compat' as const, config: { openaiCompatBaseURL: 'https://token.sensenova.cn/v1', openaiCompatModel: 'sensenova-u1.5-lite' }, model: 'sensenova-u1.5-lite', field: 'watermark' },
    { provider: 'openai-compat' as const, config: { openaiCompatBaseURL: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', openaiCompatModel: 'qwen-image-3.0' }, model: 'qwen-image-3.0', field: 'watermark' },
  ]
  it.each(channels.flatMap(channel => ['generate', 'edit'].map(mode => ({ ...channel, mode: mode as 'generate' | 'edit' }))))('$provider $model $mode preserves defaults and overrides both boolean values', async channel => {
    const ctx = studioCtx()
    ctx.credentials.resolve.mockResolvedValue({ value: 'test-key' })
    const fetch = vi.fn(async (url: unknown, _init?: RequestInit) => {
      if (String(url) === 'https://result.example/image.png') return new Response(Buffer.from(TINY_PNG, 'base64'), { headers: { 'content-type': 'image/png' } })
      const body = channel.provider === 'dashscope'
        ? { output: { choices: [{ message: { content: [{ image: 'https://result.example/image.png' }] } }] } }
        : { data: [{ b64_json: TINY_PNG }] }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const profile = studioProfile(channel.config, channel.provider, true)
    const request = { mode: channel.mode, provider: channel.provider, model: channel.model, prompt: 'lake', ratio: profile.defaultRatio, quality: profile.defaultQuality,
      ...(channel.mode === 'edit' ? { references: [{ mediaType: 'image/png' as const, data: TINY_PNG }, { mediaType: 'image/png' as const, data: TINY_PNG }] } : {}) }
    for (const watermark of ['default', 'off', 'on'] as const) {
      fetch.mockClear()
      await generateFromStudio(ctx, { ...channel.config, saveToWorkspace: false }, { ...request, watermark, count: 2 }, signal)
      const submissions = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(submissions).toHaveLength(2)
      for (const [url, init] of submissions) {
        const body = JSON.parse(String(init?.body))
        if (watermark === 'default' && channel.provider !== 'seedream') expect(body).not.toHaveProperty(channel.field)
        else expect(body).toHaveProperty(channel.field, watermark === 'on')
        if (channel.mode === 'edit') {
          const images = channel.provider === 'dashscope' ? body.input.messages[0].content.filter((item: { image?: string }) => item.image)
            : channel.model === 'sensenova-u1.5-lite' ? body.images : body.image
          expect(images).toHaveLength(2)
          expect(String(url)).toContain(channel.model === 'sensenova-u1.5-lite' ? '/images/edits'
            : channel.provider === 'dashscope' ? '/multimodal-generation/generation' : '/images/generations')
        }
      }
    }
  })
  it('keeps JSON edit defaults and unrelated nested fields while overriding a relay watermark', async () => {
    const ctx = studioCtx()
    ctx.credentials.resolve.mockResolvedValue({ value: 'test-key' })
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }] })))
    vi.stubGlobal('fetch', fetch)
    const config = { openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'custom', openaiCompatEditFormat: 'jsonImageUrlArray' as const,
      openaiCompatExtraBody: { watermark: true, generationOnly: 123 }, openaiCompatEditExtra: { parameters: { watermark: true, seed: 0 }, prompt_extend: false } }
    const request = { mode: 'edit' as const, provider: 'openai-compat' as const, model: 'custom', prompt: 'lake', ratio: '1:1', quality: 'standard', reference: { mediaType: 'image/png' as const, data: TINY_PNG } }
    await generateFromStudio(ctx, config, { ...request, watermark: 'off' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ size: 'auto', parameters: { watermark: false, seed: 0 }, prompt_extend: false })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty('generationOnly')
    await generateFromStudio(ctx, config, { ...request, watermark: 'default' }, signal)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject(config.openaiCompatEditExtra)
    expect(config.openaiCompatEditExtra.parameters.watermark).toBe(true)
  })
})

describe('streaming generation heartbeat', () => {
  it.each([
    ...CLOUD_IMAGE_PROVIDERS.map(provider => ({ provider, timeoutMs: 240_000, expectedMs: 240_000 })),
    { provider: 'google' as const, timeoutMs: 5_000, expectedMs: 5_000 },
    { provider: 'google' as const, timeoutMs: undefined, expectedMs: 150_000 },
    ...SUBSCRIPTION_PROVIDERS.map(provider => ({ provider, timeoutMs: 5_000, expectedMs: 300_000 })),
  ])('uses the generation timeout budget for $provider ($timeoutMs)', async ({ provider, timeoutMs, expectedMs }) => {
    vi.useFakeTimers()
    try {
      const req = Object.assign(Readable.from([JSON.stringify({
        mode: 'generate', provider, model: 'test-model', prompt: 'lake', ratio: '1:1', quality: '1K',
      })]), { method: 'POST', headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage
      const res = Object.assign(new EventEmitter(), {
        writeHead: vi.fn(), write: vi.fn(), end: vi.fn(),
        destroyed: false, writableEnded: false,
      })
      let generationSignal!: AbortSignal
      let started!: () => void
      const generating = new Promise<void>(resolve => { started = resolve })
      const serving = serveStudio(req, res as unknown as ServerResponse, {
        describe: async () => ({ providers: [], activeProvider: 'google' }),
        generate: (_input, signal) => {
          generationSignal = signal
          started()
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        },
        maxBodyBytes: 1024,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      await generating
      await vi.advanceTimersByTimeAsync(expectedMs - 1)
      expect(generationSignal.aborted).toBe(false)
      expect(res.end).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(generationSignal.aborted).toBe(true)
      await serving
      const budget = SUBSCRIPTION_PROVIDERS.includes(provider as SubscriptionProvider)
        ? `订阅通道 ${String(expectedMs / 1000)}` : String(expectedMs / 1000)
      const error = JSON.parse(res.end.mock.calls[0]![0] as string).error as string
      expect(error).toContain(`（${budget} 秒未返回）`)
      expect(error).toContain('上游可能已扣费或仍在生成，请到服务商后台确认')
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('sends headers plus heartbeat newlines while generating, then a parseable JSON body', async () => {
    const server = createServer()
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo
        resolve(`http://127.0.0.1:${addr.port}`)
      })
    })
    try {
      server.on('request', (req, res) => {
        void serveStudio(req, res, {
          describe: async () => ({ providers: [], activeProvider: 'google' }),
          generate: async () => {
            await new Promise(resolve => setTimeout(resolve, 120))
            return {
              attachment: { attachmentId: 'sha256:x' as any, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
              prompt: 'p', provider: 'google', model: DEFAULT_GOOGLE_MODEL, output: '1:1', createdAt: 1,
            }
          },
          maxBodyBytes: 1024 * 1024,
          heartbeatMs: 30,
        })
      })
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'generate', provider: 'google', model: DEFAULT_GOOGLE_MODEL, prompt: 'lake', ratio: '1:1', quality: '1K' }),
      })
      expect(response.headers.get('x-accel-buffering')).toBe('no')
      const text = await response.text()
      expect(text.startsWith('\n')).toBe(true)
      expect('attachment' in (JSON.parse(text) as Record<string, unknown>)).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('reports generation failures as { error } bodies after headers are sent', async () => {
    const server = createServer()
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo
        resolve(`http://127.0.0.1:${addr.port}`)
      })
    })
    try {
      server.on('request', (req, res) => {
        void serveStudio(req, res, {
          describe: async () => ({ providers: [], activeProvider: 'google' }),
          generate: async () => { throw new Error('provider exploded') },
          maxBodyBytes: 1024 * 1024,
          heartbeatMs: 30,
        })
      })
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'generate', provider: 'google', model: DEFAULT_GOOGLE_MODEL, prompt: 'lake', ratio: '1:1', quality: '1K' }),
      })
      expect(response.status).toBe(200)
      expect(JSON.parse(await response.text())).toMatchObject({ error: 'provider exploded' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
