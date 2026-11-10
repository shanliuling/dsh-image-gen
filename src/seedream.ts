/** Volcengine Ark Seedream image-editing adapter. */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { downloadPublicImage } from './public-image-download.js'
import type { GeneratedCompatibleImage } from './openai-compatible.js'
import { guardedFetch, readResponseBody } from './fetch-diagnostics.js'
import { redactSecrets } from './redact.js'
import { detectImageMediaType } from './reference-image.js'
import { arkOutputBody, type ArkOutputOptions } from './shared.js'

const ERROR_LIMIT = 4096

/** Edit one image through Ark ImageGenerations using a data-URL reference. */
export async function editSeedreamImage(input: {
  apiKey: string
  baseURL: string
  model: string
  prompt: string
  sourceImages: Array<{ data: Uint8Array; mediaType: ImageMediaType }>
  size?: string
  maxBytes: number
  strictImageDownloads?: boolean
  signal: AbortSignal
  /**
   * Ark output controls. The edit path is the only one Ark lets request a
   * transparent background, and it requires every reference image to carry an
   * alpha channel — see `arkOutputBody`.
   */
  arkOptions?: ArkOutputOptions
}): Promise<GeneratedCompatibleImage> {
  const response = await guardedFetch('seedream image editing', input.signal, () => fetch(imageEndpoint(input.baseURL), {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      image: input.sourceImages.map(toDataUrl),
      ...(input.size === undefined || input.size.length === 0 ? {} : { size: input.size }),
      ...arkOutputBody(input.arkOptions),
      response_format: 'b64_json',
    }),
  }), input.apiKey)

  const text = await readBoundedText(response, Math.ceil(input.maxBytes * 1.4) + ERROR_LIMIT)
  if (!response.ok) throw new Error(`seedream image editing failed (${response.status}): ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`)
  let payload: unknown
  try { payload = JSON.parse(text) } catch { throw new Error('seedream image editing returned invalid JSON') }
  const image = firstImage(payload)
  if (image === undefined) throw new Error(`seedream image editing returned no image: ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`)
  if (image.b64_json !== undefined) {
    // Ark omits mime_type and its bytes follow output_format (jpeg by default),
    // so sniff before trusting the header; a sniffed mismatch would otherwise
    // fail the host attachment service with IMAGE_TYPE_MISMATCH (#61).
    const data = decodeBase64(image.b64_json)
    return { data, mediaType: detectImageMediaType(data) ?? imageMediaType(image.mime_type) ?? 'image/png' }
  }
  return downloadImage(image.url, input)
}

function imageEndpoint(baseURL: string): string {
  try { return new URL('images/generations', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString() } catch { throw new Error('Seedream image endpoint must be an absolute URL') }
}

function toDataUrl(image: { data: Uint8Array; mediaType: ImageMediaType }): string {
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

async function downloadImage(url: string | undefined, input: { maxBytes: number; signal: AbortSignal; apiKey: string; strictImageDownloads?: boolean }): Promise<GeneratedCompatibleImage> {
  if (url === undefined) throw new Error('seedream image editing returned no image data')
  if (input.strictImageDownloads === true) {
    const { data, contentType } = await downloadPublicImage(url, input)
    const mediaType = imageMediaType(contentType)
    if (mediaType === undefined) throw new Error('seedream image download returned unsupported content type')
    return { data, mediaType }
  }
  const response = await guardedFetch('seedream image download', input.signal, () => fetch(url, { redirect: 'follow', signal: input.signal }), input.apiKey)
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`seedream image download failed (${response.status})`)
  }
  const mediaType = imageMediaType(response.headers.get('content-type'))
  if (mediaType === undefined) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('seedream image download returned unsupported content type')
  }
  return { data: await readBoundedBytes(response, input.maxBytes), mediaType }
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '')
  if (clean.length === 0) throw new Error('seedream image editing returned invalid base64 image data')
  const decoded = Buffer.from(clean, 'base64')
  if (decoded.length === 0) throw new Error('seedream image editing returned invalid base64 image data')
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
  try { for (;;) { const next = await readResponseBody(response, () => reader.read()); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxBytes) throw new Error(`Image response exceeded the ${String(maxBytes)} byte limit`); chunks.push(next.value) } } catch (error) { await reader.cancel().catch(() => undefined); throw error } finally { reader.releaseLock() }
  const joined = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}
