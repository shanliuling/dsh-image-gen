/** OpenAI Images API and compatible response adapter. */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { guardedFetch, readResponseBody } from './fetch-diagnostics.js'
import { redactSecrets } from './redact.js'
import { detectImageMediaType } from './reference-image.js'
import { arkOutputBody, type ArkOutputOptions } from './shared.js'

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
  provider: 'openai' | 'openai-compat' | 'seedream' | 'xai' | 'zhipu'
  apiKey: string
  baseURL: string
  model: string
  prompt: string
  /**
   * Pixel size or tier string. Optional because not every channel accepts
   * `size` at all — xAI takes aspect_ratio+resolution via `extraBody` and
   * rejects nothing but silently ignores unknown fields, so we simply omit
   * the parameter for it.
   */
  size?: string
  /** Vendor quality tier (e.g. OpenAI low/medium/high); omitted when unset. */
  quality?: string
  /** Extra JSON fields merged last into the generations body (xAI aspect_ratio/resolution). */
  extraBody?: Readonly<Record<string, unknown>>
  maxBytes: number
  signal: AbortSignal
  /** Ark-only output controls; ignored by every other provider. */
  arkOptions?: ArkOutputOptions
}): Promise<GeneratedCompatibleImage> {
  const response = await guardedFetch(`${input.provider} image request`, input.signal, () => fetch(imageEndpoint(input.baseURL, 'generations'), {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      ...(input.size === undefined ? {} : { size: input.size }),
      ...(input.quality === undefined ? {} : { quality: input.quality }),
      // `background: false` — Ark rejects `transparent` on this endpoint
      // outright (it needs exactly one input image), so it is the edit path's
      // option alone.
      ...(input.provider === 'seedream' ? { response_format: 'url', ...arkOutputBody(input.arkOptions, { background: false }) } : {}),
      ...(input.extraBody ?? {}),
    }),
  }), input.apiKey)
  return parseImageResponse(response, input.provider, input)
}

/** How the edits endpoint expects its request body (#41). */
export type CompatEditFormat = 'multipart' | 'jsonImageUrlArray' | 'formReferenceImages' | 'siliconflowJson' | 'xaiJson' | 'qwenJson'

