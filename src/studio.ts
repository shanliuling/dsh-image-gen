/** Provider-aware orchestration for the browser image workbench. */
import type { ImageAttachmentRef, ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import {
  ASPECT_RATIOS,
  IMAGE_SIZES,
  resolveProvider,
  withProviderOverrides,
  type ArkOutputOptions,
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

const RATIO_LABELS: Record<string, string> = {
  auto: '自动',
  '1:1': '1:1 方形',
  '3:2': '3:2 横向',
  '2:3': '2:3 肖像',
  '4:3': '4:3 横向',
  '3:4': '3:4 竖向',
  '16:9': '16:9 宽屏',
  '9:16': '9:16 竖屏',
}

/** Return only browser-safe capability data. */
export async function describeStudio(
  ctx: Context,
  config: Config,
  subscriptions?: SubscriptionManager | undefined,
): Promise<StudioConfigResponse> {
  const configuredEntries = await Promise.all(CLOUD_IMAGE_PROVIDERS.map(async provider => {
    return [provider, await resolveApiKey(ctx, provider) !== undefined] as const
  }))
  const configured = Object.fromEntries(configuredEntries) as Record<CloudImageProvider, boolean>
  const cloudProfiles = CLOUD_IMAGE_PROVIDERS.map(provider => studioProfile(config, provider, configured[provider]))
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
  return { providers: profiles, activeProvider }
}

/** The persisted default provider is usable directly when the workbench can drive it. */
function isStudioPreferred(preferred: string | undefined): preferred is NonNullable<StudioConfigResponse['activeProvider']> {
  return preferred !== undefined && (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(preferred)
    || preferred !== undefined && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(preferred)
}

/** Fixed parameter shape for subscription channels: one "channel default" pair. */
function subscriptionStudioProfile(provider: SubscriptionProvider, signedIn: boolean): StudioProviderProfile {
  const channelDefault = { value: 'auto', label: '通道默认' }
  return {
    provider,
    label: SUBSCRIPTION_DISPLAY_LABELS[provider],
    model: DEFAULT_SUBSCRIPTION_MODELS[provider],
    configured: signedIn,
    supportsEditing: true,
    ratioOptions: [channelDefault],
    qualityOptions: [channelDefault],
    defaultRatio: 'auto',
    defaultQuality: 'auto',
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
  const profile = studioProfile(config, input.provider, true)
  assertAllowed(profile, input)
  const active = resolveProvider(withProviderOverrides(config, input.provider, input.model))
  if (active.provider === 'comfyui') throw new Error('ComfyUI 暂未接入工作台')
  // ComfyUI is rejected above; subscription channels were routed earlier; narrow for the closures below.
  const wired = active as
    | { provider: 'google'; apiKeyEnv: string; model: string; endpoint: string; aspectRatio: AspectRatio; imageSize: ImageSize }
    | { provider: 'openai'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string }
    | { provider: 'openai-compat'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string; editFormat: 'multipart' | 'jsonImageUrlArray'; editExtra: Record<string, unknown> }
    | { provider: 'seedream'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string; arkOptions: ArkOutputOptions }
    | { provider: 'dashscope'; apiKeyEnv: string; model: string; endpoint: string; imageSize: string }
    | { provider: 'xai'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string }
    | { provider: 'zhipu'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string }
  const credential = await requireApiKey(ctx, input.provider)

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
        ? await editGoogleImage({ apiKey: credential, endpoint: wired.endpoint, model: wired.model, prompt: input.prompt, sourceImages, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
        : await generateGoogleImage({ apiKey: credential, endpoint: wired.endpoint, model: wired.model, prompt: input.prompt, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      output = `${aspectRatio}, ${imageSize}`
    } else if (wired.provider === 'openai' || wired.provider === 'openai-compat' || wired.provider === 'xai' || wired.provider === 'zhipu') {
      const size = openAISize(input.ratio)
      generated = input.mode === 'edit'
        ? await editOpenAICompatibleImage({ apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, ...(wired.provider === 'openai-compat' ? { editFormat: wired.editFormat, editExtra: wired.editExtra } : {}) })
        : await generateOpenAICompatibleImage({ provider: wired.provider, apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      output = size
    } else if (wired.provider === 'seedream') {
      const size = input.quality
      generated = input.mode === 'edit'
        ? await editSeedreamImage({ apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, arkOptions: wired.arkOptions })
        : await generateOpenAICompatibleImage({ provider: 'seedream', apiKey: credential, baseURL: wired.baseURL, model: wired.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal, arkOptions: wired.arkOptions })
      output = size
    } else {
      if (input.mode === 'edit' && sourceImages.length > 3) {
        throw new Error('DashScope (通义万相) 图生图目前最多支持 3 张参考图，请精简后重试')
      }
      const size = dashScopeSize(input.ratio)
      generated = input.mode === 'edit'
        ? await editDashScopeImage({ apiKey: credential, endpoint: wired.endpoint, model: wired.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
        : await generateDashScopeImage({ apiKey: credential, endpoint: wired.endpoint, model: wired.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      output = size
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
  const generateSingle = async (index: number): Promise<StudioGeneratedItem> => {
    const generated = await generateSubscriptionImage({
      manager: subscriptions,
      provider,
      prompt: input.prompt,
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
      output: '通道默认',
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

export function studioProfile(config: Config, provider: CloudImageProvider, configured: boolean): StudioProviderProfile {
  let active: ReturnType<typeof resolveProvider>
  try {
    active = resolveProvider(withProviderOverrides(config, provider))
  } catch {
    // Unconfigured openai-compat row: expose an empty model until the relay
    // settings are filled in; generation still fails loudly with guidance.
    return profile(provider, '', configured, ['1:1', '3:2', '2:3'].map(option), [{ value: 'standard', label: '标准（推荐）' }], '1:1', 'standard')
  }
  if (active.provider === 'comfyui') throw new Error('Invalid cloud provider profile')
  const model = active.model
  if (provider === 'google') {
    return profile(provider, model, configured, ASPECT_RATIOS.map(option), IMAGE_SIZES.map(value => ({ value, label: value })), '1:1', '1K')
  }
  if (provider === 'openai' || provider === 'openai-compat' || provider === 'xai' || provider === 'zhipu') {
    return profile(provider, model, configured, ['1:1', '3:2', '2:3'].map(option), [{ value: 'standard', label: '标准（推荐）' }], '1:1', 'standard')
  }
  if (provider === 'seedream') {
    return profile(provider, model, configured, [{ value: 'auto', label: '模型自动' }], ['1K', '2K', '4K'].map(value => ({ value, label: value })), 'auto', '2K')
  }
  return profile(provider, model, configured, ['1:1', '3:2', '2:3', '16:9', '9:16'].map(option), [{ value: 'standard', label: '标准（推荐）' }], '1:1', 'standard')
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
  if (input.model !== profile.model) throw new Error('模型配置已变化，请刷新工作台后重试')
  if (!profile.ratioOptions.some(option => option.value === input.ratio)) throw new Error('该 Provider 不支持所选比例')
  if (!profile.qualityOptions.some(option => option.value === input.quality)) throw new Error('该 Provider 不支持所选清晰度')
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

function openAISize(ratio: string): string {
  if (ratio === '3:2') return '1536x1024'
  if (ratio === '2:3') return '1024x1536'
  return '1024x1024'
}

function dashScopeSize(ratio: string): string {
  const sizes: Record<string, string> = {
    '1:1': '1024*1024',
    '3:2': '1536*1024',
    '2:3': '1024*1536',
    '16:9': '1664*928',
    '9:16': '928*1664',
  }
  return sizes[ratio] ?? '1024*1024'
}

function cloudProvider(value: string): value is CloudImageProvider {
  return (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(value)
}
