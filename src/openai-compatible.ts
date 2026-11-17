/** OpenAI Images API and compatible response adapter. */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { downloadPublicImage } from './public-image-download.js'
import { guardedFetch, readResponseBody } from './fetch-diagnostics.js'
import { redactSecrets } from './redact.js'
import { detectImageMediaType } from './reference-image.js'
import { arkOutputBody, type ArkOutputOptions } from './shared.js'

const ERROR_LIMIT = 4096

/**
 * What an images request can return: the raster types the attachment layer
 * stores, plus the SVG document `output_format: 'svg'` produces.
 */
export type GeneratedMediaType = ImageMediaType | 'image/svg+xml'

export interface GeneratedCompatibleImage {
  data: Uint8Array
  mediaType: GeneratedMediaType
}

/**
 * The workbench stores results through the raster attachment API only, so a
 * studio call never asks for SVG; guard the widened result type anyway.
 */
export function rasterOnly<T extends { data: Uint8Array; mediaType: GeneratedMediaType }>(image: T): { data: Uint8Array; mediaType: ImageMediaType } {
  if (image.mediaType === 'image/svg+xml') throw new Error('SVG 输出仅在对话工具中支持；工作台请使用位图格式')
  return { data: image.data, mediaType: image.mediaType }
}

/**
 * True when the bytes are an SVG document rather than a raster image. The
 * relay returns SVG as `b64_json` of the markup (or a URL to a .svg file), so
 * the payload is UTF-8 text whose root element, after any XML declaration,
 * processing instructions, comments, and DOCTYPE, is `<svg>`; every raster
 * format starts with a binary magic number instead. An HTML page that merely
 * contains an inline `<svg>` is not an SVG document. Only the first 64 KB are
 * decoded.
 */
export function isSvgDocument(data: Uint8Array): boolean {
  const decoder = new TextDecoder()
  if (!decoder.decode(data.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart().startsWith('<')) return false
  // The root element sits right after a short preamble, so 64 KB is ample.
  const text = decoder.decode(data.subarray(0, 64 * 1024)).replace(/^\uFEFF/, '')
  return /^\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)\s*)*<svg[\s/>]/.test(text)
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
  strictImageDownloads?: boolean
  maxBytes: number
  signal: AbortSignal
  /** Ark-only output controls; ignored by every other provider. */
  arkOptions?: ArkOutputOptions
  /**
   * ModelScope-style async task mode (#140): the generations endpoint answers
   * `{"task_id": ...}` and the image URLs only appear after polling
   * `/v1/tasks/{task_id}`. Opt-in per channel through the `modelscopeAsync`
   * edit format, so every other relay keeps today's request shape untouched.
   */
  asyncImages?: boolean
}): Promise<GeneratedCompatibleImage> {
  if (input.asyncImages === true) {
    return runModelScopeAsyncTask({
      ...input,
      acceptSvg: input.extraBody?.output_format === 'svg',
      // ModelScope's contract has no `quality` field; extraBody rides last so
      // users can still add `negative_prompt`/`seed`/`steps` per channel.
      body: {
        model: input.model,
        prompt: input.prompt,
        ...(input.size === undefined ? {} : { size: input.size }),
        ...(input.extraBody ?? {}),
      },
    })
  }
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
  return parseImageResponse(response, input.provider, { ...input, acceptSvg: input.extraBody?.output_format === 'svg' })
}

/**
 * How the edits endpoint expects its request body (#41). `modelscopeAsync`
 * additionally switches generation itself to ModelScope's async task flow
 * (#140): submit → poll `/v1/tasks/{id}` → download `output_images`.
 */
export type CompatEditFormat = 'multipart' | 'jsonImageUrlArray' | 'formReferenceImages' | 'siliconflowJson' | 'xaiJson' | 'qwenJson' | 'modelscopeAsync'