export async function editOpenAICompatibleImage(input: {
  apiKey: string
  baseURL: string
  model: string
  prompt: string
  sourceImages: CompatibleReferenceImage[]
  size?: string
  maxBytes: number
  signal: AbortSignal
  /**
   * Request shape for the edits call. Most OpenAI-compatible channels take
   * the standard multipart form; some (e.g. SenseNova) accept OpenAI's
   * generations endpoint but run edits on their own JSON contract with
   * `images: [{ image_url }]` objects. Defaults to the standard multipart.
   */
  editFormat?: CompatEditFormat
  editSizeMode?: 'auto' | 'selected'
  /**
   * Channel-specific extra fields merged into the JSON edit body last (so
   * they can override the defaults above), e.g. SenseNova's
   * `watermark`/`prompt_extend`. Ignored in multipart mode.
   */
  editExtra?: Readonly<Record<string, unknown>>
  /** Vendor quality tier sent with the edit request when set. */
  quality?: string
  /**
   * Extra fields for the edit request (multipart: one form field per entry;
   * JSON shapes: merged after `editExtra`), e.g. xAI's
   * aspect_ratio/resolution pair.
   */
  extraBody?: Readonly<Record<string, unknown>>
}): Promise<GeneratedCompatibleImage> {
  if (input.editFormat === 'siliconflowJson') {
    const body: Record<string, unknown> = { model: input.model, prompt: input.prompt, ...(input.editExtra ?? {}), ...(input.extraBody ?? {}) }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) throw new Error('硅基流动图生图需要编辑模型')
    body.model = model
    if (model === 'Qwen/Qwen-Image') throw new Error('Qwen/Qwen-Image 是文生图模型；请配置图生图模型，例如 Qwen/Qwen-Image-Edit')
    const maxReferences = model === 'Qwen/Qwen-Image-Edit-2509' ? 3 : 1
    if (input.sourceImages.length < 1 || input.sourceImages.length > maxReferences) throw new Error(`${model} 图生图支持 1–${String(maxReferences)} 张参考图，当前 ${String(input.sourceImages.length)} 张；请精简参考图或选择支持多图的编辑模型`)
    // Qwen edits derive output dimensions from the reference. Generic picker
    // defaults must not turn into unsupported image_size/size/quality fields.
    if (['size', 'image_size', 'quality'].some(key => key in body)) throw new Error('此硅基流动图生图格式不发送 size、image_size 或 quality；请从图生图额外字段中移除这些字段')
    delete body.image
    delete body.image2
    delete body.image3
    for (const [index, source] of input.sourceImages.entries()) body[index === 0 ? 'image' : `image${String(index + 1)}`] = toDataUrl(source)
    const response = await guardedFetch('siliconflow image edit request', input.signal, () => fetch(imageEndpoint(input.baseURL, 'generations'), {
      method: 'POST', redirect: 'error', signal: input.signal,
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), input.apiKey)
    return parseImageResponse(response, 'siliconflow', input)
  }
  if (input.editFormat === 'qwenJson') {
    // Qwen's official compatible API edits through images/generations, using image URLs directly.
    const response = await guardedFetch('openai-compat image edit request', input.signal, () => fetch(imageEndpoint(input.baseURL, 'generations'), {
      method: 'POST', redirect: 'error', signal: input.signal,
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        image: input.sourceImages.map(toDataUrl),
        ...(input.size === undefined ? {} : { size: input.size }),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
        ...(input.editExtra ?? {}),
        ...(input.extraBody ?? {}),
      }),
    }), input.apiKey)
    return parseImageResponse(response, 'openai-compat', input)
  }
  if (input.editFormat === 'xaiJson') {
    const references = input.sourceImages.map(image => ({ type: 'image_url', url: toDataUrl(image) }))
    const response = await guardedFetch('xai image edit request', input.signal, () => fetch(imageEndpoint(input.baseURL, 'edits'), {
      method: 'POST', redirect: 'error', signal: input.signal,
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        ...(references.length === 1 ? { image: references[0] } : { images: references }),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
        ...(input.extraBody ?? {}),
      }),
    }), input.apiKey)
    return parseImageResponse(response, 'xai', input)
  }
  if (input.editFormat === 'jsonImageUrlArray') {
    const body = {
      model: input.model,
      images: input.sourceImages.map(sourceImage => ({ image_url: toDataUrl(sourceImage) })),
      prompt: input.prompt,
      n: 1,
      // Preserve SenseNova's auto default; other JSON relays can opt into
      // selected dimensions. editExtra remains the final channel override.
      size: input.editSizeMode === 'selected' ? (input.size ?? 'auto') : 'auto',
      response_format: 'url',
      ...(input.quality === undefined ? {} : { quality: input.quality }),
      ...(input.editExtra ?? {}),
      ...(input.extraBody ?? {}),
    }
    const response = await guardedFetch('openai image edit request', input.signal, () => fetch(imageEndpoint(input.baseURL, 'edits'), {
      method: 'POST', redirect: 'error', signal: input.signal,
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), input.apiKey)
    return parseImageResponse(response, 'openai', input)
  }
  if (input.editFormat === 'formReferenceImages') {
    // Some relays take edits as a multipart form whose `reference_images`
    // field is a JSON array of base64 strings instead of file uploads.
    const form = new FormData()
    form.append('model', input.model)
    form.append('prompt', input.prompt)
    if (input.size !== undefined && input.size.length > 0) form.append('size', input.size)
    if (input.quality !== undefined) form.append('quality', input.quality)
    for (const [key, value] of Object.entries(input.extraBody ?? {})) form.append(key, String(value))
    form.append('response_format', 'b64_json')
    form.append('reference_images', JSON.stringify(input.sourceImages.map(sourceImage => Buffer.from(sourceImage.data).toString('base64'))))
    const response = await guardedFetch('openai image edit request', input.signal, () => fetch(imageEndpoint(input.baseURL, 'edits'), {
      method: 'POST', redirect: 'error', signal: input.signal,
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
    }), input.apiKey)
    return parseImageResponse(response, 'openai', input)
  }
  const form = new FormData()
  const imageField = input.sourceImages.length > 1 ? 'image[]' : 'image'
  input.sourceImages.forEach((sourceImage, index) => {
    const uploadBytes = new Uint8Array(sourceImage.data)
    const blob = new Blob([uploadBytes], { type: sourceImage.mediaType })
    const filename = `reference-${index + 1}.${extensionOf(sourceImage.mediaType)}`
    form.append(imageField, blob, filename)
  })
  form.append('prompt', input.prompt)
  form.append('model', input.model)
  if (input.size !== undefined && input.size.length > 0) form.append('size', input.size)
  if (input.quality !== undefined) form.append('quality', input.quality)
  for (const [key, value] of Object.entries(input.extraBody ?? {})) form.append(key, String(value))

  const response = await guardedFetch('openai image edit request', input.signal, () => fetch(imageEndpoint(input.baseURL, 'edits'), {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
  }), input.apiKey)
  return parseImageResponse(response, 'openai', input)
}

