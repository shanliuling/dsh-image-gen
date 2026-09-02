/** Multi-provider image-generation Bundle for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { Config, resolveProvider, selectComfyUIWorkflow, type AspectRatio, type ImageProvider, type ImageSize } from './config.js'
import { editComfyUIImage, generateComfyUIImage } from './comfyui.js'
import { editDashScopeImage, generateDashScopeImage } from './dashscope.js'
import { editGoogleImage, generateGoogleImage } from './google.js'
import { IMAGE_ROUTE, DELETE_ROUTE, imageAttachmentFromMeta, serveImage, serveDelete } from './image-route.js'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from './openai-compatible.js'
import { resolveReferenceImages } from './reference-image.js'
import { editSeedreamImage } from './seedream.js'
import { IMAGE_GENERATION_NAMESPACE, STUDIO_ROUTE, mergeComfyUIPrompt } from './shared.js'
import { generateFromStudio, describeStudio } from './studio.js'
import { serveStudio } from './studio-route.js'
import { deleteImageFromWorkspace, getDshWorkspacesFull, saveImageToWorkspace } from './workspace-save.js'

export { Config } from './config.js'
export { IMAGE_ROUTE, DELETE_ROUTE, imageAttachmentFromMeta } from './image-route.js'
export { STUDIO_ROUTE } from './shared.js'

export const name = 'dsh-image-gen'
export const inject = ['tools', 'attachments', 'credentials', 'webServer']

interface GeneratedValue {
  attachment: ImageAttachmentRef
  provider: ImageProvider
  model: string
  output: string
  savedTo?: string
  saveError?: string
  /** Concrete workflow seed, exposed by the ComfyUI provider for provenance. */
  seed?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  const knownWorkspaceRoots = new Set<string>()

  installImageSettings(ctx, config, {
    setSource: source => { current = source }, onChange: () => {},
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: IMAGE_ROUTE,
    handler: (req, res) => serveImage(req, res, { readImage: ref => ctx.attachments.readImage(ref) }),
  }), 'dsh-image-gen: image route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: DELETE_ROUTE,
    handler: (req, res) => serveDelete(req, res, {
      deleteWorkspaceImage: filePath => deleteImageFromWorkspace(filePath, knownWorkspaceRoots),
    }),
  }), 'dsh-image-gen: delete route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: STUDIO_ROUTE,
    handler: (req, res) => serveStudio(req, res, {
      describe: async () => {
        const base = await describeStudio(ctx, current())
        const workspaces = await getDshWorkspacesFull().catch(() => [])
        const activeRoot = Array.from(knownWorkspaceRoots)[0] || workspaces[0]?.path || process.cwd()
        return {
          ...base,
          workspaceRoot: activeRoot,
          workspaces,
        }
      },
      generate: (input, signal) => {
        const fallbackRoot = Array.from(knownWorkspaceRoots)[0] || process.cwd()
        return generateFromStudio(ctx, current(), input, signal, fallbackRoot)
      },
      maxBodyBytes: Math.ceil(ctx.attachments.imageLimits.maxImageBytes * 1.4 * 5) + 256 * 1024,
    }),
  }), 'dsh-image-gen: studio route')

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate a new image with the configured provider. Use when the user asks to create or draw a new image; use edit_image instead when they want to change an existing image. Give a complete visual prompt including subject, composition, style, lighting, and any exact text that should appear. A successful image is attached directly to the conversation and may also be saved under the session workspace. Do not call read, glob, or other tools to locate or verify the image.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete description of the image to generate.' },
      aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'], description: 'Optional output aspect ratio for Google Gemini.' },
      image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Optional output resolution for Google Gemini.' },
      size: { type: 'string', description: 'Optional dimensions or size tier for OpenAI, Seedream, or DashScope.' },
      workflow: { type: 'string', description: 'Optional name of the ComfyUI workflow to run; omit to use the active workflow from settings. Only meaningful when the ComfyUI provider is selected.' },
    },
    output: imageOutput('Generated'),
    async execute(args, exec): Promise<GeneratedValue> {
      const active = resolveProvider(current())
      if (active.provider === 'comfyui') {
        const workflow = selectComfyUIWorkflow(active, args.workflow)
        const generated = await generateComfyUIImage({
          baseURL: active.baseURL,
          workflowJson: workflow.json,
          prompt: mergeComfyUIPrompt(workflow.presetPrompt, args.prompt),
          timeoutMs: active.timeoutMs,
          maxBytes: ctx.attachments.imageLimits.maxImageBytes,
          signal: exec.signal,
        })
        return saveGenerated(ctx, generated, active.provider, workflow.name, 'API workflow', current(), exec, knownWorkspaceRoots)
      }
      const credential = await ctx.credentials.resolve(credentialRef(active.apiKeyEnv))
      if (credential === undefined || credential.value.length === 0) throw new Error(`generate_image requires the ${active.apiKeyEnv} credential; configure it in Settings > Plugins > Image generation.`)
      if (active.provider === 'google') {
        const aspectRatio = (args.aspect_ratio ?? active.aspectRatio) as AspectRatio
        const imageSize = (args.image_size ?? active.imageSize) as ImageSize
        const generated = await generateGoogleImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: args.prompt, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, `${aspectRatio}, ${imageSize}`, current(), exec, knownWorkspaceRoots)
      }
      if (active.provider === 'dashscope') {
        const size = args.size ?? active.imageSize
        const generated = await generateDashScopeImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: args.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
      }
      const size = args.size ?? active.imageSize
      const generated = await generateOpenAICompatibleImage({ provider: active.provider, apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: args.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
      return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
    },
    presentResult: (_args, result) => imagePresentation(result),
  }))

  ctx.tools.register(defineTool({
    name: 'edit_image',
    description: 'Edit, combine, or restyle existing images with the configured provider. Images attached inline to the latest human message are already readable DSH attachments even when no workspace file exists. In that case, call edit_image immediately with prompt only; NEVER call read_image, glob, or shell to locate them, and NEVER invent @ paths. All inline images will be used in upload order. For specific older conversation images use source_attachment_id or source_attachment_ids; both canonical sha256: IDs and full bare SHA-256 digests are accepted. For files the user explicitly names in the workspace use source_path or source_paths. Provide exactly one selector field. Without a selector, images from the latest human message take priority; only when that message has no images does editing fall back to the newest conversation image.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Describe the changes to make while preserving everything else that should remain.' },
      source_attachment_id: { type: 'string', description: 'Optional attachment id of a specific image already present in the current conversation.' },
      source_attachment_ids: { type: 'array', items: { type: 'string' }, description: 'Optional ordered attachment ids of multiple images already present in the current conversation. Prompt references such as image 1 and image 2 follow this order.' },
      source_path: { type: 'string', description: 'Optional absolute or workspace-relative path of a specific image file inside the active session workspace. Prefer this when the user names a saved file.' },
      source_paths: { type: 'array', items: { type: 'string' }, description: 'Optional ordered absolute or workspace-relative paths of multiple image files inside the active session workspace.' },
      aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'], description: 'Optional output aspect ratio for Google Gemini.' },
      image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Optional output resolution for Google Gemini.' },
      size: { type: 'string', description: 'Optional output size for OpenAI, Seedream, or DashScope.' },
      workflow: { type: 'string', description: 'Optional name of the ComfyUI workflow to run; omit to use the active workflow from settings. Only meaningful when the ComfyUI provider is selected.' },
    },
    output: imageOutput('Edited'),
    async execute(args, exec): Promise<GeneratedValue> {
      const active = resolveProvider(current())
      const sourceImages = await resolveReferenceImages({
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        attachments: ctx.attachments,
        ...(typeof args.source_attachment_id === 'string' ? { sourceAttachmentId: args.source_attachment_id } : {}),
        ...(Array.isArray(args.source_attachment_ids) ? { sourceAttachmentIds: args.source_attachment_ids } : {}),
        ...(typeof args.source_path === 'string' ? { sourcePath: args.source_path } : {}),
        ...(Array.isArray(args.source_paths) ? { sourcePaths: args.source_paths } : {}),
        maxBytes: ctx.attachments.imageLimits.maxImageBytes,
        signal: exec.signal,
      })

      if (active.provider === 'comfyui') {
        if (sourceImages.length > 1) {
          throw new Error(`ComfyUI edit_image supports exactly one source image per call; this call resolved ${String(sourceImages.length)} images. Call edit_image again with source_attachment_id set to the single attachment ID of the image to edit.`)
        }
        const sourceImage = sourceImages[0]
        if (sourceImage === undefined) throw new Error('edit_image requires a reference image')
        const workflow = selectComfyUIWorkflow(active, args.workflow)
        const generated = await editComfyUIImage({
          baseURL: active.baseURL,
          workflowJson: workflow.json,
          prompt: mergeComfyUIPrompt(workflow.presetPrompt, args.prompt),
          sourceImage: { data: sourceImage.data, mediaType: sourceImage.mediaType },
          timeoutMs: active.timeoutMs,
          maxBytes: ctx.attachments.imageLimits.maxImageBytes,
          signal: exec.signal,
        })
        return saveGenerated(ctx, generated, active.provider, workflow.name, 'API workflow', current(), exec, knownWorkspaceRoots)
      }

      const credential = await ctx.credentials.resolve(credentialRef(active.apiKeyEnv))
      if (credential === undefined || credential.value.length === 0) throw new Error(`edit_image requires the ${active.apiKeyEnv} credential; configure it in Settings > Plugins > Image generation.`)
      if (active.provider === 'google') {
        const aspectRatio = (args.aspect_ratio ?? active.aspectRatio) as AspectRatio
        const imageSize = (args.image_size ?? active.imageSize) as ImageSize
        const generated = await editGoogleImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: args.prompt, sourceImages, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, `${aspectRatio}, ${imageSize}`, current(), exec, knownWorkspaceRoots)
      }

      const size = args.size ?? active.imageSize
      if (active.provider === 'openai') {
        const generated = await editOpenAICompatibleImage({ apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: args.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
      }
      if (active.provider === 'seedream') {
        const generated = await editSeedreamImage({ apiKey: credential.value, baseURL: active.baseURL, model: active.model, prompt: args.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
      }
      const generated = await editDashScopeImage({ apiKey: credential.value, endpoint: active.endpoint, model: active.model, prompt: args.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
      return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
    },
    presentResult: (_args, result) => imagePresentation(result),
  }))
}

function imageOutput(verb: 'Generated' | 'Edited') {
  return {
    schema: {
      type: 'object', additionalProperties: false, properties: {
        attachment: { type: 'object', required: true, additionalProperties: false, properties: {
          attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' }, originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
        } },
        provider: { type: 'string', required: true }, model: { type: 'string', required: true }, output: { type: 'string', required: true }, savedTo: { type: 'string' }, saveError: { type: 'string' }, seed: { type: 'integer' },
      },
    },
    render: (_args: unknown, value: GeneratedValue) => {
      const saved = typeof value.savedTo === 'string' ? ` It was also saved to the workspace as ${value.savedTo}.` : typeof value.saveError === 'string' ? ` Saving it to the workspace failed: ${value.saveError}.` : ' It has no local file path.'
      const action = verb === 'Generated' ? 'It is already attached to the conversation.' : 'The edited image is attached to the conversation.'
      return [
        { type: 'text' as const, text: `${verb} one image with ${value.provider}/${value.model} (${value.output}). Attachment ID: ${String(value.attachment.attachmentId)}. ${action}${saved} Respond to the user without reading or searching for the image.` },
        { type: 'image' as const, attachment: value.attachment },
      ]
    },
    presentationMeta: (args: unknown, value: GeneratedValue) => ({
      kind: 'dsh-image-gen', attachment: attachmentMeta(value.attachment), provider: value.provider, model: value.model, output: value.output,
      ...(verb === 'Edited' ? { operation: 'edit' } : {}),
      ...(typeof value.savedTo === 'string' ? { savedTo: value.savedTo } : {}),
      ...(typeof value.seed === 'number' ? { seed: value.seed } : {}),
      prompt: (args as { prompt: string }).prompt,
    }),
  } as const
}

function attachmentMeta(ref: ImageAttachmentRef) {
  return {
    attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }),
  }
}