export async function editOpenAICompatibleImage(input: {
  apiKey: string
  baseURL: string
  model: string
  prompt: string
  sourceImages: CompatibleReferenceImage[]
  size?: string
  strictImageDownloads?: boolean
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
   * Multipart edit response shape. `auto` asks for inline b64_json first and
   * retries once without the field when a relay rejects it (400/422); `url`
   * keeps the relay default; `b64_json` never retries.
   */
  editResponseFormat?: 'auto' | 'b64_json' | 'url'
  /** Called once when the relay rejects response_format and the request is retried without it. */
  onResponseFormatRetry?: (status: number) => void
  /**
   * Extra fields for the edit request (multipart: one form field per entry;
   * JSON shapes: merged after `editExtra`), e.g. xAI's
   * aspect_ratio/resolution pair.
   */
  extraBody?: Readonly<Record<string, unknown>>
}): Promise<GeneratedCompatibleImage> {
  if (input.editFormat === 'modelscopeAsync') {
    // ModelScope edits through the same async generations endpoint (#140):
    // references ride the JSON body as `image_url`, never multipart /edits.
    // ModelScope derives output framing itself; the generic picker defaults
    // must not turn into unsupported size/quality fields (same rule as the
    // SiliconFlow contract below).
    if (['size', 'image_size', 'quality'].some(key => key in (input.editExtra ?? {}))) throw new Error('魔搭 ModelScope 图生图格式不发送 size、image_size 或 quality；请从图生图额外字段中移除这些字段')
    return runModelScopeAsyncTask({
      ...input,
      acceptSvg: false,
      body: {
        model: input.model,
        prompt: input.prompt,
        image_url: input.sourceImages.map(toDataUrl),
        ...(input.editExtra ?? {}),
        ...(input.extraBody ?? {}),
      },
    })
  }
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
  const responseFormat = input.editResponseFormat ?? 'url'
  // An explicit response_format in extraBody is the channel's own choice; do
  // not append a second value or retry around it.
  const explicitResponseFormat = Object.prototype.hasOwnProperty.call(input.extraBody ?? {}, 'response_format')
  const buildEditForm = (includeResponseFormat: boolean): FormData => {
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
    if (includeResponseFormat && !explicitResponseFormat) form.append('response_format', 'b64_json')
    for (const [key, value] of Object.entries(input.extraBody ?? {})) {
      if (value === undefined) continue
      form.append(key, String(value))
    }
    return form
  }
  const sendEdit = (form: FormData): Promise<Response> => guardedFetch('openai image edit request', input.signal, () => fetch(imageEndpoint(input.baseURL, 'edits'), {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
  }), input.apiKey)

  let response = await sendEdit(buildEditForm(responseFormat !== 'url'))
  // Retry only an error about response_format. Invalid dimensions and other
  // 400/422 errors need to reach the user without a duplicate edit request.
  if (responseFormat === 'auto' && !explicitResponseFormat && (response.status === 400 || response.status === 422)) {
    const text = await readBoundedText(response, ERROR_LIMIT)
    if (!rejectsResponseFormat(text)) throw new Error(`openai image request failed (${response.status}): ${redactSecrets(text, input.apiKey).slice(0, ERROR_LIMIT)}`)
    input.onResponseFormatRetry?.(response.status)
    response = await sendEdit(buildEditForm(false))
  }
  return parseImageResponse(response, 'openai', input)
}

function rejectsResponseFormat(text: string): boolean {
  let message = text
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown } | string
    if (typeof body === 'string') message = body
    else if (body !== null && typeof body === 'object') {
      const error = typeof body.error === 'object' && body.error !== null ? body.error as { param?: unknown; message?: unknown; code?: unknown } : undefined
      if (typeof error?.param === 'string') return error.param === 'response_format'
      if (Array.isArray(body.detail)) {
        // FastAPI lists validation errors by parameter path. Do not retry if
        // any other parameter is invalid as well.
        return body.detail.length > 0 && body.detail.every((entry: unknown) => {
          const loc = entry !== null && typeof entry === 'object' ? (entry as { loc?: unknown }).loc : undefined
          return Array.isArray(loc) && loc.includes('response_format')
        })
      }
      message = [typeof body.error === 'string' ? body.error : undefined, error?.message, error?.code, body.message, body.detail].filter(value => typeof value === 'string').join(' ')
    }
  } catch { /* Some relays return plain-text validation errors. */ }
  return /(?:response[_ -]?format|b64_json)/i.test(message) && /(?:unsupported|not\s+(?:support|allowed|permitted|accepted|implemented)|unknown|unrecognized|unexpected|invalid|extra\s+(?:field|input)|不支持|不允许|未知|无效|未识别)/i.test(message)
}