async function parseImageResponse(
  response: Response,
  provider: string,
  input: { baseURL: string; maxBytes: number; signal: AbortSignal; apiKey?: string },
): Promise<GeneratedCompatibleImage> {
  const text = await readBoundedText(response, Math.ceil(input.maxBytes * 1.4) + ERROR_LIMIT)
  if (!response.ok) throw new Error(`${provider} image request failed (${response.status}): ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`)
  let payload: unknown
  try { payload = JSON.parse(text) } catch { throw new Error(`${provider} image request returned invalid JSON`) }
  const image = firstImage(payload)
  if (image === undefined) throw new Error(`${provider} image request returned no image: ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`)
  if (image.b64_json !== undefined) {
    // Relays may omit mime_type while returning non-PNG bytes (Ark jpeg), so
    // sniff before trusting the header to avoid IMAGE_TYPE_MISMATCH (#61).
    const data = decodeBase64(image.b64_json, provider)
    return { data, mediaType: detectImageMediaType(data) ?? imageMediaType(image.mime_type) ?? 'image/png' }
  }
  return downloadImage(image.url, provider, input)
}

function imageEndpoint(baseURL: string, operation: 'generations' | 'edits'): string {
  try { return new URL(`images/${operation}`, baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString() } catch { throw new Error('Image endpoint must be an absolute URL') }
}

function toDataUrl(image: CompatibleReferenceImage): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
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
  // Length checks matter: some channels send `b64_json: ""` (or an empty
  // `url`) alongside the real field, and an empty string would shadow a
  // usable sibling value and fail later as "no image / invalid base64".
  return typeof item.b64_json === 'string' && item.b64_json.length > 0
    ? { b64_json: item.b64_json, ...(mime === undefined ? {} : { mime_type: mime }) }
    : typeof item.url === 'string' && item.url.length > 0
      ? { url: item.url, ...(mime === undefined ? {} : { mime_type: mime }) }
      : undefined
}

// Some servers answer with a relative image URL instead of an absolute one:
// SGLang returns `/v1/images/<id>/content` unless an object store is configured (#105).
function resolveImageUrl(url: string, baseURL: string, provider: string): string {
  if (URL.canParse(url)) return url
  let resolved: URL
  try { resolved = new URL(url, baseURL.endsWith('/') ? baseURL : `${baseURL}/`) } catch {
    throw new Error(`${provider} image request returned an invalid image URL: ${url.slice(0, 120)}`)
  }
  // A relative path must not be able to switch schemes (file:, data:, ...)
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`${provider} image request returned an unsupported image URL: ${url.slice(0, 120)}`)
  }
  return resolved.toString()
}

async function downloadImage(
  url: string | undefined,
  provider: string,
  input: { baseURL: string; maxBytes: number; signal: AbortSignal; apiKey?: string },
): Promise<GeneratedCompatibleImage> {
  if (url === undefined) throw new Error(`${provider} image request returned no image data`)
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) throw new Error(`${provider} image request returned invalid data URL`)
    const data = decodeBase64(parsed.base64, provider)
    return { data, mediaType: detectImageMediaType(data) ?? imageMediaType(parsed.mediaType) ?? 'image/png' }
  }
  const target = resolveImageUrl(url, input.baseURL, provider)
  const sameOrigin = new URL(target).origin === new URL(input.baseURL).origin
  let response = await guardedFetch(`${provider} image download`, input.signal, () => fetch(target, {
    redirect: 'follow', signal: input.signal,
    ...(input.apiKey === undefined || !sameOrigin ? {} : { headers: { authorization: `Bearer ${input.apiKey}` } }),
  }), input.apiKey)
  // Some same-origin relays reject Authorization on public image URLs, so the
  // legacy retry remains available without ever sending the key to another origin.
  if (!response.ok && input.apiKey !== undefined && sameOrigin) {
    response = await guardedFetch(`${provider} image download`, input.signal, () => fetch(target, { redirect: 'follow', signal: input.signal }), input.apiKey)
  }
  if (!response.ok) throw new Error(`${provider} image download failed (${response.status})`)
  const data = await readBoundedBytes(response, input.maxBytes)
  const mediaType = detectImageMediaType(data) ?? imageMediaType(response.headers.get('content-type'))
  if (mediaType === undefined) throw new Error(`${provider} image download returned unsupported content type`)
  return { data, mediaType }
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
  try { for (;;) { const next = await readResponseBody(response, () => reader.read()); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxBytes) throw new Error(`Image response exceeded the ${String(maxBytes)} byte limit`); chunks.push(next.value) } } finally { reader.releaseLock() }
  const joined = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}
