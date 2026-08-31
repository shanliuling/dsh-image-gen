/** Pure ComfyUI API-workflow validation and placeholder injection. */
import { MAX_COMFYUI_WORKFLOW_BYTES } from './shared.js'

export const COMFYUI_PROMPT_PLACEHOLDER = '{{prompt}}'
export const COMFYUI_SEED_PLACEHOLDER = '{{seed}}'
export const COMFYUI_IMAGE_PLACEHOLDER = '{{image}}'

/** Legacy single-percent placeholders from early releases, still accepted. */
const LEGACY_PROMPT_PLACEHOLDER = '%prompt%'
const LEGACY_SEED_PLACEHOLDER = '%seed%'
const LEGACY_IMAGE_PLACEHOLDER = '%image%'

/** LoadImage-style input key that receives the uploaded source image name. */
const IMAGE_INPUT_KEY = 'image'

type JsonRecord = Record<string, unknown>

/** Validate imported JSON without exposing workflow graph details to callers. */
export function validateComfyUIWorkflowJson(workflowJson: string): void {
  const workflow = parseWorkflow(workflowJson)
  const imageInputs = countImagePlaceholders(workflow)
  if (imageInputs > 1) {
    throw new Error(`ComfyUI workflow must contain at most one ${COMFYUI_IMAGE_PLACEHOLDER} image input; found ${String(imageInputs)}`)
  }
}

/**
 * Parse, clone, and inject one prompt plus an optional randomized seed.
 *
 * Prompt and seed placeholders are replaced inside any string so existing
 * workflows that embed them in longer text keep working. The image
 * placeholder is stricter: it only matches a dedicated `inputs.image` field
 * whose value is exactly the placeholder, and at most one may exist, because
 * the field must carry a single uploaded file name.
 */
export function prepareComfyUIWorkflow(workflowJson: string, prompt: string, seed = randomSeed(), image?: string): JsonRecord {
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
      if (replaced.includes(COMFYUI_SEED_PLACEHOLDER) || replaced.includes(LEGACY_SEED_PLACEHOLDER)) {
        replaced = replaced
          .replaceAll(COMFYUI_SEED_PLACEHOLDER, String(seed))
          .replaceAll(LEGACY_SEED_PLACEHOLDER, String(seed))
      }
      return replaced
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
      imageInputs += 1
      if (image !== undefined) nextInputs[IMAGE_INPUT_KEY] = image
    }
    return [nodeId, { ...node, inputs: nextInputs }]
  }))
  if (promptReplacements === 0) {
    throw new Error(`ComfyUI workflow must contain ${COMFYUI_PROMPT_PLACEHOLDER} in a text input`)
  }
  if (image === undefined) {
    if (imageInputs > 0) {
      throw new Error(`ComfyUI workflow contains an ${COMFYUI_IMAGE_PLACEHOLDER} image input, which requires edit_image with a source image`)
    }
    return prepared
  }
  if (imageInputs === 0) {
    throw new Error(`ComfyUI workflow must contain exactly one ${COMFYUI_IMAGE_PLACEHOLDER} image input to edit images`)
  }
  if (imageInputs > 1) {
    throw new Error(`ComfyUI workflow must contain exactly one ${COMFYUI_IMAGE_PLACEHOLDER} image input; found ${String(imageInputs)}`)
  }
  return prepared
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
