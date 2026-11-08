/**
 * Subscription-based image generation: the internal, self-contained channel.
 *
 * Login (PKCE loopback), token storage through the DSH Credentials service,
 * refresh and the wire calls all live in `./subscription/` — adapted from
 * @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY), trimmed to
 * the image subscription vendors this bundle ships. This file keeps the same
 * `{ data, mediaType }` contract as the API-key adapters so `saveGenerated`
 * and everything downstream is shared.
 *
 * Isolation invariants (project rules):
 * - OAuth blobs live under CODEX_OAUTH_1 / GROK_OAUTH_1 refs — never the
 *   API-key refs — and the API-key paths never consult subscription state.
 * - Login/logout changes nothing except one vendor's own blob.
 */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { detectImageMediaType } from './reference-image.js'
import { SubscriptionManager, vendorOf } from './subscription/manager.js'
import { SUBSCRIPTION_TIMEOUT_MS, type SubscriptionProvider } from './shared.js'
import { SUBSCRIPTION_CAPABILITIES } from './capabilities.js'

export { SubscriptionManager, vendorOf } from './subscription/manager.js'
export { registerSubscriptionRoutes } from './subscription/subscription-route.js'
export { SUBSCRIPTION_TIMEOUT_MS } from './shared.js'

/** Translate image tool options into each subscription channel's wire inputs. */
export function subscriptionToolParameters(provider: SubscriptionProvider, options: { size?: string; aspectRatio?: string; imageSize?: string }): { size?: string; quality?: string } {
  const requestedSize = options.size?.trim() || undefined
  const ratio = options.aspectRatio?.trim() || undefined
  const imageSize = options.imageSize?.trim() || undefined
  if (requestedSize !== undefined && ratio !== undefined) throw new Error('size 与 aspect_ratio 请只选一个；无关可选字段请省略，不要填写空字符串')
  if (ratio !== undefined && !SUBSCRIPTION_CAPABILITIES[provider].ratioOptions.some(option => option.value === ratio)) throw new Error(`${provider} 不支持比例 ${ratio}`)
  const size = requestedSize ?? (ratio === undefined ? undefined : provider === 'chatgpt-sub' ? SUBSCRIPTION_CAPABILITIES[provider].sizeFor?.(ratio, 'auto') : ratio)
  let quality: string | undefined
  if (imageSize !== undefined) {
    if (provider === 'grok-sub' && (imageSize === '1K' || imageSize === '2K')) quality = imageSize.toLowerCase()
    else if (provider === 'google-sub' && imageSize === '4K') quality = 'hd'
    else if (provider === 'google-sub' && imageSize === '1K') quality = undefined
    else throw new Error(`${provider} 不支持清晰度 ${imageSize}；${provider === 'chatgpt-sub' ? '请省略 image_size，使用 size 或 aspect_ratio 指定尺寸' : `image_size 仅支持 ${provider === 'grok-sub' ? '1K、2K' : '1K、4K'}`}`)
  }
  return { ...(size === undefined ? {} : { size }), ...(quality === undefined ? {} : { quality }) }
}

/**
 * Generate one image through a logged-in subscription account. Returns the
 * same `{ data, mediaType }` contract as the API-key adapters so the caller
 * can feed it straight into `saveGenerated`. With sourceImages the call is
 * an edit: the vendor layer picks the channel's edit endpoint.
 */
export async function generateSubscriptionImage(options: {
  manager: SubscriptionManager
  provider: SubscriptionProvider
  prompt: string
  size?: string
  quality?: string
  sourceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: ImageMediaType }>
  maxBytes: number
  signal: AbortSignal
}): Promise<{ data: Uint8Array; mediaType: ImageMediaType; revisedPrompt?: string; reportedQuality?: string }> {
  const { manager, provider, prompt, maxBytes, signal } = options
  const size = options.size?.trim()
  const quality = options.quality?.trim()
  const sourceImages = options.sourceImages ?? []
  const result = await withTimeout(
    manager.generate({
      vendor: vendorOf(provider),
      prompt,
      ...(size !== undefined && size.length > 0 ? { size } : {}),
      ...(quality !== undefined && quality.length > 0 ? { quality } : {}),
      ...(sourceImages.length > 0 ? { referenceImages: sourceImages } : {}),
      signal,
    }),
    signal,
  )
  const first = Array.isArray(result) ? result[0] : undefined
  if (first === undefined || typeof first.b64_json !== 'string' || first.b64_json.length === 0) {
    throw new Error('Subscription image reply contained no image payload')
  }
  const bytes = new Uint8Array(Buffer.from(first.b64_json, 'base64'))
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Subscription image is ${formatBytes(bytes.byteLength)}, above this DSH's ${formatBytes(maxBytes)} limit`)
  }
  const mediaType = detectImageMediaType(bytes)
  if (mediaType === undefined) {
    throw new Error('Subscription image payload has an unrecognized format')
  }
  return {
    data: bytes,
    mediaType,
    ...(typeof first.revisedPrompt === 'string' && first.revisedPrompt.length > 0 ? { revisedPrompt: first.revisedPrompt } : {}),
    ...(typeof first.reportedQuality === 'string' && first.reportedQuality.length > 0 ? { reportedQuality: first.reportedQuality } : {}),
  }
}

/** Run one promise with the subscription timeout and the call's abort signal. */
async function withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectCall: (error: Error) => void
  const onAbort = (): void => { rejectCall(new Error('Subscription image generation aborted')) }
  const guarded = new Promise<T>((resolve, reject) => {
    rejectCall = reject
    timer = setTimeout(() => { reject(new Error(`Subscription image generation timed out after ${String(Math.round(SUBSCRIPTION_TIMEOUT_MS / 1000))}s`)) }, SUBSCRIPTION_TIMEOUT_MS)
    promise.then(resolve, reject)
  })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await guarded
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)}MB`
  return `${String(Math.round(bytes / 1024))}KB`
}
