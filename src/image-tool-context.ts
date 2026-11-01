/** Live, credential-free instructions for the conversation model's image tools. */
import { resolveComfyUIWorkflows, resolveProvider, withProviderOverrides, type Config } from './config.js'

export function imageToolContext(config: Config, configuredProviders?: readonly string[]): string {
  const provider = config.provider ?? 'google'
  const configured = configuredProviders === undefined ? undefined : [...configuredProviders]
  if (configured !== undefined && !configured.includes('comfyui') && resolveComfyUIWorkflows(config).length > 0) configured.push('comfyui')
  let model = 'not configured'
  let editModel = model
  try {
    const active = resolveProvider(config)
    model = active.provider === 'comfyui' ? active.workflow?.name ?? 'workflow selected in settings' : active.model
    const edit = resolveProvider(withProviderOverrides(config, undefined, undefined, 'edit'))
    editModel = edit.provider === 'comfyui' ? edit.workflow?.name ?? model : edit.model
  } catch { /* Incomplete settings must not break the host system prompt. */ }
  return [
    `Image tools current default provider: ${provider}; generation model: ${JSON.stringify(model)}; editing model: ${JSON.stringify(editModel)}.`,
    ...(configured === undefined ? [] : [`Configured image providers (credential saved, subscription logged in, or ComfyUI workflow present): ${configured.length > 0 ? configured.join(', ') : 'none'}. Do not select unlisted providers; configuration presence does not guarantee service reachability.`]),
    'Unless the user explicitly requests a different image provider or model, OMIT provider and model from generate_image, generate_images and edit_image. Do not guess a channel or switch channels after an error.',
    'Omit unused optional arguments entirely; never fill them with empty strings. size and aspect_ratio are alternatives: provide at most one.',
    'Subscription parameters: chatgpt-sub accepts size OR aspect_ratio, but NOT image_size. grok-sub image_size: 1K or 2K. google-sub image_size: 1K or 4K. Do not copy parameters from another provider.',
    'Minimal calls: generate_image({"prompt":"a sailboat"}); edit_image({"prompt":"make the sail blue"}). A valid ChatGPT subscription ratio example is {"prompt":"a sailboat","aspect_ratio":"1:1"} with image_size and size omitted.',
  ].join('\n')
}
