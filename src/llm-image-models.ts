/** Image-capable models advertised by the host's configured conversation providers. */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { detectImageMediaType } from './reference-image.js'
import { CLOUD_IMAGE_PROVIDERS, SUBSCRIPTION_PROVIDERS, type StudioGenerateRequest, type StudioGeneratedItem, type StudioProviderProfile } from './shared.js'

const LLM_PREFIX = 'llm:'
const IMAGE_MODEL = /生图|绘图|图像生成|图片生成|image[ -]?(?:gen|generation)|seedream|dall-?e|gpt-image|flux|imagen|cogview|qwen-image|wanx|grok-imagine/i

interface LlmProviderInfo { id: string; name: string }
interface LlmModelInfo { id: string; name: string }
interface LlmService {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  stream(options: {
    provider: string
    model: string
    messages: Array<{ role: 'user'; content: string }>
    signal: AbortSignal
  }): AsyncIterable<unknown>
}

export function isLlmImageProvider(provider: string): provider is `llm:${string}` {
  return provider.startsWith(LLM_PREFIX) && provider.length > LLM_PREFIX.length
}

export function llmProviderId(provider: string): string {
  if (!isLlmImageProvider(provider)) throw new Error('无效的对话模型通道')
  return provider.slice(LLM_PREFIX.length)
}

function llmOf(ctx: Context): LlmService | undefined {
  const get = (ctx as Context & { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, 'llm') as LlmService | undefined
  } catch {
    return undefined
  }
}

/** Only explicit image-generation aliases qualify; multimodal chat models do not. */
export function isLlmImageModel(model: LlmModelInfo): boolean {
  return IMAGE_MODEL.test(model.id) || IMAGE_MODEL.test(model.name)
}

export async function llmImageProfiles(ctx: Context): Promise<StudioProviderProfile[]> {
  const llm = llmOf(ctx)
  if (llm === undefined) return []
  const profiles: StudioProviderProfile[] = []
  for (const provider of llm.listProviders()) {
    if ((CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(provider.id)
      || (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider.id)) continue
    let models: LlmModelInfo[]
    try {
      models = (await llm.listModels(provider.id)).filter(isLlmImageModel)
    } catch {
      continue
    }
    if (models.length === 0) continue
    const options = models.map(model => ({ value: model.id, label: model.name }))
    profiles.push({
      provider: `${LLM_PREFIX}${provider.id}`,
      label: `${provider.name} · 对话模型`,
      model: options[0]!.value,
      modelOptions: options,
      configured: true,
      supportsEditing: false,
      ratioOptions: ['1:1', '3:2', '2:3', '16:9', '9:16'].map(value => ({ value, label: value })),
      qualityOptions: [{ value: 'default', label: '通道默认' }],
      defaultRatio: '1:1',
      defaultQuality: 'default',
      watermarkCapabilities: { generate: { status: 'unavailable', reason: 'no-api-control' }, edit: { status: 'unavailable', reason: 'no-api-control' } },
    })
  }
  return profiles
}

/** Extract generated image links from the text-only OpenAI-compatible conversation transport. */
export function imageUrlsFromText(text: string): string[] {
  const urls: string[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const url = match[0].replace(/[.,;!?，。；！？]+$/g, '')
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

function imageBlockAttachment(chunk: unknown): ImageAttachmentRef | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const block = (chunk as { block?: unknown }).block
  if (typeof block !== 'object' || block === null) return undefined
  const candidate = block as { type?: string; attachment?: ImageAttachmentRef }
  return candidate.type === 'image' ? candidate.attachment : undefined
}

async function downloadImage(url: string, maxBytes: number, signal: AbortSignal): Promise<{ data: Uint8Array; mediaType: ImageMediaType }> {
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`生图图片下载失败（HTTP ${String(response.status)}）`)
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) throw new Error('生图结果超过当前 DSH 的大小限制')
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > maxBytes) throw new Error('生图结果超过当前 DSH 的大小限制')
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const mediaType = detectImageMediaType(data)
    ?? (contentType === 'image/png' || contentType === 'image/jpeg' || contentType === 'image/webp' || contentType === 'image/gif' ? contentType : undefined)
  if (mediaType === undefined) throw new Error('生图结果不是受支持的图片格式')
  return { data, mediaType }
}

export async function generateLlmImage(
  ctx: Context,
  input: StudioGenerateRequest,
  signal: AbortSignal,
): Promise<StudioGeneratedItem> {
  if (input.mode === 'edit') throw new Error('该对话模型通道暂不支持图生图')
  const llm = llmOf(ctx)
  if (llm === undefined) throw new Error('当前 DSH 未提供对话模型服务')
  const provider = llmProviderId(input.provider)
  const selected = (await llm.listModels(provider)).find(model => model.id === input.model)
  if (selected === undefined || !isLlmImageModel(selected)) throw new Error('所选模型不是当前对话通道已启用的生图模型')
  let text = ''
  const attachments: ImageAttachmentRef[] = []
  for await (const chunk of llm.stream({
    provider,
    model: input.model,
    messages: [{ role: 'user', content: input.prompt }],
    signal,
  })) {
    const part = chunk as { type?: string; text?: string }
    if (part.type === 'text-delta' && typeof part.text === 'string') text += part.text
    const attachment = imageBlockAttachment(chunk)
    if (attachment !== undefined) attachments.push(attachment)
  }
  if (attachments.length > 0) return { attachment: attachments[0]!, output: '对话模型通道' }
  const urls = imageUrlsFromText(text)
  if (urls.length === 0) throw new Error('对话模型未返回图片，请确认在提供方中启用了生图模型')
  const generated = await downloadImage(urls[0]!, ctx.attachments.imageLimits.maxImageBytes, signal)
  const attachment = await ctx.attachments.saveImage({ data: generated.data, mediaType: generated.mediaType, name: 'studio-llm-image' })
  return { attachment, output: '对话模型通道' }
}
