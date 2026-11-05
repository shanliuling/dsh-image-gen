import { downloadPublicImage } from './public-image-download.js'
/** DashScope Qwen Image generation and editing adapter. */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { guardedFetch, readResponseBody } from './fetch-diagnostics.js'
import { redactSecrets } from './redact.js'
import { detectImageMediaType } from './reference-image.js'

export interface DashScopeImageOptions {
  apiKey: string
  endpoint: string
  model: string
  prompt: string
  size?: string
  watermark?: boolean
  maxBytes: number
  signal?: AbortSignal
}

export interface DashScopeEditOptions extends DashScopeImageOptions {
  sourceImages: Array<{ data: Uint8Array; mediaType: ImageMediaType }>
}

interface DashScopeChoiceMessageContent {
  text?: string
  image?: string
  image_url?: string
  url?: string
}

interface DashScopeResponse {
  output?: {
    choices?: Array<{ message?: { content?: DashScopeChoiceMessageContent[] } }>
  }
  message?: string
  code?: string
}

export async function generateDashScopeImage(options: DashScopeImageOptions): Promise<{
  data: Uint8Array
  mediaType: ImageAttachmentRef['mediaType']
}> {
  assertQwenImageModel(options.model)
  const formattedSize = formatSize(options.size)
  return requestQwenImage({
    ...options,
    requestBody: {
      model: options.model,
      input: {
        messages: [{ role: 'user', content: [{ text: options.prompt }] }],
      },
      parameters: {
        ...(formattedSize === undefined ? {} : { size: formattedSize }),
        ...(options.watermark === undefined ? {} : { watermark: options.watermark }),
      },
    },
    operation: 'generation',
  })
}

export async function editDashScopeImage(options: DashScopeEditOptions): Promise<{
  data: Uint8Array
  mediaType: ImageAttachmentRef['mediaType']
}> {
  if (options.sourceImages.length > 3) throw new Error(`DashScope image editing supports at most 3 reference images; this selection resolved ${options.sourceImages.length}. Select fewer images or choose a provider that supports more references. No images were omitted.`)
  assertQwenImageModel(options.model)
  const formattedSize = formatSize(options.size)
  return requestQwenImage({
    ...options,
    requestBody: {
      model: options.model,
      input: {
        messages: [{
          role: 'user',
          content: [
            ...options.sourceImages.map(sourceImage => ({ image: toDataUrl(sourceImage) })),
            { text: options.prompt },
          ],
        }],
      },
      parameters: {
        prompt_extend: true,
        ...(formattedSize === undefined ? {} : { size: formattedSize }),
        ...(options.watermark === undefined ? {} : { watermark: options.watermark }),
      },
    },
    operation: 'editing',
  })
}

function assertQwenImageModel(model: string): void {
  if (!model.toLowerCase().startsWith('qwen-image')) {
    throw new Error(`Unsupported DashScope image model ${model}. Configure a qwen-image model.`)
  }
}

function formatSize(size: string | undefined): string | undefined {
  if (size === undefined || size.length === 0) return undefined
  return size.replace('x', '*')
}

function toDataUrl(image: { data: Uint8Array; mediaType: ImageMediaType }): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

async function requestQwenImage(options: DashScopeImageOptions & {
  requestBody: unknown
  operation: 'generation' | 'editing'
}): Promise<{ data: Uint8Array; mediaType: ImageAttachmentRef['mediaType'] }> {
  const base = options.endpoint.replace(/\/+$/, '')
  const response = await guardedFetch(`DashScope image ${options.operation}`, options.signal, () => fetch(`${base}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(options.requestBody),
  }), options.apiKey)

  if (!response.ok) {
    const errorText = redactSecrets(await readResponseBody(response, () => response.text()), options.apiKey)
    throw new Error(`DashScope image ${options.operation} failed (${String(response.status)}): ${errorText}`)
  }

  const payload = JSON.parse(await readResponseBody(response, () => response.text())) as DashScopeResponse
  const imageUrl = extractImageUrl(payload)
  if (imageUrl === undefined) {
    throw new Error(`DashScope image ${options.operation} returned no image URL: ${redactSecrets(payload.message ?? JSON.stringify(payload), options.apiKey)}`)
  }
  return downloadImageBlob(imageUrl, options)
}

function extractImageUrl(response: DashScopeResponse): string | undefined {
  const contents = response.output?.choices?.[0]?.message?.content
  if (!Array.isArray(contents)) return undefined
  for (const item of contents) {
    if (item.image !== undefined && item.image.length > 0) return item.image
    if (item.image_url !== undefined && item.image_url.length > 0) return item.image_url
    if (item.url !== undefined && item.url.length > 0) return item.url
  }
  return undefined
}

async function downloadImageBlob(
  imageUrl: string,
  options: DashScopeImageOptions,
): Promise<{ data: Uint8Array; mediaType: ImageAttachmentRef['mediaType'] }> {
  const { data, contentType } = await downloadPublicImage(imageUrl, options)
  const mediaType = detectImageMediaType(data) ?? imageMediaType(contentType)
  if (mediaType === undefined) throw new Error(`DashScope image download returned an unsupported content type: ${contentType ?? 'none'}`)
  return { data, mediaType }
}

function imageMediaType(value: string | null | undefined): ImageMediaType | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif' ? mediaType : undefined
}
