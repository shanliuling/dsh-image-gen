/** Multi-provider image-generation Bundle for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { Config, resolveProvider, type AspectRatio, type ImageProvider, type ImageSize } from './config.js'
import { generateGoogleImage } from './google.js'
import { IMAGE_ROUTE, imageAttachmentFromMeta, serveImage } from './image-route.js'
import { generateOpenAICompatibleImage } from './openai-compatible.js'
import { IMAGE_GENERATION_NAMESPACE } from './shared.js'
import { saveImageToWorkspace } from './workspace-save.js'

export { Config } from './config.js'
export { IMAGE_ROUTE, imageAttachmentFromMeta } from './image-route.js'

/** Cordis plugin name. */
export const name = 'dsh-image-gen'
/** Host services required by the Bundle. */
export const inject = ['tools', 'attachments', 'credentials', 'webServer']

interface GeneratedValue {
  attachment: ImageAttachmentRef
  provider: ImageProvider
  model: string
  output: string
  /** Absolute path of the workspace file copy, when the image was saved to the session workspace. */
  savedTo?: string
  /** Why the workspace file copy could not be written, when generation still succeeded. */
  saveError?: string
}

/** Register settings, the image route, and the model-callable tool. */
export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, settingsNamespace(IMAGE_GENERATION_NAMESPACE), Config, config, {
    setSource: source => { current = source }, onChange: () => {},
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: IMAGE_ROUTE,
    handler: (req, res) => serveImage(req, res, { readImage: ref => ctx.attachments.readImage(ref) }),
  }), 'dsh-image-gen: image route')

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate one image with the configured image provider. Use when the user explicitly asks to create or draw an image. Give a complete visual prompt including subject, composition, style, lighting, and any exact text that should appear. A successful image is already attached directly to the conversation; with workspace saving enabled (the default) it is also written as a file under the session workspace, and the result\'s savedTo field carries that absolute file path. Do not call read, glob, or other tools to locate or verify the image.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete description of the image to generate.' },
      aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'], description: 'Optional output aspect ratio for Google Gemini.' },
      image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Optional output resolution for Google Gemini.' },
      size: { type: 'string', description: 'Optional dimensions or size tier for OpenAI or Seedream.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          attachment: { type: 'object', required: true, additionalProperties: false, properties: {
            attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' },
          } },
          provider: { type: 'string', required: true }, model: { type: 'string', required: true }, output: { type: 'string', required: true },
          savedTo: { type: 'string' }, saveError: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const saved = typeof value.savedTo === 'string' ? ` It was also saved to the workspace as ${value.savedTo}.` : typeof value.saveError === 'string' ? ` Saving it to the workspace failed: ${value.saveError}.` : ' It has no local file path.'
        return [{ type: 'text', text: `Generated one image with ${value.provider}/${value.model} (${value.output}). It is already attached to the conversation.${saved} Respond to the user without reading or searching for the image.` }]
      },
      presentationMeta: (args, value) => ({
        kind: 'dsh-image-gen',
        attachment: value.attachment,
        provider: value.provider,
        model: value.model,
        output: value.output,
        ...(typeof value.savedTo === 'string' ? { savedTo: value.savedTo } : {}),
        prompt: (args as { prompt: string }).prompt,
      }),
    },
    async execute(args, exec): Promise<GeneratedValue> {
      const active = resolveProvider(current())
      const credential = await ctx.credentials.resolve(credentialRef(active.apiKeyEnv))
      if (credential === undefined || credential.value.length === 0) throw new Error(`generate_image requires the ${active.apiKeyEnv} credential; configure it in Settings > Plugins > Image generation.`)
      if (active.provider === 'google') {
        const aspectRatio = (args.aspect_ratio ?? active.aspectRatio) as AspectRatio
        const imageSize = (args.image_size ?? active.imageSize) as ImageSize
        const generated = await generateGoogleImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: args.prompt, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, `${aspectRatio}, ${imageSize}`, current(), exec)
      }
      const size = args.size ?? active.imageSize
      const generated = await generateOpenAICompatibleImage({ provider: active.provider, apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: args.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
      return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec)
    },
    presentResult: (_args, result) => imagePresentation(result),
  }))
}

/**
 * Persist the generated image as a durable attachment, then — when workspace
 * saving is enabled — also write it as a file under the calling agent's
 * session workspace. A workspace write failure never discards the generated
 * attachment: it is reported through `saveError` instead.
 */
async function saveGenerated(
  ctx: Context,
  generated: { data: Uint8Array; mediaType: ImageAttachmentRef['mediaType'] },
  provider: ImageProvider,
  model: string,
  output: string,
  config: Config,
  exec: { agent?: { session: { header: { cwd?: string } } }; signal: AbortSignal },
): Promise<GeneratedValue> {
  if (!ctx.attachments.imageLimits.mediaTypes.includes(generated.mediaType)) throw new Error(`This DSH deployment does not accept ${generated.mediaType} generated images`)
  const attachment = await ctx.attachments.saveImage({ data: generated.data, mediaType: generated.mediaType, name: 'generated-image' })
  const value: GeneratedValue = { attachment, provider, model, output }
  if (config.saveToWorkspace === false) return value
  const workspaceRoot = exec.agent?.session.header.cwd
  if (workspaceRoot === undefined) return value
  try {
    value.savedTo = await saveImageToWorkspace({
      workspaceRoot,
      folder: config.workspaceFolder,
      attachmentId: attachment.attachmentId,
      mediaType: generated.mediaType,
      data: generated.data,
      signal: exec.signal,
    })
  } catch (error) {
    ctx.logger.warn(`dsh-image-gen: failed to save image to workspace: ${error instanceof Error ? error.message : String(error)}`)
    value.saveError = error instanceof Error ? error.message : String(error)
  }
  return value
}

function imagePresentation(result: ToolResult) {
  const attachment = imageAttachmentFromMeta(result.meta)
  return attachment === undefined ? undefined : { card: 'generic' as const, title: 'Generated image', content: [{ type: 'image' as const, attachment }] }
}