interface ImageResponseOptions {
  baseURL: string
  maxBytes: number
  signal: AbortSignal
  apiKey?: string
  strictImageDownloads?: boolean
  acceptSvg?: boolean
}

/**
 * ModelScope API-Inference async task flow (#140): the OpenAI-shaped
 * generations endpoint only accepts async submissions — it answers
 * `{"task_id": ...}` with no image fields, the result surfaces at
 * `GET /v1/tasks/{task_id}` (which requires the `X-ModelScope-Task-Type`
 * header) as `output_images`. See the official contract at
 * <https://modelscope.ai/docs/model-service/API-Inference/intro>.
 */
interface ModelScopeAsyncInput extends ImageResponseOptions {
  apiKey: string
  model: string
  signal: AbortSignal
  /** Complete JSON request body for the async submission. */
  body: Record<string, unknown>
  /** Milliseconds between task-status polls; test hook. */
  pollIntervalMs?: number
  /** Total wall-clock budget for the whole task; test hook. */
  pollBudgetMs?: number
}

// The official example sleeps 5 s between polls; API-Inference is a free,
// dynamically rate-limited service, so stay on that cadence. Batch and studio
// requests run one loop per image concurrently, which multiplies the rate.
const MODELSCOPE_POLL_INTERVAL_MS = 5000
const MODELSCOPE_POLL_BUDGET_MS = 300_000
const MODELSCOPE_ASYNC_HEADER = 'X-ModelScope-Async-Mode'
const MODELSCOPE_TASK_TYPE_HEADER = 'X-ModelScope-Task-Type'

interface ModelScopeTaskResponse {
  task_id?: unknown
  task_status?: unknown
  message?: unknown
  output_images?: unknown
}

