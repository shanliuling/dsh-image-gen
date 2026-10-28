/** Provider-aware orchestration for the browser image workbench. */
import type { ImageAttachmentRef, ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import {
  ASPECT_RATIOS,
  IMAGE_SIZES,
  resolveProvider,
  withOpenAICompatChannel,
  withProviderOverrides,
  type AspectRatio,
  type Config,
  type ImageSize,
} from './config.js'
import { editDashScopeImage, generateDashScopeImage } from './dashscope.js'
import { requireApiKey, resolveApiKey } from './credentials.js'
import { editGoogleImage, generateGoogleImage } from './google.js'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from './openai-compatible.js'
import { editSeedreamImage } from './seedream.js'
import { generateSubscriptionImage, vendorOf, type SubscriptionManager } from './subscription.js'
import {
  CLOUD_IMAGE_PROVIDERS,
  DEFAULT_SUBSCRIPTION_MODELS,
  SUBSCRIPTION_PROVIDERS,
  isSubscriptionProvider,
  resolveOpenAICompatChannel,
  resolveOpenAICompatChannels,
  resolveOpenAICompatModels,
  studioWatermarkCapability,
  studioModelOptionsForMode,
  type CloudImageProvider,
  type StudioConfigResponse,
  type StudioGenerateRequest,
  type StudioGenerateResponse,
  type StudioGeneratedItem,
  type StudioOption,
  type StudioProviderProfile,
  type StudioReference,
  type SubscriptionProvider,
} from './shared.js'

import { CLOUD_CAPABILITIES, RATIO_LABELS, SUBSCRIPTION_CAPABILITIES } from './capabilities.js'
import { compatGenerationExtraBody, compatQualityOptions, compatRequestQuality, officialQualityOptions, officialSizeTable, validateOfficialSize, PROVIDER_DEFAULT_QUALITY } from './openai-output.js'
import { compatEditExtraBody, selectedWatermark, watermarkProfile } from './watermark.js'

const LEGACY_OPENAI_TABLE: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024' },
  '3:2': { '1K': '1536x1024' },
  '2:3': { '1K': '1024x1536' },
}

/** Preferred picker ordering for derived ratio options. */
const RATIO_ORDER = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9', '1:3', '3:1']

/** Ordering rank of a resolution tier label; unknown tiers keep given order. */
function tierRank(tier: string): number {
  const match = /^(\d+(?:\.\d+)?)(K?)$/.exec(tier.trim())
  if (match === null) return Number.NaN
  return match[2] === 'K' ? Number(match[1]) : Number(match[1]) / 1024
}

/**
 * Normalize the configured relay table: drop empty strings and invalid tier
 * ranks so one typo cannot take the whole workbench down.
 * @param config - plugin configuration carrying `openaiCompatSizes`.
 */
export function openAICompatTable(config: Config): Array<{ ratio: string; tiers: Array<{ tier: string; size: string; rank: number }> }> {
  const raw = config.openaiCompatSizes
  const table = raw !== undefined && Object.keys(raw).length > 0 ? raw : LEGACY_OPENAI_TABLE
  const groups: Array<{ ratio: string; tiers: Array<{ tier: string; size: string; rank: number }> }> = []
  for (const [ratio, tierMap] of Object.entries(table)) {
    const tiers: Array<{ tier: string; size: string; rank: number }> = []
    for (const [tier, size] of Object.entries(tierMap)) {
      if (typeof size !== 'string' || size.trim().length === 0) continue
      const rank = tierRank(tier)
      if (Number.isNaN(rank)) continue
      tiers.push({ tier, size: size.trim(), rank })
    }
    if (tiers.length === 0) continue
    tiers.sort((a, b) => a.rank - b.rank)
    groups.push({ ratio, tiers })
  }
  return groups.sort((a, b) => ratioPosition(a.ratio) - ratioPosition(b.ratio))
}

function ratioPosition(ratio: string): number {
  const index = RATIO_ORDER.indexOf(ratio)
  return index === -1 ? RATIO_ORDER.length : index
}

