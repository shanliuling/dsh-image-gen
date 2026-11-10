/** Independent size and quality controls for official and compatible image APIs. */
import type { Config } from './config.js'
import { GIF_FRAME_COUNT_MAX, GIF_FRAME_COUNT_MIN, GIF_FRAME_DURATION_MS_MAX, GIF_FRAME_DURATION_MS_MIN, GIF_SHEET_MAX_EDGE, type StudioOption } from './shared.js'
export { compatGenerationExtraBody, compatWatermarkField, compatWatermarkOptions } from './watermark.js'

export const PROVIDER_DEFAULT_QUALITY = '__default__'
export const DEFAULT_COMPAT_QUALITIES = ['auto', 'low', 'medium', 'high']
const LEGACY_SIZES = ['1024x1024', '1536x1024', '1024x1536']
const OPENAI_SIZES: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048' },
  '3:2': { '1K': '1536x1024', '2K': '2304x1536' },
  '2:3': { '1K': '1024x1536', '2K': '1536x2304' },
  '4:3': { '1K': '1152x864', '2K': '2048x1536' },
  '3:4': { '1K': '864x1152', '2K': '1536x2048' },
  '16:9': { '1K': '1536x864', '2K': '2048x1152', '4K': '3840x2160' },
  '9:16': { '1K': '864x1536', '2K': '1152x2048', '4K': '2160x3840' },
}

function flexibleSizeModel(model: string): boolean {
  return /^gpt-image-2(?:$|[-.])/.test(model)
}

export function officialSizeTable(config: Config, model: string): Record<string, Record<string, string>> {
  if (config.openaiSizes && Object.keys(config.openaiSizes).length > 0) return config.openaiSizes
  if (flexibleSizeModel(model)) return OPENAI_SIZES
  return { '1:1': { '1K': LEGACY_SIZES[0]! }, '3:2': { '1K': LEGACY_SIZES[1]! }, '2:3': { '1K': LEGACY_SIZES[2]! } }
}

/** Check the official model contract before spending a request. Relays own their size contract. */
export function validateOfficialSize(model: string, size: string): void {
  if (size === 'auto') return
  if (!flexibleSizeModel(model)) {
    if (!LEGACY_SIZES.includes(size)) throw new Error(`模型 ${model} 不支持尺寸 ${size}；请使用 1024x1024、1536x1024 或 1024x1536`)
    return
  }
  const match = /^(\d+)x(\d+)$/.exec(size)
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  const pixels = width * height
  if (!match || width % 16 !== 0 || height % 16 !== 0 || Math.max(width, height) > 3840
    || pixels < 655_360 || pixels > 8_294_400 || Math.max(width, height) > 3 * Math.min(width, height)) {
    throw new Error(`OpenAI 尺寸 ${size} 无效：边长须为 16 的倍数且不超过 3840，比例在 1:3 到 3:1，像素数在 655360 到 8294400`)
  }
}

interface GifRequestOptions {
  outputFormat?: string | undefined
  frameCount?: number | undefined
  frameDurationMs?: number | undefined
}

/** A type alias (not an interface) so it satisfies the adapter's Record<string, unknown> extraBody. */
type GifRequestFields = {
  output_format?: 'gif'
  frame_count?: number
  frame_duration_ms?: number
}

/** Fold one call's GIF parameters into OpenAI images request fields; anything but a GIF yields {}. */
export function gifRequestFields(options: GifRequestOptions): GifRequestFields {
  if (options.outputFormat !== 'gif') {
    if (options.frameCount !== undefined || options.frameDurationMs !== undefined) throw new Error('frame_count / frame_duration_ms 仅在 output_format=gif 时有效')
    return {}
  }
  if (options.frameCount !== undefined && !inRange(options.frameCount, GIF_FRAME_COUNT_MIN, GIF_FRAME_COUNT_MAX)) {
    throw new Error(`GIF frame_count 须为 ${String(GIF_FRAME_COUNT_MIN)} 到 ${String(GIF_FRAME_COUNT_MAX)} 的整数`)
  }
  if (options.frameDurationMs !== undefined && !inRange(options.frameDurationMs, GIF_FRAME_DURATION_MS_MIN, GIF_FRAME_DURATION_MS_MAX)) {
    throw new Error(`GIF frame_duration_ms 须为 ${String(GIF_FRAME_DURATION_MS_MIN)} 到 ${String(GIF_FRAME_DURATION_MS_MAX)} 的整数`)
  }
  return {
    output_format: 'gif',
    ...(options.frameCount === undefined ? {} : { frame_count: options.frameCount }),
    ...(options.frameDurationMs === undefined ? {} : { frame_duration_ms: options.frameDurationMs }),
  }
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/**
 * A GIF `size` is the single-frame size: auto or multiples of 16 with the
 * longest edge within the sheet limit. The still-image pixel floor of
 * validateOfficialSize does not apply; the provider judges the frame budget.
 */
export function validateGifFrameSize(size: string): void {
  if (size === 'auto') return
  const match = /^(\d+)x(\d+)$/.exec(size)
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  if (!match || width <= 0 || height <= 0 || width % 16 !== 0 || height % 16 !== 0 || Math.max(width, height) > GIF_SHEET_MAX_EDGE) {
    throw new Error(`GIF 单帧尺寸 ${size} 无效：边长须为 16 的倍数且不超过 ${String(GIF_SHEET_MAX_EDGE)}；所有帧会拼成一张 sheet，其最长边同样不得超过 ${String(GIF_SHEET_MAX_EDGE)}，帧越多单帧应越小`)
  }
}

export function officialQualityOptions(model: string): StudioOption[] {
  const values = ['auto', 'low', 'medium', 'high', ...(/^gpt-image-2\.5-(sunburst|flare)(?:$|-)/.test(model) ? ['xhigh', 'max'] : [])]
  return values.map(value => ({ value, label: value === 'auto' ? '自动' : value }))
}

export function compatQualityOptions(config: Config): StudioOption[] {
  const values = [...new Set([...(config.openaiCompatQualityOptions ?? DEFAULT_COMPAT_QUALITIES), config.openaiCompatQuality ?? '']
    .map(value => value.trim()).filter(value => value && value !== PROVIDER_DEFAULT_QUALITY))]
  return [{ value: PROVIDER_DEFAULT_QUALITY, label: '渠道默认（不发送）' }, ...values.map(value => ({ value, label: value }))]
}

export function compatRequestQuality(config: Config, selected?: string): string | undefined {
  const value = (selected ?? config.openaiCompatQuality)?.trim()
  return value && value !== PROVIDER_DEFAULT_QUALITY ? value : undefined
}
