import {
  CLOUD_IMAGE_PROVIDERS,
  type CloudImageProvider,
  type StudioGenerateRequest,
  type StudioWatermark,
} from '../shared.js'
import { officialSizeTable } from '../openai-output.js'

export interface RegeneratableImage {
  provider: string
  channel?: string | undefined
  model: string
  output?: string | undefined
}

/** Build the workbench request that reproduces a conversation image with an edited prompt. */
export function conversationRegenerateRequest(
  image: RegeneratableImage,
  prompt: string,
  remembered?: { ratio: string; quality: string; resolution?: string | undefined; generationQuality?: string | undefined; watermark?: StudioWatermark | undefined } | undefined,
): StudioGenerateRequest {
  if (!(CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(image.provider)) {
    throw new Error('当前图片使用的 Provider 暂不支持重新生成')
  }
  const provider = image.provider as CloudImageProvider
  const settings = remembered ?? outputSettings(provider, image.output, image.model)
  return {
    mode: 'generate',
    provider,
    ...(provider === 'openai-compat' && image.channel !== undefined ? { channel: image.channel } : {}),
    model: image.model,
    prompt: prompt.trim(),
    ratio: settings.ratio,
    quality: settings.quality,
    ...(settings.resolution === undefined ? {} : { resolution: settings.resolution }),
    ...(settings.generationQuality === undefined ? {} : { generationQuality: settings.generationQuality }),
    ...(settings.watermark === undefined ? {} : { watermark: settings.watermark }),
  }
}

function outputSettings(provider: CloudImageProvider, output?: string | undefined, model = ''): { ratio: string; quality: string; resolution?: string; generationQuality?: string; watermark?: StudioWatermark } {
  const normalized = (output ?? '').trim()
  if (provider === 'google') {
    const [rawRatio, rawQuality] = normalized.split(',').map(value => value.trim())
    return {
      ratio: isRatio(rawRatio) ? rawRatio : '1:1',
      quality: rawQuality === '1K' || rawQuality === '2K' || rawQuality === '4K' ? rawQuality : '1K',
    }
  }
  if (provider === 'seedream') {
    return { ratio: 'auto', quality: normalized === '1K' || normalized === '4K' ? normalized : '2K' }
  }
  if (provider === 'openai' || provider === 'openai-compat' || provider === 'xai' || provider === 'zhipu') {
    const [size, qualityPart] = normalized.split(',').map(value => value.trim())
    const requestedQuality = qualityPart?.startsWith('quality=') ? qualityPart.slice(8) : undefined
    const resolution = provider === 'openai' ? Object.values(officialSizeTable({}, model)).flatMap(tiers => Object.entries(tiers)).find(([, pixels]) => pixels === size)?.[0] : undefined
    return { ratio: ratioFromSize(size ?? '', 'x'), quality: provider === 'openai' ? requestedQuality ?? 'auto' : 'standard',
      ...(resolution === undefined ? {} : { resolution }),
      ...(provider === 'openai-compat' && requestedQuality ? { generationQuality: requestedQuality } : {}) }
  }
  return { ratio: ratioFromSize(normalized, '*'), quality: 'standard' }
}

function ratioFromSize(size: string, separator: 'x' | '*'): string {
  const dimensions = size.split(separator).map(Number)
  if (dimensions.length === 2 && dimensions.every(value => Number.isFinite(value) && value > 0)) {
    const target = dimensions[0]! / dimensions[1]!
    for (const ratio of ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']) {
      const [width, height] = ratio.split(':').map(Number)
      if (Math.abs(target - width! / height!) < 0.015) return ratio
    }
  }
  const sizes: Record<string, string> = separator === 'x'
    ? { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' }
    : { '1024*1024': '1:1', '1536*1024': '3:2', '1024*1536': '2:3', '1664*928': '16:9', '928*1664': '9:16' }
  return sizes[size] ?? '1:1'
}

function isRatio(value: string | undefined): value is string {
  return value === '1:1' || value === '3:2' || value === '2:3' || value === '4:3' || value === '3:4' || value === '16:9' || value === '9:16'
}
