/** DashScope Qwen Image generation and editing adapter. */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

export interface DashScopeImageOptions {
  apiKey: string
  endpoint: string
  model: string
  prompt: string
  size?: string
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
      },
    },
    operation: 'generation',
  })
}

export async function editDashScopeImage(options: DashScopeEditOptions): Promise<{
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
  const response = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(options.requestBody),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`DashScope image ${options.operation} failed (${String(response.status)}): ${errorText}`)
  }

  const payload = (await response.json()) as DashScopeResponse
  const imageUrl = extractImageUrl(payload)
  if (imageUrl === undefined) {
    throw new Error(`DashScope image ${options.operation} returned no image URL: ${payload.message ?? JSON.stringify(payload)}`)
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
  const imageResponse = await fetch(imageUrl, {
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch DashScope image from URL (${String(imageResponse.status)})`)
  }
  const buffer = await imageResponse.arrayBuffer()
  if (buffer.byteLength > options.maxBytes) {
    throw new Error(`DashScope generated image (${String(buffer.byteLength)} bytes) exceeds the ${String(options.maxBytes)} byte limit`)
  }
  const contentType = imageResponse.headers.get('content-type')
  const mediaType: ImageAttachmentRef['mediaType'] =
    contentType?.includes('png') ? 'image/png' :
    contentType?.includes('webp') ? 'image/webp' :
    'image/jpeg'
  return { data: new Uint8Array(buffer), mediaType }
}
