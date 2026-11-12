/** Image-capable models advertised by the host's configured conversation providers. */
import { lookup } from 'node:dns/promises'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { detectImageMediaType } from './reference-image.js'
import { CLOUD_IMAGE_PROVIDERS, LLM_PROVIDER_PREFIX, SUBSCRIPTION_PROVIDERS, isLlmImageProvider, llmProviderIdOf, type StudioGenerateRequest, type StudioGeneratedItem, type StudioProviderProfile } from './shared.js'

const IMAGE_MODEL = /生图|绘图|图像生成|图片生成|image[ -]?(?:gen|generation)|seedream|dall-?e|gpt-image|flux|imagen|cogview|qwen-image|wanx|grok-imagine/i

/** Redirect hops a download may take; every hop is re-validated against the public-address rule. */
const MAX_REDIRECTS = 3

/** How long a provider catalog is reused, so the Studio describe route is not gated on every render. */
const CATALOG_TTL_MS = 60_000

interface LlmProviderInfo { id: string; name: string }
interface LlmModelInfo { id: string; name: string }
interface LlmService {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  stream(options: {
    provider: string
    model: string
    /** DSH request messages carry content blocks, never a bare string. */
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    signal: AbortSignal
  }): AsyncIterable<unknown>
}

export { isLlmImageProvider, llmProviderIdOf }

function llmOf(ctx: Context): LlmService | undefined {
  const get = (ctx as Context & { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, 'llm') as LlmService | undefined
  } catch {
    return undefined
  }
}

/**
 * Provider catalogs, keyed by provider id, shared by the Studio describe route
 * and the generation path. The describe route used to await every `listModels`
 * on each render, which stalled the workbench behind slow providers; a short
 * TTL keeps a newly signed-in provider visible without that cost.
 */
const catalogCache = new Map<string, { at: number; models: LlmModelInfo[] }>()
const catalogInFlight = new Map<string, Promise<LlmModelInfo[]>>()

async function listModelsCached(llm: LlmService, providerId: string): Promise<LlmModelInfo[]> {
  const cached = catalogCache.get(providerId)
  if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models
  const pending = catalogInFlight.get(providerId)
  if (pending !== undefined) return pending
  const request = (async () => {
    const models = await llm.listModels(providerId)
    catalogCache.set(providerId, { at: Date.now(), models })
    return models
  })()
  catalogInFlight.set(providerId, request)
  try {
    return await request
  } finally {
    catalogInFlight.delete(providerId)
  }
}

/** Only explicit image-generation aliases qualify; multimodal chat models do not. */
export function isLlmImageModel(model: LlmModelInfo): boolean {
  return IMAGE_MODEL.test(model.id) || IMAGE_MODEL.test(model.name)
}

export async function llmImageProfiles(ctx: Context): Promise<StudioProviderProfile[]> {
  const llm = llmOf(ctx)
  if (llm === undefined) return []
  const candidates = llm.listProviders().filter(provider =>
    !(CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(provider.id)
    && !(SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider.id))
  // One slow or dead provider must not gate the whole workbench: settle all
  // catalogs in parallel and keep whatever answers.
  const settled = await Promise.all(candidates.map(async provider => {
    try {
      return { provider, models: (await listModelsCached(llm, provider.id)).filter(isLlmImageModel) }
    } catch {
      return { provider, models: [] as LlmModelInfo[] }
    }
  }))
  const profiles: StudioProviderProfile[] = []
  for (const { provider, models } of settled) {
    if (models.length === 0) continue
    const options = models.map(model => ({ value: model.id, label: model.name }))
    profiles.push({
      provider: `${LLM_PROVIDER_PREFIX}${provider.id}`,
      label: `${provider.name} · 对话模型`,
      model: options[0]!.value,
      modelOptions: options,
      configured: true,
      supportsEditing: false,
      // The conversation transport forwards no size or ratio control, so the
      // only honest option is the channel default.
      ratioOptions: [{ value: 'default', label: '通道默认' }],
      qualityOptions: [{ value: 'default', label: '通道默认' }],
      defaultRatio: 'default',
      defaultQuality: 'default',
      watermarkCapabilities: { generate: { status: 'unavailable', reason: 'no-api-control' }, edit: { status: 'unavailable', reason: 'no-api-control' } },
    })
  }
  return profiles
}

/**
 * Extract generated image links from the conversation reply.
 *
 * Markdown image targets come first: a reply that cites a documentation page
 * before its own `![result](…)` would otherwise download the article and trip
 * the format check before the image was ever tried.
 */
export function imageUrlsFromText(text: string): string[] {
  const unquote = (raw: string): string => raw
    .replace(/^<|>$/g, '')
    .replace(/[.,;!?，。；！？]+$/g, '')
  const urls: string[] = []
  const push = (candidate: string): void => {
    const url = unquote(candidate)
    if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url)
  }
  // Markdown image syntax, including an optional title: ![alt](url "title").
  for (const match of text.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) push(match[1]!)
  // Bare URLs are the fallback for providers that answer with a plain link.
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) push(match[0])
  return urls
}

function imageBlockAttachment(chunk: unknown): ImageAttachmentRef | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const block = (chunk as { block?: unknown }).block
  if (typeof block !== 'object' || block === null) return undefined
  const candidate = block as { type?: string; attachment?: ImageAttachmentRef }
  return candidate.type === 'image' ? candidate.attachment : undefined
}

