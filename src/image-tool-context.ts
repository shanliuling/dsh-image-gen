/** Live, credential-free instructions for the conversation model's image tools. */
import { activeComfyUIWorkflow, resolveComfyUIWorkflows, resolveLlmProvider, resolveProvider, withProviderOverrides, type Config } from './config.js'
import { comfyUIWorkflowSlots } from './comfyui-workflow.js'

/** Workflow names listed for the model; a long list is cut so the system prompt stays small. */
const MAX_LISTED_WORKFLOWS = 20

/**
 * The ComfyUI workflows the `workflow` argument accepts (#98). Names are user
 * text, so each is JSON-quoted; the list stays absent without workflows.
 */
function comfyUIWorkflowLine(config: Config): string[] {
  const workflows = resolveComfyUIWorkflows(config)
  if (workflows.length === 0) return []
  const listed = workflows.slice(0, MAX_LISTED_WORKFLOWS).map(workflow => `${JSON.stringify(workflow.name)}${slotNote(workflow.json)}`).join(', ')
  const more = workflows.length > MAX_LISTED_WORKFLOWS ? ` (+${String(workflows.length - MAX_LISTED_WORKFLOWS)} more)` : ''
  const active = activeComfyUIWorkflow(config)
  return [`ComfyUI workflows available for the workflow argument (provider=comfyui): ${listed}${more}; active: ${JSON.stringify(active?.name ?? '')}. Pass workflow only when the user asks for a specific one; the local ComfyUI server may not be running. A workflow marked [N images] runs through edit_image with exactly N source images; only one marked [size] honours size/aspect_ratio.`]
}

/** What a workflow takes from a call, so the model picks generate vs edit and the image count. */
function slotNote(json: string): string {
  let slots
  try { slots = comfyUIWorkflowSlots(json) } catch { return '' }
  const parts = [
    ...(slots.images > 0 ? [`${String(slots.images)} image${slots.images === 1 ? '' : 's'}`] : []),
    ...(slots.size ? ['size'] : []),
  ]
  return parts.length === 0 ? '' : ` [${parts.join(', ')}]`
}

export function imageToolContext(config: Config, configuredProviders?: readonly string[]): string {
  const provider = config.provider ?? 'google'
  const configured = configuredProviders === undefined ? undefined : [...configuredProviders]
  if (configured !== undefined && !configured.includes('comfyui') && resolveComfyUIWorkflows(config).length > 0) configured.push('comfyui')
  let model = 'not configured'
  let editModel = model
  const llm = resolveLlmProvider(config)
  if (llm !== undefined) {
    // The conversation catalog is async, so an unselected model reads as the
    // fallback the generation path actually uses, not as a missing setting.
    model = llm.model.length > 0 ? llm.model : 'catalog default (first advertised image model)'
    editModel = 'unsupported (the conversation transport has no edit contract)'
  } else try {
    const active = resolveProvider(config)
    model = active.provider === 'comfyui' ? active.workflow?.name ?? 'workflow selected in settings' : active.model
    const edit = resolveProvider(withProviderOverrides(config, undefined, undefined, 'edit'))
    editModel = edit.provider === 'comfyui' ? edit.workflow?.name ?? model : edit.model
  } catch { /* Incomplete settings must not break the host system prompt. */ }
  return [
    `Image tools current default provider: ${provider}; generation model: ${JSON.stringify(model)}; editing model: ${JSON.stringify(editModel)}.`,
    ...(configured === undefined ? [] : [`Configured image providers (credential saved, subscription logged in, or ComfyUI workflow present): ${configured.length > 0 ? configured.join(', ') : 'none'}. Do not select unlisted providers; configuration presence does not guarantee service reachability.`]),
    ...comfyUIWorkflowLine(config),
    'Unless the user explicitly requests a different image provider or model, OMIT provider and model from generate_image, generate_images and edit_image. Do not guess a channel or switch channels after an error.',
    'Omit unused optional arguments entirely; never fill them with empty strings. size and aspect_ratio are alternatives: provide at most one.',
    'Subscription parameters: chatgpt-sub accepts size OR aspect_ratio, but NOT image_size. grok-sub image_size: 1K or 2K. google-sub image_size: 1K or 4K. Do not copy parameters from another provider.',
    'Minimal calls: generate_image({"prompt":"a sailboat"}); edit_image({"prompt":"make the sail blue"}). A valid ChatGPT subscription ratio example is {"prompt":"a sailboat","aspect_ratio":"1:1"} with image_size and size omitted.',
  ].join('\n')
}