/**
 * Resolve the wire `size` for one workbench request against the relay table.
 * Falls down to the largest tier not exceeding the requested one (never up,
 * so an unsupported combination cannot silently spend more); unparseable
 * quality labels (legacy `standard`) map to the ratio's lowest tier, and a
 * ratio with nothing at or below the request is rejected loudly.
 * @param config - plugin configuration carrying `openaiCompatSizes`.
 * @param ratio - selected ratio option (`W:H`).
 * @param quality - selected resolution tier.
 */
export function openAIRequestSize(config: Config, ratio: string, quality: string): string {
  const group = openAICompatTable(config).find(entry => entry.ratio === ratio)
  if (group === undefined) {
    if (ratio === '3:2') return '1536x1024'
    if (ratio === '2:3') return '1024x1536'
    return '1024x1024'
  }
  const requested = tierRank(quality)
  const wanted = Number.isNaN(requested) ? group.tiers[0]!.rank : requested
  const withinBudget = group.tiers.filter(entry => entry.rank <= wanted)
  if (withinBudget.length === 0) {
    throw new Error(`该比例不支持 ${quality} 清晰度，请降低清晰度或更换比例`)
  }
  return withinBudget.reduce((best, entry) => (entry.rank > best.rank ? entry : best)).size
}

/** Workbench profile derived from the configured relay table. */
function openAICompatStudioProfile(config: Config, model: string, configured: boolean): StudioProviderProfile {
  const groups = openAICompatTable(config)
  const ratioOptions = groups.map(group => ({ value: group.ratio, label: RATIO_LABELS[group.ratio] ?? group.ratio }))
  const tierMap = new Map<string, StudioOption>()
  for (const group of groups) for (const entry of group.tiers) tierMap.set(entry.tier, { value: entry.tier, label: entry.tier })
  const qualityOptions = [...tierMap.values()].sort((a, b) => (tierRank(a.value) || 0) - (tierRank(b.value) || 0))
  // Defaults must form a generatable pair. A global "2K" default is wrong on a
  // sparse table: a default ratio whose tiers stop at 1K would either reject
  // outright or silently downsample before the user touches anything, so the
  // quality default comes from the default ratio's own tiers (2K preferred,
  // otherwise its lowest tier).
  const defaultRatio = ratioOptions.some(entry => entry.value === '1:1') ? '1:1' : (ratioOptions[0]?.value ?? '1:1')
  const defaultRatioTiers = groups.find(group => group.ratio === defaultRatio)?.tiers ?? []
  const defaultQuality = defaultRatioTiers.find(entry => entry.tier === '2K')?.tier
    ?? defaultRatioTiers[0]?.tier
    ?? (qualityOptions[0]?.value ?? 'standard')
  return profile(
    'openai-compat',
    model,
    configured,
    ratioOptions.length > 0 ? ratioOptions : ['1:1', '3:2', '2:3'].map(option),
    qualityOptions.length > 0 ? qualityOptions : [{ value: 'standard', label: '标准（推荐）' }],
    defaultRatio,
    defaultQuality,
  )
}

/** Return only browser-safe capability data. */
export async function describeStudio(
  ctx: Context,
  config: Config,
  subscriptions?: SubscriptionManager | undefined,
): Promise<StudioConfigResponse> {
  const compatChannels = resolveOpenAICompatChannels(config)
  const configuredEntries = await Promise.all([
    ...CLOUD_IMAGE_PROVIDERS.filter(provider => provider !== 'openai-compat').map(async provider => {
      return [provider, await resolveApiKey(ctx, provider) !== undefined] as const
    }),
    ...compatChannels.map(async channel => {
      return [`openai-compat:${channel.id}`, await resolveApiKey(ctx, 'openai-compat', channel.keyRef) !== undefined] as const
    }),
  ])
  const configured = Object.fromEntries(configuredEntries) as Record<string, boolean>
  const cloudProfiles = CLOUD_IMAGE_PROVIDERS.flatMap(provider => provider === 'openai-compat'
    ? compatChannels.map(channel => studioProfile(config, provider, configured[`openai-compat:${channel.id}`] === true, channel.id))
    : [studioProfile(config, provider, configured[provider] === true)])
  // Subscription profiles: configured means "signed in", and the parameter
  // matrix collapses to a single channel-default pair (prompt-only channels).
  const subStatuses = await Promise.all(SUBSCRIPTION_PROVIDERS.map(async provider => {
    return [provider, subscriptions !== undefined && (await subscriptions.loginStatus(vendorOf(provider))).state === 'logged-in'] as const
  }))
  const subProfiles = SUBSCRIPTION_PROVIDERS.map(provider => {
    const signedIn = subStatuses.find(entry => entry[0] === provider)?.[1] === true
    return subscriptionStudioProfile(provider, signedIn)
  })
  const profiles = [...cloudProfiles, ...subProfiles]
  const preferred = config.provider
  const activeProvider = isStudioPreferred(preferred)
    ? preferred
    : profiles.find(profile => profile.configured)?.provider ?? 'google'
  const activeChannel = activeProvider === 'openai-compat'
    ? profiles.find(profile => profile.provider === activeProvider && profile.channel === resolveOpenAICompatChannel(config).id)?.channel
      ?? profiles.find(profile => profile.provider === activeProvider)?.channel
    : undefined
  return { providers: profiles, activeProvider, ...(activeChannel === undefined ? {} : { activeChannel }) }
}