async function runModelScopeAsyncTask(input: ModelScopeAsyncInput): Promise<GeneratedCompatibleImage> {
  const pollIntervalMs = input.pollIntervalMs ?? MODELSCOPE_POLL_INTERVAL_MS
  const pollBudgetMs = input.pollBudgetMs ?? MODELSCOPE_POLL_BUDGET_MS
  const deadline = Date.now() + pollBudgetMs
  // Submit the async task. ModelScope answers `{"task_id": ...}`; a non-2xx
  // or a body without `task_id` (e.g. an endpoint that never heard of async
  // mode) must fail before any polling starts.
  const submitEndpoint = imageEndpoint(input.baseURL, 'generations')
  const submitResponse = await guardedFetch('modelscope image task submission', input.signal, () => fetch(submitEndpoint, {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
      [MODELSCOPE_ASYNC_HEADER]: 'true',
    },
    body: JSON.stringify(input.body),
  }), input.apiKey)
  const submitText = await readBoundedText(submitResponse, ERROR_LIMIT)
  if (!submitResponse.ok) throw new Error(`modelscope image task submission failed (${String(submitResponse.status)}): ${redactSecrets(submitText, input.apiKey).slice(0, ERROR_LIMIT)}`)
  let submitted: ModelScopeTaskResponse
  try { submitted = JSON.parse(submitText) as ModelScopeTaskResponse } catch { throw new Error('modelscope image task submission returned invalid JSON') }
  const taskId = typeof submitted.task_id === 'string' ? submitted.task_id : undefined
  if (taskId === undefined || taskId.length === 0) throw new Error(`modelscope image task submission returned no task_id: ${redactSecrets(submitText, input.apiKey).slice(0, ERROR_LIMIT)}`)

  const taskEndpoint = taskStatusEndpoint(input.baseURL, taskId)
  let lastStatus = ''
  let lastBody = submitText
  for (;;) {
    // Budget first: a poll that would start after the deadline never fires,
    // so the loop cannot outlive the caller's generation timeout unnoticed.
    // The last status response rides along for diagnosis.
    if (Date.now() >= deadline) {
      throw new Error(`modelscope image task ${taskId} did not finish within ${String(Math.round(pollBudgetMs / 1000))} seconds (last status: ${describeModelScopeStatus(lastStatus)}: ${redactSecrets(lastBody, input.apiKey).slice(0, 512)}); 请调大「云端超时」后重试`)
    }
    const pollResponse = await guardedFetch('modelscope image task poll', input.signal, () => fetch(taskEndpoint, {
      method: 'GET', redirect: 'error', signal: input.signal,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        [MODELSCOPE_TASK_TYPE_HEADER]: 'image_generation',
      },
    }), input.apiKey)
    const pollText = await readBoundedText(pollResponse, ERROR_LIMIT)
    // A failed poll is a transport/config problem, not a task state; unlike
    // PENDING/RUNNING it gives no reason to wait longer.
    if (!pollResponse.ok) throw new Error(`modelscope image task poll failed (${String(pollResponse.status)}): ${redactSecrets(pollText, input.apiKey).slice(0, ERROR_LIMIT)}`)
    let payload: ModelScopeTaskResponse
    try { payload = JSON.parse(pollText) as ModelScopeTaskResponse } catch { throw new Error('modelscope image task poll returned invalid JSON') }
    lastStatus = typeof payload.task_status === 'string' ? payload.task_status : lastStatus
    lastBody = pollText
    if (lastStatus === 'FAILED') {
      const failureDetail = typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : pollText
      throw new Error(`modelscope image task ${taskId} failed: ${redactSecrets(failureDetail, input.apiKey).slice(0, ERROR_LIMIT)}`)
    }
    if (lastStatus === 'SUCCEED') {
      const imageUrl = firstModelScopeOutputImage(payload.output_images)
      if (imageUrl === undefined) throw new Error(`modelscope image task ${taskId} succeeded but returned no output_images: ${redactSecrets(pollText, input.apiKey).slice(0, ERROR_LIMIT)}`)
      // Reuse the shared downloader: data: URLs, relative URLs, strict mode,
      // byte caps and SVG sniffing all behave exactly like the sync paths.
      return downloadImage(imageUrl, 'modelscope', { ...input, acceptSvg: input.acceptSvg === true })
    }
    await modelScopeDelay(pollIntervalMs, input.signal)
  }
}

/** First usable entry of the task's `output_images` array, or undefined. */
function firstModelScopeOutputImage(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) return entry
  }
  return undefined
}

function describeModelScopeStatus(status: string): string {
  return status.length > 0 ? status : 'unknown'
}

