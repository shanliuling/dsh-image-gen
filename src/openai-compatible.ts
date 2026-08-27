/** OpenAI Images API and compatible response adapter. */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

const ERROR_LIMIT = 4096

export interface GeneratedCompatibleImage {
  data: Uint8Array
  mediaType: ImageMediaType
}

export interface CompatibleReferenceImage {
  data: Uint8Array
  mediaType: ImageMediaType
}

export async function generateOpenAICompatibleImage(input: {
  provider: 'openai' | 'seedream'
  apiKey: string
  baseURL: string
  model: string
  prompt: string
  size: string
  maxBytes: number
  signal: AbortSignal
}): Promise<GeneratedCompatibleImage> {
  const response = await fetch(imageEndpoint(input.baseURL, 'generations'), {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: input.model, prompt: input.prompt, size: input.size, ...(input.provider === 'seedream' ? { response_format: 'url' } : {}) }),
  })
  return parseImageResponse(response, input.provider, input)
}

export async function editOpenAICompatibleImage(input: {
  apiKey: string
  baseURL: string
  model: string
  prompt: string
  sourceImages: CompatibleReferenceImage[]
  size?: string
  maxBytes: number
  signal: AbortSignal
}): Promise<GeneratedCompatibleImage> {
  const form = new FormData()
  const imageField = input.sourceImages.length === 1 ? 'image' : 'image[]'
  input.sourceImages.forEach((sourceImage, index) => {
    const uploadBytes = new Uint8Array(sourceImage.data)
    form.append(imageField, new Blob([uploadBytes], { type: sourceImage.mediaType }), `reference-${index + 1}.${extensionOf(sourceImage.mediaType)}`)
  })
  form.append('prompt', input.prompt)
  form.append('model', input.model)
  if (input.size !== undefined && input.size.length > 0) form.append('size', input.size)

  const response = await fetch(imageEndpoint(input.baseURL, 'edits'), {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
  })
  return parseImageResponse(response, 'openai', input)
}

async function parseImageResponse(
  response: Response,
  provider: string,
  input: { maxBytes: number; signal: AbortSignal; apiKey?: string },
): Promise<GeneratedCompatibleImage> {
  const text = await readBoundedText(response, Math.ceil(input.maxBytes * 1.4) + ERROR_LIMIT)
  if (!response.ok) throw new Error(`${provider} image request failed (${response.status}): ${text.slice(0, ERROR_LIMIT)}`)
  let payload: unknown
  try { payload = JSON.parse(text) } catch { throw new Error(`${provider} image request returned invalid JSON`) }
  const image = firstImage(payload)
  if (image === undefined) throw new Error(`${provider} image request returned no image: ${text.slice(0, ERROR_LIMIT)}`)
  if (image.b64_json !== undefined) return { data: decodeBase64(image.b64_json, provider), mediaType: imageMediaType(image.mime_type) ?? 'image/png' }
  return downloadImage(image.url, provider, input)
}

function imageEndpoint(baseURL: string, operation: 'generations' | 'edits'): string {
  try { return new URL(`images/${operation}`, baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString() } catch { throw new Error('Image endpoint must be an absolute URL') }
}

function firstImage(value: unknown): { b64_json?: string; url?: string; mime_type?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { data?: unknown; images?: unknown; output?: unknown }
  const data = Array.isArray(record.data) ? record.data : Array.isArray(record.images) ? record.images : Array.isArray(record.output) ? record.output : undefined
  if (data === undefined || data.length === 0) return undefined
  const candidate = data[0]
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
  const item = candidate as { b64_json?: unknown; url?: unknown; mime_type?: unknown; mime?: unknown }
  const mime = typeof item.mime_type === 'string' ? item.mime_type : typeof item.mime === 'string' ? item.mime : undefined
  return typeof item.b64_json === 'string'
    ? { b64_json: item.b64_json, ...(mime === undefined ? {} : { mime_type: mime }) }
    : typeof item.url === 'string'
      ? { url: item.url, ...(mime === undefined ? {} : { mime_type: mime }) }
      : undefined
}

async function downloadImage(
  url: string | undefined,
  provider: string,
  input: { maxBytes: number; signal: AbortSignal; apiKey?: string },
): Promise<GeneratedCompatibleImage> {
  if (url === undefined) throw new Error(`${provider} image request returned no image data`)
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) throw new Error(`${provider} image request returned invalid data URL`)
    return { data: decodeBase64(parsed.base64, provider), mediaType: imageMediaType(parsed.mediaType) ?? 'image/png' }
  }
  const response = await fetch(url, {
    redirect: 'follow', signal: input.signal,
    ...(input.apiKey === undefined ? {} : { headers: { authorization: `Bearer ${input.apiKey}` } }),
  })
  if (!response.ok) throw new Error(`${provider} image download failed (${response.status})`)
  const mediaType = imageMediaType(response.headers.get('content-type'))
  if (mediaType === undefined) throw new Error(`${provider} image download returned unsupported content type`)
  return { data: await readBoundedBytes(response, input.maxBytes), mediaType }
}

function parseDataUrl(value: string): { mediaType: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value.trim())
  return match?.[1] !== undefined && match[2] !== undefined ? { mediaType: match[1], base64: match[2] } : undefined
}

function extensionOf(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/png': return 'png'
  }
}

function decodeBase64(value: string, provider: string): Uint8Array {
  const parsed = parseDataUrl(value)
  const clean = (parsed?.base64 ?? value).replace(/\s+/g, '')
  if (clean.length === 0) throw new Error(`${provider} image request returned invalid base64 image data`)
  const decoded = Buffer.from(clean, 'base64')
  if (decoded.length === 0) throw new Error(`${provider} image request returned invalid base64 image data`)
  return new Uint8Array(decoded)
}

function imageMediaType(value: string | null | undefined): ImageMediaType | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif' ? mediaType : undefined
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> { return new TextDecoder().decode(await readBoundedBytes(response, maxBytes)) }

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxBytes) throw new Error(`Image response exceeded the ${String(maxBytes)} byte limit`); chunks.push(next.value) } } finally { reader.releaseLock() }
  const joined = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}