/** The persisted default provider is usable directly when the workbench can drive it. */
function isStudioPreferred(preferred: string | undefined): preferred is NonNullable<StudioConfigResponse['activeProvider']> {
  return preferred !== undefined && (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(preferred)
    || preferred !== undefined && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(preferred)
}

/** Subscription profiles come from the shared capability table (see capabilities.ts). */
function subscriptionStudioProfile(provider: SubscriptionProvider, signedIn: boolean): StudioProviderProfile {
  const cap = SUBSCRIPTION_CAPABILITIES[provider]
  return {
    provider,
    label: SUBSCRIPTION_DISPLAY_LABELS[provider],
    model: DEFAULT_SUBSCRIPTION_MODELS[provider],
    configured: signedIn,
    supportsEditing: true,
    ratioOptions: cap.ratioOptions,
    qualityOptions: cap.qualityOptions,
    defaultRatio: cap.defaultRatio,
    defaultQuality: cap.defaultQuality,
    ...watermarkProfile({}, provider, DEFAULT_SUBSCRIPTION_MODELS[provider]),
  }
}

/** Short display names for the workbench subscription rows. */
const SUBSCRIPTION_DISPLAY_LABELS: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'ChatGPT 订阅',
  'grok-sub': 'Grok 订阅',
  'google-sub': 'Google 订阅',
}

