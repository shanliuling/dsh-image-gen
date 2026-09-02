/** Provider-aware orchestration for the browser image workbench. */
import type { ImageAttachmentRef, ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import {
  ASPECT_RATIOS,
  DASHSCOPE_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  IMAGE_SIZES,
  OPENAI_API_KEY_ENV,
  SEEDREAM_API_KEY_ENV,
  resolveProvider,
  type AspectRatio,
  type Config,
  type ImageSize,
} from './config.js'
import { editDashScopeImage, generateDashScopeImage } from './dashscope.js'
import { editGoogleImage, generateGoogleImage } from './google.js'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from './openai-compatible.js'
import { editSeedreamImage } from './seedream.js'
import {
  CLOUD_IMAGE_PROVIDERS,
  type CloudImageProvider,
  type StudioConfigResponse,
  type StudioGenerateRequest,
  type StudioGenerateResponse,
  type StudioOption,
  type StudioProviderProfile,
  type StudioReference,
} from './shared.js'

const PROVIDER_LABELS: Record<CloudImageProvider, string> = {
  google: 'Google',
  openai: 'OpenAI',
  seedream: 'Seedream',
  dashscope: 'DashScope',
}

const CREDENTIALS: Record<CloudImageProvider, string> = {
  google: GOOGLE_API_KEY_ENV,
  openai: OPENAI_API_KEY_ENV,
  seedream: SEEDREAM_API_KEY_ENV,
  dashscope: DASHSCOPE_API_KEY_ENV,
}

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
export async function describeStudio(ctx: Context, config: Config): Promise<StudioConfigResponse> {
  const configuredEntries = await Promise.all(CLOUD_IMAGE_PROVIDERS.map(async provider => {
    const credential = await ctx.credentials.resolve(credentialRef(CREDENTIALS[provider]))
    return [provider, credential !== undefined && credential.value.trim().length > 0] as const
  }))
  const configured = Object.fromEntries(configuredEntries) as Record<CloudImageProvider, boolean>
  const profiles = CLOUD_IMAGE_PROVIDERS.map(provider => studioProfile(config, provider, configured[provider]))
  const preferred = config.provider
  const activeProvider = preferred !== undefined && cloudProvider(preferred)
    ? preferred
    : profiles.find(profile => profile.configured)?.provider ?? 'google'
  return { providers: profiles, activeProvider }
}

/** Execute one validated browser workbench request using the existing provider adapters. */
export async function generateFromStudio(
  ctx: Context,
  config: Config,
  input: StudioGenerateRequest,
  signal: AbortSignal,
): Promise<StudioGenerateResponse> {
  const profile = studioProfile(config, input.provider, true)
  assertAllowed(profile, input)
  const active = resolveProvider(providerConfig(config, input.provider, input.model))
  if (active.provider === 'comfyui') throw new Error('ComfyUI 暂未接入工作台')
  const credential = await ctx.credentials.resolve(credentialRef(active.apiKeyEnv))
  if (credential === undefined || credential.value.trim().length === 0) {
    throw new Error(`${PROVIDER_LABELS[input.provider]} 尚未配置 API Key，请先到设置中配置`)
  }

  const rawRefs = input.references ?? (input.reference ? [input.reference] : [])
  if (input.mode === 'edit' && rawRefs.length === 0) {
    throw new Error('图生图需要至少一张参考图')
  }
  const sourceImages = input.mode === 'edit'
    ? await Promise.all(rawRefs.map(ref => readStudioReference(ctx, ref, signal)))
    : []
  const startedAt = Date.now()
  let generated: { data: Uint8Array; mediaType: ImageMediaType }
  let output: string

  if (active.provider === 'google') {
    const aspectRatio = input.ratio as AspectRatio
    const imageSize = input.quality as ImageSize
    generated = input.mode === 'edit'
      ? await editGoogleImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: input.prompt, sourceImages, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      : await generateGoogleImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: input.prompt, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
    output = `${aspectRatio}, ${imageSize}`
  } else if (active.provider === 'openai') {
    const size = openAISize(input.ratio)
    generated = input.mode === 'edit'
      ? await editOpenAICompatibleImage({ apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      : await generateOpenAICompatibleImage({ provider: 'openai', apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
    output = size
  } else if (active.provider === 'seedream') {
    const size = input.quality
    generated = input.mode === 'edit'
      ? await editSeedreamImage({ apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      : await generateOpenAICompatibleImage({ provider: 'seedream', apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
    output = size
  } else {
    if (input.mode === 'edit' && sourceImages.length > 3) {
      throw new Error('DashScope (通义万相) 图生图目前最多支持 3 张参考图，请精简后重试')
    }
    const size = dashScopeSize(input.ratio)
    generated = input.mode === 'edit'
      ? await editDashScopeImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: input.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
      : await generateDashScopeImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: input.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal })
    output = size
  }

  if (!ctx.attachments.imageLimits.mediaTypes.includes(generated.mediaType)) {
    throw new Error(`当前 DSH 不支持保存 ${generated.mediaType} 图片`)
  }
  const attachment = await ctx.attachments.saveImage({ data: generated.data, mediaType: generated.mediaType, name: 'studio-image' })
  return {
    attachment,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    output,
    createdAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
  }
}

export function studioProfile(config: Config, provider: CloudImageProvider, configured: boolean): StudioProviderProfile {
  const active = resolveProvider(providerConfig(config, provider))
  if (active.provider === 'comfyui') throw new Error('Invalid cloud provider profile')
  const model = active.model
  if (provider === 'google') {
    return profile(provider, model, configured, ASPECT_RATIOS.map(option), IMAGE_SIZES.map(value => ({ value, label: value })), '1:1', '1K')
  }
  if (provider === 'openai') {
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
    label: PROVIDER_LABELS[provider],
    model,
    configured,
    supportsEditing: true,
    ratioOptions,
    qualityOptions,
    defaultRatio,
    defaultQuality,
  }
}

function option(value: string): StudioOption {
  return { value, label: RATIO_LABELS[value] ?? value }
}

function providerConfig(config: Config, provider: CloudImageProvider, model?: string): Config {
  if (model === undefined) return { ...config, provider }
  switch (provider) {
    case 'google': return { ...config, provider, googleModel: model }
    case 'openai': return { ...config, provider, openaiModel: model }
    case 'seedream': return { ...config, provider, seedreamModel: model }
    case 'dashscope': return { ...config, provider, dashscopeModel: model }
  }
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