async function saveGenerated(
  ctx: Context,
  generated: { data: Uint8Array; mediaType: ImageAttachmentRef['mediaType']; seed?: number },
  provider: ImageProvider,
  model: string,
  output: string,
  config: Config,
  exec: { agent?: { session: { header: { cwd?: string } } }; signal: AbortSignal },
  knownRoots?: Set<string>,
): Promise<GeneratedValue> {
  if (!ctx.attachments.imageLimits.mediaTypes.includes(generated.mediaType)) throw new Error(`This DSH deployment does not accept ${generated.mediaType} generated images`)
  const attachment = await ctx.attachments.saveImage({ data: generated.data, mediaType: generated.mediaType, name: 'generated-image' })
  const value: GeneratedValue = {
    attachment, provider, model, output,
    ...(typeof generated.seed === 'number' ? { seed: generated.seed } : {}),
  }
  if (config.saveToWorkspace === false) return value
  const workspaceRoot = exec.agent?.session.header.cwd
  if (workspaceRoot === undefined) return value
  knownRoots?.add(workspaceRoot)
  try {
    value.savedTo = await saveImageToWorkspace({ workspaceRoot, folder: config.workspaceFolder, attachmentId: attachment.attachmentId, mediaType: generated.mediaType, data: generated.data, signal: exec.signal })
  } catch (error) {
    exec.signal.throwIfAborted()
    ctx.logger.warn(`dsh-image-gen: failed to save image to workspace: ${error instanceof Error ? error.message : String(error)}`)
    value.saveError = error instanceof Error ? error.message : String(error)
  }
  return value
}