/** Execute one validated browser workbench request using the existing provider adapters. */
export async function generateFromStudio(
  ctx: Context,
  config: Config,
  input: StudioGenerateRequest,
  signal: AbortSignal,
  fallbackWorkspaceRoot?: string | undefined,
  subscriptions?: SubscriptionManager | undefined,
): Promise<StudioGenerateResponse> {
  // Subscription channels take a dedicated path: fixed model, channel-default
  // parameters, and a per-request sign-in check. Edit mode reads the
  // references through the same studio reader as the API-key channels.
  if (isSubscriptionProvider(input.provider)) {
    if (subscriptions === undefined) throw new Error('订阅生图不可用：订阅管理器未初始化')
    const subProfile = subscriptionStudioProfile(input.provider, true)
    assertAllowed(subProfile, input)
    return generateSubscriptionFromStudio(ctx, subscriptions, input, signal)
  }
  const channel = input.provider === 'openai-compat' ? resolveOpenAICompatChannel(config, input.channel) : undefined
  const requestConfig = input.provider === 'openai-compat' ? withOpenAICompatChannel(config, input.channel) : config
  const profile = studioProfile(requestConfig, input.provider, true, channel?.id)
  assertAllowed(profile, input)
  const active = resolveProvider(withProviderOverrides(requestConfig, input.provider, input.model))
  if (active.provider === 'comfyui') throw new Error('ComfyUI 暂未接入工作台')
  if (isSubscriptionProvider(active.provider)) throw new Error('订阅生图应通过订阅渠道执行')
  // ComfyUI is rejected above; subscription channels were routed earlier; narrow for the closures below.
  const wired = active
  const credential = await requireApiKey(ctx, input.provider, undefined, channel?.keyRef)

  const rawRefs = input.references ?? (input.reference ? [input.reference] : [])
  if (input.mode === 'edit' && rawRefs.length === 0) {
    throw new Error('图生图需要至少一张参考图')
  }
  const sourceImages = input.mode === 'edit'
    ? await Promise.all(rawRefs.map(ref => readStudioReference(ctx, ref, signal)))
    : []
  const startedAt = Date.now()
  const count = input.count ?? 1

  const generateSingle = async (index: number): Promise<StudioGeneratedItem> => {
    let generated: { data: Uint8Array; mediaType: ImageMediaType }
    let output: string

    if (wired.provider === 'google') {
      const aspectRatio = input.ratio as AspectRatio
      const imageSize = input.quality as ImageSize
      generated = input.mode === 'edit'
        ? await editGoogleImage({ apiKey: credential, endpoint: wired.endpoint, native: wired.native, model: wired.model, prompt: input.prompt, sourceImages, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
        : await generateGoogleImage({ apiKey: credential, endpoint: wired.endpoint, native: wired.native, model: wired.model, prompt: input.prompt, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      output = `${aspectRatio}, ${imageSize}`
    } else if (wired.provider === 'openai' || wired.provider === 'openai-compat' || wired.provider === 'xai' || wired.provider === 'zhipu') {
      // openai-compat keeps its configured relay table; the others resolve via
      // the capability table. xAI speaks aspect_ratio+resolution, not size.
      const p = wired.provider
      const officialTable = p === 'openai' ? officialSizeTable(requestConfig, wired.model) : undefined
      const officialResolution = input.resolution ?? (officialTable
        ? openAICompatTable({ openaiCompatSizes: officialTable }).find(group => group.ratio === input.ratio)?.tiers[0]?.tier
        : undefined) ?? '1K'
      const size = p === 'openai-compat' ? openAIRequestSize(requestConfig, input.ratio, input.resolution ?? input.quality)
        : p === 'openai' ? openAIRequestSize({ openaiCompatSizes: officialTable! }, input.ratio, officialResolution)
        : p === 'xai' ? undefined
        : CLOUD_CAPABILITIES[p].sizeFor?.(input.ratio, input.quality)
      if (p === 'openai' && size !== undefined) validateOfficialSize(wired.model, size)
      const requestedQuality = input.generationQuality ?? input.quality
      const quality = p === 'openai' ? (requestedQuality === 'auto' ? undefined : requestedQuality)
        : p === 'openai-compat' ? compatRequestQuality(requestConfig, input.generationQuality)
        : p === 'zhipu' ? 'hd'
        : undefined
      const extraBody = p === 'xai' ? { aspect_ratio: input.ratio, resolution: input.quality }
        : p === 'openai-compat' ? input.mode === 'generate'
          ? compatGenerationExtraBody(requestConfig, input.watermark) : compatEditExtraBody(requestConfig, input.watermark)
        : undefined
      generated = input.mode === 'edit'
        ? await editOpenAICompatibleImage({ apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, sourceImages, ...(size === undefined ? {} : { size }), maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, ...(quality === undefined ? {} : { quality }), ...(extraBody === undefined ? {} : { extraBody }), ...(p === 'openai-compat' ? { editFormat: wired.editFormat, editExtra: wired.editExtra, editSizeMode: requestConfig.openaiCompatEditSizeMode ?? 'auto' } : p === 'xai' ? { editFormat: 'xaiJson' as const } : {}) })
        : await generateOpenAICompatibleImage({ provider: p, apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, ...(size === undefined ? {} : { size }), maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, ...(quality === undefined ? {} : { quality }), ...(extraBody === undefined ? {} : { extraBody }) })
      output = size ?? `${input.ratio}, ${input.quality}`
    } else if (wired.provider === 'seedream') {
      const size = CLOUD_CAPABILITIES.seedream.sizeFor?.(input.ratio, input.quality) ?? input.quality
      const arkOptions = { ...wired.arkOptions, watermark: selectedWatermark(input.watermark, wired.arkOptions.watermark)! }
      generated = input.mode === 'edit'
        ? await editSeedreamImage({ apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, arkOptions })
        : await generateOpenAICompatibleImage({ provider: 'seedream', apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, arkOptions })
      output = size
    } else if (wired.provider === 'dashscope') {
      if (input.mode === 'edit' && sourceImages.length > 3) {
        throw new Error('DashScope (通义万相) 图生图目前最多支持 3 张参考图，请精简后重试')
      }
      const size = CLOUD_CAPABILITIES.dashscope.sizeFor?.(input.ratio, input.quality) ?? '1024x1024'
      const watermark = selectedWatermark(input.watermark)
      generated = input.mode === 'edit'
        ? await editDashScopeImage({ apiKey: credential, endpoint: wired.endpoint, model: wired.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, ...(watermark === undefined ? {} : { watermark }) })
        : await generateDashScopeImage({ apiKey: credential, endpoint: wired.endpoint, model: wired.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, ...(watermark === undefined ? {} : { watermark }) })
      output = size
    } else {
      throw new Error('当前渠道未接入 API 工作台')
    }

    if (!ctx.attachments.imageLimits.mediaTypes.includes(generated.mediaType)) {
      throw new Error(`当前 DSH 不支持保存 ${generated.mediaType} 图片`)
    }
    const attachment = await ctx.attachments.saveImage({
      data: generated.data,
      mediaType: generated.mediaType,
      name: count > 1 ? `studio-image-${index + 1}` : 'studio-image',
    })
    // Studio generation is temporary on canvas; workspace file persistence occurs when user collects to gallery.
    return {
      attachment,
      output,
    }
  }

  if (count === 1) {
    const single = await generateSingle(0)
    return {
      attachment: single.attachment,
      output: single.output,
      provider: input.provider,
      ...(channel === undefined ? {} : { channel: channel.id }),
      model: input.model,
      prompt: input.prompt,
      createdAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      requestedCount: 1,
      failedCount: 0,
      items: [single],
      ...(single.savedTo ? { savedTo: single.savedTo } : {}),
    }
  }

  const tasks = Array.from({ length: count }, (_, i) => () => generateSingle(i))
  const poolResults = await runPool(tasks, 2)
  const successes: StudioGeneratedItem[] = []
  const errors: Array<{ index: number; message: string }> = []

  for (let i = 0; i < poolResults.length; i++) {
    const r = poolResults[i]!
    if (r.status === 'fulfilled') {
      successes.push(r.value)
    } else {
      errors.push({
        index: i,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      })
    }
  }

  if (successes.length === 0) {
    const firstReason = poolResults[0] && poolResults[0].status === 'rejected' ? poolResults[0].reason : new Error('批量生图全部失败')
    throw firstReason instanceof Error ? firstReason : new Error(String(firstReason))
  }

  const first = successes[0]!
  return {
    attachment: first.attachment,
    output: first.output,
    provider: input.provider,
    ...(channel === undefined ? {} : { channel: channel.id }),
    model: input.model,
    prompt: input.prompt,
    createdAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    requestedCount: count,
    failedCount: errors.length,
    items: successes,
    ...(errors.length > 0 ? { errors } : {}),
    ...(first.savedTo ? { savedTo: first.savedTo } : {}),
  }
}

export async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency = 2,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex++
      const task = tasks[currentIndex]!
      try {
        const val = await task()
        results[currentIndex] = { status: 'fulfilled', value: val }
      } catch (err) {
        results[currentIndex] = { status: 'rejected', reason: err }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

/**
 * Subscription workbench generation: one prompt, channel-default parameters,
 * through the shared generateSubscriptionImage wrapper (timeout, b64 decode,
 * size check) so the downstream attachment flow is identical to API keys.
 */
async function generateSubscriptionFromStudio(
  ctx: Context,
  subscriptions: SubscriptionManager,
  input: StudioGenerateRequest,
  signal: AbortSignal,
): Promise<StudioGenerateResponse> {
  // Narrow once for the closure: the entry branch already guaranteed this.
  const provider = input.provider as SubscriptionProvider
  const rawRefs = input.references ?? (input.reference ? [input.reference] : [])
  if (input.mode === 'edit' && rawRefs.length === 0) {
    throw new Error('图生图需要至少一张参考图')
  }
  // Same reader as the API-key channels: attachment reads or base64 blobs,
  // size-checked and validated, so invalid references fail loudly instead of
  // silently falling back to text-to-image.
  const sourceImages = input.mode === 'edit'
    ? await Promise.all(rawRefs.map(ref => readStudioReference(ctx, ref, signal)))
    : []
  const startedAt = Date.now()
  const count = input.count ?? 1
  // Resolve the channel's wire parameters from the capability table: codex
  // takes pixel sizes, grok/antigravity take the ratio string itself (their
  // manager layers map it onto aspect_ratio / imageConfig). `auto` quality is
  // never forwarded so the vendor default applies.
  const subCap = SUBSCRIPTION_CAPABILITIES[provider]
  const wireSize = provider === 'chatgpt-sub' ? subCap.sizeFor?.(input.ratio, input.quality) : input.ratio
  const wireQuality = input.quality === 'auto' || input.quality === 'standard' ? undefined : input.quality
  const requestedOutput = input.ratio === 'auto' && wireQuality === undefined
    ? '通道默认'
    : `${input.ratio}, ${input.quality}`
  const generateSingle = async (index: number): Promise<StudioGeneratedItem> => {
    const generated = await generateSubscriptionImage({
      manager: subscriptions,
      provider,
      prompt: input.prompt,
      ...(wireSize === undefined || wireSize.length === 0 ? {} : { size: wireSize }),
      ...(wireQuality === undefined ? {} : { quality: wireQuality }),
      ...(sourceImages.length > 0 ? { sourceImages } : {}),
      maxBytes: ctx.attachments.imageLimits.maxImageBytes,
      signal,
    })
    if (!ctx.attachments.imageLimits.mediaTypes.includes(generated.mediaType)) {
      throw new Error(`当前 DSH 不支持保存 ${generated.mediaType} 图片`)
    }
    const attachment = await ctx.attachments.saveImage({
      data: generated.data,
      mediaType: generated.mediaType,
      name: count > 1 ? `studio-image-${index + 1}` : 'studio-image',
    })
    return {
      attachment,
      output: subscriptionOutput(input.ratio, input.quality, requestedOutput, attachment.width, attachment.height, generated.reportedQuality),
    }
  }
  if (count === 1) {
    const single = await generateSingle(0)
    return subscriptionResponse(input, startedAt, 1, 0, [single], single)
  }
  const poolResults = await runPool(Array.from({ length: count }, (_, i) => () => generateSingle(i)), 2)
  const successes: StudioGeneratedItem[] = []
  const errors: Array<{ index: number; message: string }> = []
  for (let i = 0; i < poolResults.length; i++) {
    const r = poolResults[i]!
    if (r.status === 'fulfilled') successes.push(r.value)
    else errors.push({ index: i, message: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  }
  if (successes.length === 0) {
    const firstReason = poolResults[0] && poolResults[0].status === 'rejected' ? poolResults[0].reason : new Error('订阅生图全部失败')
    throw firstReason instanceof Error ? firstReason : new Error(String(firstReason))
  }
  const first = successes[0]!
  return subscriptionResponse(input, startedAt, count, errors.length, successes, first, errors)
}

/** Describe what the subscription returned without presenting requested settings as actual output. */
function subscriptionOutput(ratio: string, quality: string, fallback: string, width: number | undefined, height: number | undefined, reportedQuality?: string): string {
  const qualityReport = reportedQuality === undefined ? '' : ` · 服务端回报清晰度 ${reportedQuality}`
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return `${fallback}${qualityReport}`
  const actual = `实际 ${String(width)}×${String(height)}`
  if (ratio === 'auto') return `请求 ${ratio}, ${quality}${qualityReport} · ${actual}`
  const parts = ratio.split(':').map(Number)
  const requested = (parts.length === 2 && parts[0]! > 0 && parts[1]! > 0) ? parts[0]! / parts[1]! : undefined
  const mismatch = requested !== undefined && Math.abs((width / height) / requested - 1) > 0.12
  return `请求 ${ratio}, ${quality}${qualityReport} · ${actual}${mismatch ? '（比例未生效）' : ''}`
}

/** Assemble the subscription workbench response with exactOptionalPropertyTypes-safe spreads. */
function subscriptionResponse(
  input: StudioGenerateRequest,
  startedAt: number,
  requestedCount: number,
  failedCount: number,
  items: StudioGeneratedItem[],
  primary: StudioGeneratedItem,
  errors?: Array<{ index: number; message: string }>,
): StudioGenerateResponse {
  return {
    attachment: primary.attachment,
    output: primary.output,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    createdAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    requestedCount,
    failedCount,
    items,
    ...(primary.savedTo ? { savedTo: primary.savedTo } : {}),
    ...(errors !== undefined && errors.length > 0 ? { errors } : {}),
  }
}

export function studioProfile(config: Config, provider: CloudImageProvider, configured: boolean, channelId?: string): StudioProviderProfile {
  const channel = provider === 'openai-compat' && channelId !== undefined ? resolveOpenAICompatChannel(config, channelId) : undefined
  const scoped = channel === undefined ? config : withOpenAICompatChannel(config, channel.id)
  const result = cloudStudioProfile(scoped, provider, configured)
  const editModel = provider === 'openai-compat' ? scoped.openaiCompatEditModel?.trim() : undefined
  return {
    ...result,
    ...(channel === undefined ? {} : { channel: channel.id, label: channel.label }),
    ...(editModel ? { editModel } : {}),
    ...watermarkProfile(scoped, provider, result.model),
  }
}

function cloudStudioProfile(config: Config, provider: CloudImageProvider, configured: boolean): StudioProviderProfile {
  let active: ReturnType<typeof resolveProvider>
  try {
    active = resolveProvider(withProviderOverrides(config, provider))
  } catch (cause) {
    // Unconfigured openai-compat row: expose an empty model until the relay
    // settings are filled in, while retaining the same output controls.
    if (provider !== 'openai-compat') throw cause
    return compatibleStudioProfile(config, '', false)
  }
  if (active.provider === 'comfyui') throw new Error('Invalid cloud provider profile')
  const model = active.model
  if (provider === 'google') {
    const cap = CLOUD_CAPABILITIES.google
    return profile(provider, model, configured, cap.ratioOptions, cap.qualityOptions, cap.defaultRatio, cap.defaultQuality)
  }
  if (provider === 'openai-compat') {
    return compatibleStudioProfile(config, model, configured)
  }
  if (provider === 'openai') {
    const table = officialSizeTable(config, model)
    const order = Object.keys(table)
    const groups = openAICompatTable({ openaiCompatSizes: table }).sort((a, b) => order.indexOf(a.ratio) - order.indexOf(b.ratio))
    const resolutionOptions = Object.fromEntries(groups.map(group => [group.ratio, group.tiers.map(entry => ({ value: entry.tier, label: `${entry.tier} · ${entry.size}` }))]))
    const defaultRatio = groups.some(group => group.ratio === '1:1') ? '1:1' : groups[0]?.ratio ?? '1:1'
    return { ...profile(provider, model, configured, groups.map(group => option(group.ratio)), officialQualityOptions(model), defaultRatio, 'auto'),
      resolutionOptions, defaultResolution: resolutionOptions[defaultRatio]?.[0]?.value ?? '1K' }
  }
  // Every remaining cloud row reads its picker shape from the capability table.
  const cap = CLOUD_CAPABILITIES[provider as Exclude<CloudImageProvider, 'openai-compat'>]
  return profile(provider, model, configured, cap.ratioOptions, cap.qualityOptions, cap.defaultRatio, cap.defaultQuality)
}

/** Output capabilities remain visible before credentials, address or model are configured. */
function compatibleStudioProfile(config: Config, model: string, configured: boolean): StudioProviderProfile {
  const groups = openAICompatTable(config)
  const modelOptions = resolveOpenAICompatModels({ ...config, openaiCompatModel: model }).map(value => ({ value, label: value }))
  const capabilityProfile = {
    modelOptions,
    generationQualityOptions: compatQualityOptions(config),
    defaultGenerationQuality: compatRequestQuality(config) ?? PROVIDER_DEFAULT_QUALITY,
    resolutionOptions: Object.fromEntries(groups.map(group => [group.ratio, group.tiers.map(entry => ({ value: entry.tier, label: `${entry.tier} · ${entry.size}` }))])),
  }
  // Empty table keeps the historical resolution value for persisted selections.
  if (config.openaiCompatSizes === undefined || Object.keys(config.openaiCompatSizes).length === 0) {
    return {
      ...profile('openai-compat', model, configured, ['1:1', '3:2', '2:3'].map(option), [{ value: 'standard', label: '标准（推荐）' }], '1:1', 'standard'),
      ...capabilityProfile,
      resolutionOptions: Object.fromEntries(groups.map(group => [group.ratio, [{ value: 'standard', label: `标准 · ${group.tiers[0]!.size}` }]])),
    }
  }
  return { ...openAICompatStudioProfile(config, model, configured), ...capabilityProfile }
}

function profile(
  provider: CloudImageProvider,
  model: string,
  configured: boolean,
  ratioOptions: StudioOption[],
  qualityOptions: StudioOption[],
  defaultRatio: string,
  defaultQuality: string,
): StudioProviderProfile {
  return {
    provider,
    label: CLOUD_DISPLAY_LABELS[provider],
    model,
    configured,
    supportsEditing: true,
    ratioOptions,
    qualityOptions,
    defaultRatio,
    defaultQuality,
  }
}

/** Display names for the BYOK cloud rows, mirroring the settings card. */
const CLOUD_DISPLAY_LABELS: Record<CloudImageProvider, string> = {
  google: 'Google Gemini',
  openai: 'OpenAI',
  'openai-compat': 'OpenAI 兼容',
  seedream: 'Seedream',
  dashscope: 'DashScope',
  xai: 'xAI Grok',
  zhipu: '智谱 GLM',
}

function option(value: string): StudioOption {
  return { value, label: RATIO_LABELS[value] ?? value }
}

function assertAllowed(profile: StudioProviderProfile, input: StudioGenerateRequest): void {
  if (!studioModelOptionsForMode(profile, input.mode).some(option => option.value === input.model)) throw new Error('模型配置已变化，请刷新工作台后重试')
  if (!profile.ratioOptions.some(option => option.value === input.ratio)) throw new Error('该 Provider 不支持所选比例')
  const selectedQuality = input.provider === 'openai' ? input.generationQuality ?? input.quality : input.resolution ?? input.quality
  if (!profile.qualityOptions.some(option => option.value === selectedQuality)) throw new Error('该 Provider 不支持所选清晰度')
  if (input.resolution !== undefined && profile.resolutionOptions !== undefined && !profile.resolutionOptions[input.ratio]?.some(option => option.value === input.resolution)) throw new Error('该比例不支持所选分辨率')
  if (input.generationQuality !== undefined && input.provider === 'openai-compat' && !profile.generationQualityOptions?.some(option => option.value === input.generationQuality)) throw new Error('该 Provider 不支持所选生成质量')
  if ((input.resolution !== undefined || input.generationQuality !== undefined) && input.provider !== 'openai' && input.provider !== 'openai-compat') throw new Error('该 Provider 不支持独立的 OpenAI 输出参数')
  if (input.watermark !== undefined && input.watermark !== 'default'
    && studioWatermarkCapability(profile, input.mode).status !== 'supported') throw new Error('该渠道尚未确认当前操作的水印控制，请刷新工作台')
  if (input.mode === 'edit' && !profile.supportsEditing) throw new Error('该 Provider 暂不支持图生图')
}

async function readStudioReference(
  ctx: Context,
  reference: StudioReference | undefined,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; mediaType: ImageMediaType }> {
  if (reference === undefined) throw new Error('图生图需要至少一张参考图')
  if ('attachment' in reference) {
    const stored: StoredImageAttachment = await ctx.attachments.readImage(reference.attachment, signal)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
  const data = decodeCanonicalBase64(reference.data)
  if (data.byteLength > ctx.attachments.imageLimits.maxImageBytes) throw new Error('参考图超过当前 DSH 的大小限制')
  await ctx.attachments.validateImage({ data, mediaType: reference.mediaType, ...(reference.name === undefined ? {} : { name: reference.name }) })
  return { data, mediaType: reference.mediaType }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('参考图编码无效')
  const data = Buffer.from(value, 'base64')
  if (data.byteLength === 0 || data.toString('base64') !== value) throw new Error('参考图编码无效')
  return new Uint8Array(data)
}

function cloudProvider(value: string): value is CloudImageProvider {
  return (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(value)
}