/** True for addresses a server-side fetch must never reach on a model's behalf. */
export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
    if (mapped !== null) return isPublicAddress(mapped[1]!)
    if (normalized === '::' || normalized === '::1') return false
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return false
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return false
    if (/^ff[0-9a-f]{2}:/.test(normalized)) return false
    return true
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 0 || b === 168)) return false
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
  if (a === 203 && b === 0) return false
  if (a >= 224) return false
  return true
}

/**
 * Reject a URL whose host resolves anywhere non-public. Applied before the
 * request and again on every redirect hop: model output is untrusted, and a
 * public URL may redirect to loopback or a link-local metadata endpoint.
 */
async function assertPublicDestination(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('生图结果链接无效')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('生图结果链接必须是 HTTP(S)')
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  // A literal address needs no resolver round trip.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (!isPublicAddress(host)) throw new Error('生图结果链接指向非公网地址，已拒绝')
    return
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('生图结果链接无法解析')
  }
  if (addresses.length === 0) throw new Error('生图结果链接无法解析')
  for (const entry of addresses) {
    if (!isPublicAddress(entry.address)) throw new Error('生图结果链接指向非公网地址，已拒绝')
  }
}

async function downloadImage(url: string, maxBytes: number, signal: AbortSignal): Promise<{ data: Uint8Array; mediaType: ImageMediaType }> {
  let target = url
  let response: Response | undefined
  // Redirects are followed by hand so each hop is validated before it is dialled.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicDestination(target)
    const current: Response = await fetch(target, { signal, redirect: 'manual' })
    if (current.status >= 300 && current.status < 400) {
      const location = current.headers.get('location')
      await current.body?.cancel().catch(() => undefined)
      if (location === null) throw new Error(`生图图片下载失败（HTTP ${String(current.status)}）`)
      if (hop === MAX_REDIRECTS) throw new Error('生图结果链接重定向次数过多')
      target = new URL(location, target).toString()
      continue
    }
    response = current
    break
  }
  if (response === undefined) throw new Error('生图图片下载失败')
  if (!response.ok) throw new Error(`生图图片下载失败（HTTP ${String(response.status)}）`)
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('生图结果超过当前 DSH 的大小限制')
  }
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > maxBytes) throw new Error('生图结果超过当前 DSH 的大小限制')
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const mediaType = detectImageMediaType(data)
    ?? (contentType === 'image/png' || contentType === 'image/jpeg' || contentType === 'image/webp' || contentType === 'image/gif' ? contentType : undefined)
  if (mediaType === undefined) throw new Error('生图结果不是受支持的图片格式')
  return { data, mediaType }
}

/** Stream the selected conversation model and return the generated image bytes, unsaved. */
export async function fetchLlmImageBytes(
  ctx: Context,
  input: StudioGenerateRequest,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; mediaType: ImageMediaType; model: string }> {
  const llm = llmOf(ctx)
  if (llm === undefined) throw new Error('当前 DSH 未提供对话模型服务')
  const provider = llmProviderIdOf(input.provider)
  const catalog = await listModelsCached(llm, provider)
  // An empty selection falls back to the catalog's first image model: the
  // picker writes the choice, but a provider selected without opening the
  // model submenu must still draw instead of dead-ending.
  const selected = input.model.length > 0
    ? catalog.find(model => model.id === input.model)
    : catalog.filter(isLlmImageModel)[0]
  if (selected === undefined || !isLlmImageModel(selected)) throw new Error('所选模型不是当前对话通道已启用的生图模型')
  let text = ''
  const attachments: ImageAttachmentRef[] = []
  for await (const chunk of llm.stream({
    provider,
    model: selected.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
    signal,
  })) {
    const part = chunk as { type?: string; text?: string }
    if (part.type === 'text-delta' && typeof part.text === 'string') text += part.text
    const attachment = imageBlockAttachment(chunk)
    if (attachment !== undefined) attachments.push(attachment)
  }
  if (attachments.length > 0) {
    const stored = await ctx.attachments.readImage(attachments[0]!)
    return { data: stored.data, mediaType: attachments[0]!.mediaType, model: selected.id }
  }
  const urls = imageUrlsFromText(text)
  if (urls.length === 0) {
    const reply = text.trim()
    throw new Error(reply.length === 0
      ? '对话模型没有返回任何内容；请确认该生图模型在提供方中可用'
      : `对话模型未返回图片；回复开头：${reply.slice(0, 120)}`)
  }
  const downloaded = await downloadImage(urls[0]!, ctx.attachments.imageLimits.maxImageBytes, signal)
  return { ...downloaded, model: selected.id }
}

export async function generateLlmImage(
  ctx: Context,
  input: StudioGenerateRequest,
  signal: AbortSignal,
): Promise<StudioGeneratedItem> {
  if (input.mode === 'edit') throw new Error('该对话模型通道暂不支持图生图')
  const generated = await fetchLlmImageBytes(ctx, input, signal)
  const attachment = await ctx.attachments.saveImage({ data: generated.data, mediaType: generated.mediaType, name: 'studio-llm-image' })
  return { attachment, output: '对话模型通道' }
}