function imagePresentation(result: ToolResult) {
  const attachment = imageAttachmentFromMeta(result.meta)
  return attachment === undefined ? undefined : { card: 'generic' as const, title: 'Generated image', content: [{ type: 'image' as const, attachment }] }
}

/** Settings hooks shape shared by both dsh-settings API generations. */
interface SettingsHooks {
  setSource: (source: () => Config) => void
  onChange: () => void
}

/** Top-level relay functions exported by dsh-settings <= 0.1.1-rc.2. */
interface LegacySettingsApi {
  installSettingsSection?: {
    (ctx: Context, ns: unknown, schema: unknown, entry: unknown, hooks: SettingsHooks): void
  }
  settingsNamespace?: (value: string) => unknown
}

/**
 * Wire the settings namespace across both dsh-settings API generations.
 * A namespace import keeps module loading safe on either version; the branch
 * picks the service method (0.1.2+) or the legacy top-level relay (<= rc.2),
 * and falls back to the composition entry with a warning when neither exists
 * so an incompatible host degrades the settings UI instead of failing boot.
 */
function installImageSettings(ctx: Context, config: Config, hooks: SettingsHooks): void {
  const namespace = dshSettings as typeof dshSettings & LegacySettingsApi
  // Runtime probe, not compile-time presence: the host decides which API
  // generation is live, whichever dsh-settings this bundle was typed against.
  const modern = namespace.SettingsProvider?.prototype?.installSection
  if (typeof modern === 'function') {
    // The injected context is typed by the current dsh-settings, whose module
    // extension already declares the `settings` service on Context.
    ctx.inject(['settings'], (settingsCtx: Context) => {
      settingsCtx.settings.installSection(ctx, IMAGE_GENERATION_NAMESPACE, Config, config, hooks)
    })
    return
  }
  const legacyInstall = namespace.installSettingsSection
  const legacyNamespace = namespace.settingsNamespace
  if (typeof legacyInstall === 'function' && typeof legacyNamespace === 'function') {
    legacyInstall(ctx, legacyNamespace(IMAGE_GENERATION_NAMESPACE), Config, config, hooks)
    return
  }
  ctx.logger.warn('dsh-image-gen: this DSH exposes neither settings API generation; settings UI stays on the composition entry')
}
