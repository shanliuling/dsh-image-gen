/** Pure ComfyUI API-workflow validation and placeholder injection. */
import { MAX_COMFYUI_WORKFLOW_BYTES } from './shared.js'

export const COMFYUI_PROMPT_PLACEHOLDER = '{{prompt}}'
export const COMFYUI_SEED_PLACEHOLDER = '{{seed}}'
export const COMFYUI_IMAGE_PLACEHOLDER = '{{image}}'
export const COMFYUI_WIDTH_PLACEHOLDER = '{{width}}'
export const COMFYUI_HEIGHT_PLACEHOLDER = '{{height}}'

/** Frame size used for {{width}} / {{height}} when a call names no size. */
export const COMFYUI_DEFAULT_SIZE = { width: 1024, height: 1024 } as const

/**
 * Pixel sizes for an aspect ratio, about one megapixel in multiples of 64:
 * the buckets SDXL / Flux style models are trained on.
 */
const COMFYUI_RATIO_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1152, height: 896 },
  '3:4': { width: 896, height: 1152 },
  '3:2': { width: 1216, height: 832 },
  '2:3': { width: 832, height: 1216 },
  '5:4': { width: 1088, height: 896 },
  '4:5': { width: 896, height: 1088 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '21:9': { width: 1536, height: 640 },
}

export interface ComfyUISize { width: number; height: number }

/**
 * The frame size a call asks for: an exact `WIDTHxHEIGHT`, or an aspect ratio
 * mapped to its bucket. Undefined when the call names neither.
 */
export function comfyUIRequestedSize(size: string | undefined, aspectRatio: string | undefined): ComfyUISize | undefined {
  if (size !== undefined) {
    const match = /^(\d+)\s*[x*×]\s*(\d+)$/i.exec(size.trim())
    const width = Number(match?.[1])
    const height = Number(match?.[2])
    if (match === null || !(width >= 64 && width <= 8192 && height >= 64 && height <= 8192)) {
      throw new Error(`ComfyUI size "${size}" must be WIDTHxHEIGHT with each edge between 64 and 8192`)
    }
    return { width, height }
  }
  if (aspectRatio !== undefined) {
    const bucket = COMFYUI_RATIO_SIZES[aspectRatio.trim()]
    if (bucket === undefined) throw new Error(`ComfyUI aspect_ratio "${aspectRatio}" is not supported; use one of ${Object.keys(COMFYUI_RATIO_SIZES).join(', ')} or an exact size`)
    return { ...bucket }
  }
  return undefined
}

/** What a workflow can take from a call: how many source images, and whether a frame size. */
export interface ComfyUIWorkflowSlots {
  images: number
  size: boolean
}

/** Inspect the placeholders of an imported workflow without preparing it. */
export function comfyUIWorkflowSlots(workflowJson: string): ComfyUIWorkflowSlots {
  const workflow = parseWorkflow(workflowJson)
  return { images: countImagePlaceholders(workflow), size: containsSizePlaceholder(workflow) }
}

/** Legacy single-percent placeholders from early releases, still accepted. */
const LEGACY_PROMPT_PLACEHOLDER = '%prompt%'
const LEGACY_SEED_PLACEHOLDER = '%seed%'
const LEGACY_IMAGE_PLACEHOLDER = '%image%'

/** LoadImage-style input key that receives the uploaded source image name. */
const IMAGE_INPUT_KEY = 'image'

type JsonRecord = Record<string, unknown>

/** Validate imported JSON without exposing workflow graph details to callers. */
export function validateComfyUIWorkflowJson(workflowJson: string): void {
  // Several {{image}} inputs are allowed (#117): they take the source images in node order.
  parseWorkflow(workflowJson)
}

/**
 * Parse, clone, and inject one prompt plus an optional randomized seed, frame
 * size and source images.
 *
 * Prompt, seed, width and height placeholders are replaced inside any string
 * so existing workflows that embed them in longer text keep working; a value
 * that is exactly the seed, width or height placeholder becomes a number. The
 * image placeholder is stricter: it only matches a dedicated `inputs.image`
 * field whose value is exactly the placeholder. Several may exist (#117); they
 * take the uploaded file names in node order, one each, and their number must
 * match the number of source images.
 */
