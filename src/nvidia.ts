/** NVIDIA NIM (build.nvidia.com) FLUX image generation and editing adapter. */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { guardedFetch, readResponseBody } from './fetch-diagnostics.js'
import { redactSecrets } from './redact.js'
import { detectImageMediaType } from './reference-image.js'

/** Hard limits from the NVIDIA ImageRequest schema (build.nvidia.com, 2026-11). */
const NVIDIA_MIN_EDGE = 512
const NVIDIA_MAX_EDGE = 1568
const NVIDIA_MAX_PIXELS = 1_062_400
const NVIDIA_MAX_PROMPT = 2000
const NVIDIA_MAX_REFERENCES = 10

export interface NvidiaImageOptions {
  apiKey: string
  endpoint: string
  model: string
  prompt: string
  /** Pixel size `WIDTHxHEIGHT`; each edge 512-1568, multiple of 16, area <= 1,062,400. */
  size?: string
  /** Prompt adherence (schema `cfg_scale`); omitted keeps the endpoint default 3.5. */
  cfgScale?: number
  /** Diffusion steps (schema `steps`); omitted keeps the endpoint default 50. */
  steps?: number
  maxBytes: number
  strictImageDownloads?: boolean
  signal?: AbortSignal
}

export interface NvidiaEditOptions extends NvidiaImageOptions {
  sourceImages: Array<{ data: Uint8Array; mediaType: ImageMediaType }>
}

interface NvidiaArtifact {
  base64?: string
  finishReason?: string
}

interface NvidiaResponse {
  artifacts?: NvidiaArtifact[]
  detail?: unknown
  message?: string
  title?: string
}

export async function generateNvidiaImage(options: NvidiaImageOptions): Promise<{
  data: Uint8Array
  mediaType: ImageAttachmentRef['mediaType']
}> {
  return requestNvidiaImage(options, {})
}

export async function editNvidiaImage(options: NvidiaEditOptions): Promise<{
  data: Uint8Array
  mediaType: ImageAttachmentRef['mediaType']
}> {
  if (options.sourceImages.length === 0) throw new Error('NVIDIA NIM image editing requires at least one reference image')
  if (options.sourceImages.length > NVIDIA_MAX_REFERENCES) {
    throw new Error(`NVIDIA NIM image editing supports at most ${NVIDIA_MAX_REFERENCES} reference images; this selection resolved ${options.sourceImages.length}. Select fewer images. No images were omitted.`)
  }
  return requestNvidiaImage(options, { image: options.sourceImages.map(toDataUrl) })
}

async function requestNvidiaImage(
  options: NvidiaImageOptions,
  extra: { image?: string[] },
): Promise<{ data: Uint8Array; mediaType: ImageAttachmentRef['mediaType'] }> {
  if (options.prompt.length > NVIDIA_MAX_PROMPT) {
    throw new Error(`NVIDIA NIM prompt exceeds the ${NVIDIA_MAX_PROMPT}-character limit (got ${options.prompt.length})`)
  }
  const { width, height } = parseNvidiaSize(options.size)
  const base = options.endpoint.replace(/\/+$/, '')
  // The genai contract puts the model in the URL path, not the body, and
  // ImageRequest sets additionalProperties: false, so only schema fields ride
  // the request.
  const response = await guardedFetch('NVIDIA NIM image request', options.signal, () => fetch(`${base}/genai/${options.model}`, {
    method: 'POST',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      prompt: options.prompt,
      width,
      height,
      ...(options.cfgScale === undefined ? {} : { cfg_scale: options.cfgScale }),
      ...(options.steps === undefined ? {} : { steps: options.steps }),
      ...extra,
    }),
  }), options.apiKey)

  if (!response.ok) {
    const errorText = redactSecrets(await readResponseBody(response, () => response.text()), options.apiKey)
    throw new Error(`NVIDIA NIM image request failed (${String(response.status)}): ${errorText}`)
  }

  const payload = JSON.parse(await readResponseBody(response, () => response.text())) as NvidiaResponse
  const artifact = payload.artifacts?.[0]
  if (artifact === undefined || typeof artifact.base64 !== 'string' || artifact.base64.length === 0) {
    throw new Error(`NVIDIA NIM image request returned no image artifact: ${redactSecrets(payload.message ?? payload.title ?? JSON.stringify(payload), options.apiKey)}`)
  }
  if (artifact.finishReason !== undefined && artifact.finishReason !== 'SUCCESS') {
    throw new Error(artifact.finishReason === 'CONTENT_FILTERED'
      ? 'NVIDIA NIM refused the request: the prompt or a reference image hit the content filter (CONTENT_FILTERED)'
      : `NVIDIA NIM image request failed with finishReason ${artifact.finishReason}`)
  }
  const data = new Uint8Array(Buffer.from(artifact.base64, 'base64'))
  if (data.byteLength > options.maxBytes) {
    throw new Error(`NVIDIA NIM generated image (${String(data.byteLength)} bytes) exceeds the ${String(options.maxBytes)} byte limit`)
  }
  const mediaType = detectImageMediaType(data)
  if (mediaType === undefined) {
    throw new Error('NVIDIA NIM image response returned an unsupported image format')
  }
  return { data, mediaType }
}

/** Validate against the ImageRequest schema: 512-1568, multiple of 16, area <= 1,062,400. */
function parseNvidiaSize(size: string | undefined): { width: number; height: number } {
  const fallback = { width: 1024, height: 1024 }
  if (size === undefined || size.trim().length === 0) return fallback
  const match = /^(\d+)\s*[xX]\s*(\d+)$/.exec(size.trim())
  if (match === null) {
    throw new Error(`NVIDIA NIM size must be WIDTHxHEIGHT in pixels (e.g. 1024x1024); got ${JSON.stringify(size)}`)
  }
  const width = Number(match[1])
  const height = Number(match[2])
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < NVIDIA_MIN_EDGE || value > NVIDIA_MAX_EDGE || value % 16 !== 0) {
      throw new Error(`NVIDIA NIM ${name} ${String(value)} is outside ${NVIDIA_MIN_EDGE}-${NVIDIA_MAX_EDGE} or not a multiple of 16`)
    }
  }
  if (width * height > NVIDIA_MAX_PIXELS) {
    throw new Error(`NVIDIA NIM size ${width}x${height} (${String(width * height)} px) exceeds the ${String(NVIDIA_MAX_PIXELS)}-pixel limit`)
  }
  return { width, height }
}

function toDataUrl(image: { data: Uint8Array; mediaType: ImageMediaType }): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}
