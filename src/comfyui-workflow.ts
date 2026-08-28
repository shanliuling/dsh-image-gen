/** Pure ComfyUI API-workflow validation and placeholder injection. */
import { MAX_COMFYUI_WORKFLOW_BYTES } from './shared.js'

export const COMFYUI_PROMPT_PLACEHOLDER = '{{prompt}}'
export const COMFYUI_SEED_PLACEHOLDER = '{{seed}}'

type JsonRecord = Record<string, unknown>

/** Validate imported JSON without exposing workflow graph details to callers. */
export function validateComfyUIWorkflowJson(workflowJson: string): void {
  parseWorkflow(workflowJson)
}

/** Parse, clone, and inject one prompt plus an optional randomized seed. */
export function prepareComfyUIWorkflow(workflowJson: string, prompt: string, seed = randomSeed()): JsonRecord {
  const workflow = parseWorkflow(workflowJson)
  let promptReplacements = 0

  const inject = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value === COMFYUI_PROMPT_PLACEHOLDER) {
        promptReplacements += 1
        return prompt
      }
      if (value === COMFYUI_SEED_PLACEHOLDER) return seed
      if (value.includes(COMFYUI_PROMPT_PLACEHOLDER)) {
        promptReplacements += 1
        return value.replaceAll(COMFYUI_PROMPT_PLACEHOLDER, prompt)
      }
      return value.includes(COMFYUI_SEED_PLACEHOLDER)
        ? value.replaceAll(COMFYUI_SEED_PLACEHOLDER, String(seed))
        : value
    }
    if (Array.isArray(value)) return value.map(inject)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inject(child)]))
  }

  const prepared = Object.fromEntries(Object.entries(workflow).map(([nodeId, value]) => {
    const node = record(value)
    const inputs = node === undefined ? undefined : record(node.inputs)
    return inputs === undefined
      ? [nodeId, value]
      : [nodeId, { ...node, inputs: inject(inputs) }]
  }))
  if (promptReplacements === 0) {
    throw new Error(`ComfyUI workflow must contain ${COMFYUI_PROMPT_PLACEHOLDER} in a text input`)
  }
  return prepared
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
    throw new Error(`ComfyUI workflow must contain ${COMFYUI_PROMPT_PLACEHOLDER} in a text input`)
  }
  return value
}

function containsPromptPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(COMFYUI_PROMPT_PLACEHOLDER)
  if (Array.isArray(value)) return value.some(containsPromptPlaceholder)
  return isRecord(value) && Object.values(value).some(containsPromptPlaceholder)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000)
}