export function prepareComfyUIWorkflow(workflowJson: string, prompt: string, seed = randomSeed(), images?: string | readonly string[], size?: ComfyUISize): JsonRecord {
  const sources = images === undefined ? [] : typeof images === 'string' ? [images] : [...images]
  const frame = size ?? COMFYUI_DEFAULT_SIZE
  const workflow = parseWorkflow(workflowJson)
  let promptReplacements = 0

  const inject = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let replaced = value
      if (replaced.includes(COMFYUI_PROMPT_PLACEHOLDER) || replaced.includes(LEGACY_PROMPT_PLACEHOLDER)) {
        promptReplacements += 1
        replaced = replaced
          .replaceAll(COMFYUI_PROMPT_PLACEHOLDER, prompt)
          .replaceAll(LEGACY_PROMPT_PLACEHOLDER, prompt)
      }
      if (replaced === COMFYUI_SEED_PLACEHOLDER || replaced === LEGACY_SEED_PLACEHOLDER) return seed
      if (replaced === COMFYUI_WIDTH_PLACEHOLDER) return frame.width
      if (replaced === COMFYUI_HEIGHT_PLACEHOLDER) return frame.height
      if (replaced.includes(COMFYUI_SEED_PLACEHOLDER) || replaced.includes(LEGACY_SEED_PLACEHOLDER)) {
        replaced = replaced
          .replaceAll(COMFYUI_SEED_PLACEHOLDER, String(seed))
          .replaceAll(LEGACY_SEED_PLACEHOLDER, String(seed))
      }
      return replaced
        .replaceAll(COMFYUI_WIDTH_PLACEHOLDER, String(frame.width))
        .replaceAll(COMFYUI_HEIGHT_PLACEHOLDER, String(frame.height))
    }
    if (Array.isArray(value)) return value.map(inject)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inject(child)]))
  }

  let imageInputs = 0
  const prepared = Object.fromEntries(Object.entries(workflow).map(([nodeId, value]) => {
    const node = record(value)
    const inputs = node === undefined ? undefined : record(node.inputs)
    if (inputs === undefined) return [nodeId, value]
    const nextInputs = inject(inputs) as JsonRecord
    if (isImagePlaceholder(nextInputs[IMAGE_INPUT_KEY])) {
      const source = sources[imageInputs]
      imageInputs += 1
      if (source !== undefined) nextInputs[IMAGE_INPUT_KEY] = source
    }
    return [nodeId, { ...node, inputs: nextInputs }]
  }))
  if (promptReplacements === 0) {
    throw new Error(`ComfyUI workflow must contain ${COMFYUI_PROMPT_PLACEHOLDER} in a text input`)
  }
  assertImageCount(imageInputs, sources.length)
  return prepared
}

/** The source images a call brings must fill the workflow's {{image}} inputs one to one. */
export function assertImageCount(imageInputs: number, sourceImages: number): void {
  if (sourceImages === 0) {
    if (imageInputs > 0) {
      throw new Error(`ComfyUI workflow contains ${String(imageInputs)} ${COMFYUI_IMAGE_PLACEHOLDER} image input(s), which require edit_image with that many source images`)
    }
    return
  }
  if (imageInputs === 0) {
    throw new Error(`ComfyUI workflow must contain a ${COMFYUI_IMAGE_PLACEHOLDER} image input to edit images`)
  }
  if (imageInputs !== sourceImages) {
    throw new Error(`ComfyUI workflow has ${String(imageInputs)} ${COMFYUI_IMAGE_PLACEHOLDER} image input(s) but this call has ${String(sourceImages)} source image(s); pass exactly ${String(imageInputs)} (they fill the inputs in node order)`)
  }
}

/** Random seed in the 32-bit range ComfyUI samplers accept. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000)
}

function parseWorkflow(workflowJson: string): JsonRecord {
  if (workflowJson.trim().length === 0) throw new Error('Import a ComfyUI API workflow JSON file in Settings before generating')
  if (new TextEncoder().encode(workflowJson).byteLength > MAX_COMFYUI_WORKFLOW_BYTES) {
    throw new Error('ComfyUI workflow file must be no larger than 5 MB')
  }
  let value: unknown
  try {
    value = JSON.parse(workflowJson)
  } catch {
    throw new Error('ComfyUI workflow file is not valid JSON')
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error('ComfyUI workflow must be a non-empty API-format JSON object')
  }
  if (!Object.values(value).some(node => {
    const inputs = record(node)?.inputs
    return inputs !== undefined && containsPromptPlaceholder(inputs)
  })) {
    throw new Error(`ComfyUI workflow must contain ${COMFYUI_PROMPT_PLACEHOLDER} (or ${LEGACY_PROMPT_PLACEHOLDER}) in a text input`)
  }
  return value
}

/** Count `inputs.image` fields that are exactly an image placeholder. */
function countImagePlaceholders(workflow: JsonRecord): number {
  let count = 0
  for (const node of Object.values(workflow)) {
    const inputs = record(record(node)?.inputs)
    if (inputs !== undefined && isImagePlaceholder(inputs[IMAGE_INPUT_KEY])) count += 1
  }
  return count
}

function containsSizePlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(COMFYUI_WIDTH_PLACEHOLDER) || value.includes(COMFYUI_HEIGHT_PLACEHOLDER)
  if (Array.isArray(value)) return value.some(containsSizePlaceholder)
  return isRecord(value) && Object.values(value).some(containsSizePlaceholder)
}

function isImagePlaceholder(value: unknown): boolean {
  return value === COMFYUI_IMAGE_PLACEHOLDER || value === LEGACY_IMAGE_PLACEHOLDER
}

function containsPromptPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(COMFYUI_PROMPT_PLACEHOLDER) || value.includes(LEGACY_PROMPT_PLACEHOLDER)
  }
  if (Array.isArray(value)) return value.some(containsPromptPlaceholder)
  return isRecord(value) && Object.values(value).some(containsPromptPlaceholder)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}