function taskStatusEndpoint(baseURL: string, taskId: string): string {
  try { return new URL(`tasks/${encodeURIComponent(taskId)}`, baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString() } catch { throw new Error('Image endpoint must be an absolute URL') }
}

/** Abort-aware sleep for the task polling loop; mirrors comfyui.ts's delay. */
async function modelScopeDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    function done(): void { signal.removeEventListener('abort', abort); resolve() }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function parseImageResponse(
  response: Response,
  provider: string,
  input: ImageResponseOptions,
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
    if (isSvgDocument(data)) return { data, mediaType: 'image/svg+xml' }
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

async function downloadImage(
  url: string | undefined,
  provider: string,
  input: ImageResponseOptions,
): Promise<GeneratedCompatibleImage> {
  if (url === undefined) throw new Error(`${provider} image request returned no image data`)
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) throw new Error(`${provider} image request returned invalid data URL`)
    const data = decodeBase64(parsed.base64, provider)
    if (isSvgDocument(data)) return { data, mediaType: 'image/svg+xml' }
    return { data, mediaType: detectImageMediaType(data) ?? imageMediaType(parsed.mediaType) ?? 'image/png' }
  }
  // Relative URLs are legal for self-hosted gateways (SGLang returns
  // "/v1/images/<id>/content"): resolve them against the configured base URL,
  // then fall back to the origin path for relays whose real route drops /v1.
  const candidates = imageDownloadCandidates(url, input.baseURL, provider)
  let response: Response | undefined
  let failure: unknown
  for (const candidate of candidates) {
    try {
      response = await requestImageCandidate(candidate, provider, input)
      if (response.ok) break
      failure = new Error(`${provider} image download failed (${response.status})`)
      await response.body?.cancel().catch(() => undefined)
      response = undefined
    } catch (err) {
      failure = err
    }
  }
  if (response === undefined) throw failure instanceof Error ? failure : new Error(`${provider} image download failed`)
  const data = await readBoundedBytes(response, input.maxBytes)
  // SVG arrives as text from the relay's object store, so the declared
  // content type is the only hint besides the markup itself.
  const mediaType = isSvgDocument(data) ? 'image/svg+xml' : detectImageMediaType(data) ?? imageMediaType(response.headers.get('content-type'))
  if (mediaType === undefined) throw new Error(`${provider} image download returned unsupported content type`)
  return { data, mediaType }
}

function imageDownloadCandidates(url: string, baseURL: string, provider: string): string[] {
  const candidates: string[] = []
  try {
    candidates.push(new URL(url, baseURL.endsWith('/') ? baseURL : baseURL + '/').toString())
  } catch {
    // A malformed baseURL still leaves the origin fallback below for "/path".
  }
  if (url.startsWith('/')) {
    try {
      const stripped = new URL(baseURL).origin + url.replace(/^\/v1(?=\/)/, '')
      if (!candidates.includes(stripped)) candidates.push(stripped)
    } catch {
      // No origin fallback without a parseable baseURL.
    }
  }
  if (candidates.length === 0) throw new Error(provider + ' image download URL is not absolute')
  return candidates
}

async function requestImageCandidate(
  candidate: string,
  provider: string,
  input: ImageResponseOptions,
): Promise<Response> {
  const sameOrigin = new URL(candidate).origin === new URL(input.baseURL).origin
  if (input.strictImageDownloads === true) {
    const options = { maxBytes: input.maxBytes, signal: input.signal, acceptSvg: input.acceptSvg === true }
    let result
    try {
      result = await downloadPublicImage(candidate, {
        ...options,
        ...(sameOrigin && input.apiKey !== undefined ? { authorization: 'Bearer ' + input.apiKey } : {}),
      })
    } catch (error) {
      if (!sameOrigin || input.apiKey === undefined) throw error
      result = await downloadPublicImage(candidate, options)
    }
    return new Response(result.data as BodyInit, { headers: result.contentType === undefined ? {} : { 'content-type': result.contentType } })
  }
  let response = await guardedFetch(provider + ' image download', input.signal, () => fetch(candidate, {
    redirect: 'follow', signal: input.signal,
    ...(input.apiKey === undefined || !sameOrigin ? {} : { headers: { authorization: 'Bearer ' + input.apiKey } }),
  }), input.apiKey)
  // Some same-origin relays reject Authorization on public image URLs, so the
  // legacy retry remains available without ever sending the key to another origin.
  if (!response.ok && input.apiKey !== undefined && sameOrigin) {
    await response.body?.cancel().catch(() => undefined)
    response = await guardedFetch(provider + ' image download', input.signal, () => fetch(candidate, { redirect: 'follow', signal: input.signal }), input.apiKey)
  }
  return response
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
  try { for (;;) { const next = await readResponseBody(response, () => reader.read()); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxBytes) throw new Error(`Image response exceeded the ${String(maxBytes)} byte limit`); chunks.push(next.value) } } catch (error) { await reader.cancel().catch(() => undefined); throw error } finally { reader.releaseLock() }
  const joined = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}
