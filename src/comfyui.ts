/** ComfyUI text-to-image and image-to-image adapters using an imported API-format workflow. */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { prepareComfyUIWorkflow, randomSeed } from './comfyui-workflow.js'

const ERROR_LIMIT = 4096
const POLL_INTERVAL_MS = 500
const MAX_HISTORY_BYTES = 16 * 1024 * 1024

export interface GeneratedComfyUIImage {
  data: Uint8Array
  mediaType: ImageMediaType
  /** Concrete seed injected into the workflow, surfaced for provenance metadata. */
  seed: number
}

/** Source image bytes a ComfyUI workflow accepts through its image input. */
export interface ComfyUISourceImage {
  data: Uint8Array
  mediaType: ImageMediaType
}

interface ComfyUIJobInput {
  baseURL: string
  timeoutMs: number
  signal: AbortSignal
}

/** Run one ComfyUI text-to-image workflow and return its first final image. */
export async function generateComfyUIImage(input: ComfyUIJobInput & {
  workflowJson: string
  prompt: string
  maxBytes: number
}): Promise<GeneratedComfyUIImage> {
  const seed = randomSeed()
  const workflow = prepareComfyUIWorkflow(input.workflowJson, input.prompt, seed)
  const output = await runJob(input, async (baseURL, signal) => {
    const promptId = await submitWorkflow(baseURL, workflow, signal)
    const result = await waitForOutput(baseURL, promptId, signal)
    return await downloadOutput(baseURL, result, input.maxBytes, signal)
  })
  return { ...output, seed }
}

/** Upload one source image, run the workflow, and return its first final image. */
export async function editComfyUIImage(input: ComfyUIJobInput & {
  workflowJson: string
  prompt: string
  sourceImage: ComfyUISourceImage
  maxBytes: number
}): Promise<GeneratedComfyUIImage> {
  const seed = randomSeed()
  const output = await runJob(input, async (baseURL, signal) => {
    const imageName = await uploadSourceImage(baseURL, input.sourceImage, signal)
    const workflow = prepareComfyUIWorkflow(input.workflowJson, input.prompt, seed, imageName)
    const promptId = await submitWorkflow(baseURL, workflow, signal)
    const result = await waitForOutput(baseURL, promptId, signal)
    return await downloadOutput(baseURL, result, input.maxBytes, signal)
  })
  return { ...output, seed }
}

/** Share abort forwarding, the single timeout, and error normalization. */
async function runJob<T>(input: ComfyUIJobInput, run: (baseURL: URL, signal: AbortSignal) => Promise<T>): Promise<T> {
  input.signal.throwIfAborted()
  const baseURL = comfyUIBaseURL(input.baseURL)
  const controller = new AbortController()
  const forwardAbort = (): void => { controller.abort(input.signal.reason) }
  input.signal.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(() => { controller.abort(new Error('ComfyUI generation timed out')) }, input.timeoutMs)

  try {
    return await run(baseURL, controller.signal)
  } catch (error) {
    input.signal.throwIfAborted()
    if (controller.signal.aborted) throw new Error(`ComfyUI generation timed out after ${String(input.timeoutMs)} ms`)
    if (error instanceof TypeError) throw new Error(`Could not connect to ComfyUI at ${baseURL.origin}`)
    throw error
  } finally {
    clearTimeout(timeout)
    input.signal.removeEventListener('abort', forwardAbort)
  }
}

/** Upload the source image and return the LoadImage-compatible name ComfyUI stored it under. */
async function uploadSourceImage(baseURL: URL, image: ComfyUISourceImage, signal: AbortSignal): Promise<string> {
  const filename = uploadFilename(image.mediaType)
  // Copy into a fresh ArrayBuffer-backed view so the bytes are a valid BlobPart.
  const bytes = new Uint8Array(image.data.byteLength)
  bytes.set(image.data)
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: image.mediaType }), filename)
  const response = await fetch(endpoint(baseURL, 'upload/image'), {
    method: 'POST', redirect: 'error', signal,
    headers: { accept: 'application/json' },
    body: form,
  })
  const text = await readBoundedText(response, ERROR_LIMIT)
  if (!response.ok) throw new Error(`ComfyUI image upload failed (${response.status}): ${text}`)
  const payload = parseJsonRecord(text, 'ComfyUI /upload/image returned invalid JSON')
  if (typeof payload.name !== 'string' || payload.name.length === 0) {
    throw new Error(`ComfyUI /upload/image returned no name: ${text}`)
  }
  const subfolder = typeof payload.subfolder === 'string' ? payload.subfolder : ''
  return subfolder.length > 0 ? `${subfolder}/${payload.name}` : payload.name
}

/** LoadImage-style inputs need a file name with a decodable extension. */
function uploadFilename(mediaType: ImageMediaType): string {
  const extension = mediaType === 'image/png' ? 'png'
    : mediaType === 'image/jpeg' ? 'jpg'
    : mediaType === 'image/webp' ? 'webp'
    : undefined
  if (extension === undefined) {
    throw new Error(`ComfyUI edit_image accepts PNG, JPEG, or WebP source images; got ${mediaType}`)
  }
  return `dsh-image-gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${extension}`
}

async function submitWorkflow(baseURL: URL, workflow: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const response = await fetch(endpoint(baseURL, 'prompt'), {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  })
  const text = await readBoundedText(response, ERROR_LIMIT)
  if (!response.ok) throw new Error(`ComfyUI rejected the workflow (${response.status}): ${text}`)
  const payload = parseJsonRecord(text, 'ComfyUI /prompt returned invalid JSON')
  if (typeof payload.prompt_id !== 'string' || payload.prompt_id.length === 0) {
    throw new Error(`ComfyUI /prompt returned no prompt_id: ${text}`)
  }
  return payload.prompt_id
}

async function waitForOutput(baseURL: URL, promptId: string, signal: AbortSignal): Promise<ComfyUIImageOutput> {
  for (;;) {
    signal.throwIfAborted()
    const response = await fetch(endpoint(baseURL, `history/${encodeURIComponent(promptId)}`), {
      redirect: 'error', signal, headers: { accept: 'application/json' },
    })
    const text = await readBoundedText(response, MAX_HISTORY_BYTES)
    if (!response.ok) throw new Error(`ComfyUI history request failed (${response.status}): ${text.slice(0, ERROR_LIMIT)}`)
    const history = parseJsonRecord(text, 'ComfyUI history returned invalid JSON')
    const entry = record(history[promptId])
    if (entry !== undefined) {
      const status = record(entry.status)
      if (status?.status_str === 'error') {
        throw new Error(`ComfyUI workflow failed: ${JSON.stringify(status.messages ?? status).slice(0, ERROR_LIMIT)}`)
      }
      const output = firstOutputImage(entry.outputs)
      if (output !== undefined) return output
      if (status?.completed === true) throw new Error('ComfyUI workflow completed without an output image')
    }
    await delay(POLL_INTERVAL_MS, signal)
  }
}

interface ComfyUIImageOutput {
  filename: string
  subfolder: string
  type: string
}

function firstOutputImage(value: unknown): ComfyUIImageOutput | undefined {
  const outputs = record(value)
  if (outputs === undefined) return undefined
  for (const nodeOutput of Object.values(outputs)) {
    const images = record(nodeOutput)?.images
    if (!Array.isArray(images)) continue
    for (const image of images) {
      const item = record(image)
      if (typeof item?.filename !== 'string' || item.filename.length === 0) continue
      const output = {
        filename: item.filename,
        subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
        type: typeof item.type === 'string' ? item.type : 'output',
      }
      if (output.type === 'output') return output
    }
  }
  return undefined
}

async function downloadOutput(baseURL: URL, output: ComfyUIImageOutput, maxBytes: number, signal: AbortSignal): Promise<{ data: Uint8Array; mediaType: ImageMediaType }> {
  const url = endpoint(baseURL, 'view')
  url.searchParams.set('filename', output.filename)
  url.searchParams.set('subfolder', output.subfolder)
  url.searchParams.set('type', output.type)
  const response = await fetch(url, { redirect: 'error', signal })
  if (!response.ok) throw new Error(`ComfyUI image download failed (${response.status})`)
  const mediaType = imageMediaType(response.headers.get('content-type')) ?? imageMediaTypeFromName(output.filename)
  if (mediaType === undefined) throw new Error('ComfyUI image download returned an unsupported content type')
  return { data: await readBoundedBytes(response, maxBytes), mediaType }
}

function comfyUIBaseURL(value: string): URL {
  let url: URL
  try { url = new URL(value.endsWith('/') ? value : `${value}/`) } catch { throw new Error('ComfyUI URL must be an absolute http:// or https:// URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('ComfyUI URL must use http:// or https://')
  return url
}

function endpoint(baseURL: URL, path: string): URL {
  return new URL(path, baseURL)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseJsonRecord(text: string, message: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(message) }
  const parsed = record(value)
  if (parsed === undefined) throw new Error(message)
  return parsed
}

function imageMediaType(value: string | null | undefined): ImageMediaType | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif' ? mediaType : undefined
}

function imageMediaTypeFromName(filename: string): ImageMediaType | undefined {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    function done(): void { signal.removeEventListener('abort', abort); resolve() }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes))
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new Error(`ComfyUI response exceeded the ${String(maxBytes)} byte limit`)
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}
