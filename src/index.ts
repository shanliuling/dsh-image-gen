/** Multi-provider image-generation Bundle for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { Config, migrateOpenAICompatConfig, resolveProvider, selectComfyUIWorkflow, withProviderOverrides, type AspectRatio, type ImageSize } from './config.js'
import { requireApiKey, resolveApiKey } from './credentials.js'
import { CanvasMirror } from './canvas-state.js'
import { serveCanvasState } from './canvas-state-route.js'
import { registerCanvasTools, resolveCanvasSelectionReferences } from './canvas-tools.js'
import { editComfyUIImage, generateComfyUIImage } from './comfyui.js'
import { editDashScopeImage, generateDashScopeImage } from './dashscope.js'
import { editGoogleImage, generateGoogleImage } from './google.js'
import { IMAGE_ROUTE, DELETE_ROUTE, SAVE_WORKSPACE_ROUTE, imageAttachmentFromMeta, serveImage, serveDelete, serveSaveWorkspace } from './image-route.js'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from './openai-compatible.js'
import { type ResolvedReferenceImage, resolveReferenceImages } from './reference-image.js'
import { editSeedreamImage } from './seedream.js'
import { generateSubscriptionImage, registerSubscriptionRoutes, SubscriptionManager } from './subscription.js'
import { CANVAS_STATE_ROUTE, IMAGE_GENERATION_NAMESPACE, IMAGE_PROVIDERS, INSPIRATION_ROUTE, STUDIO_ROUTE, TEST_CONNECTION_ROUTE, mergeComfyUIPrompt, type ImageProvider } from './shared.js'
import { createInspirationRoute } from './inspiration-route.js'
import { generateFromStudio, describeStudio } from './studio.js'
import { serveStudio } from './studio-route.js'
import { serveTestConnection } from './test-route.js'
import { deleteImageFromWorkspace, getDshWorkspaceRoots, getDshWorkspacesFull, saveImageToWorkspace } from './workspace-save.js'

export { Config } from './config.js'
export { IMAGE_ROUTE, DELETE_ROUTE, SAVE_WORKSPACE_ROUTE, imageAttachmentFromMeta } from './image-route.js'
export { STUDIO_ROUTE } from './shared.js'
export { INSPIRATION_ROUTE } from './shared.js'
export { TEST_CONNECTION_ROUTE } from './shared.js'
export { CANVAS_STATE_ROUTE } from './shared.js'

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

/** Validate the untrusted per-call provider override from tool arguments. */
function providerOverrideOf(value: unknown): ImageProvider | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !(IMAGE_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported provider ${JSON.stringify(value)}. Supported providers: ${IMAGE_PROVIDERS.join(', ')}.`)
  }
  return value as ImageProvider
}

export function apply(ctx: Context, config: Config = {}): void {
  // Migration on every read: relay configs saved under the old single OpenAI
  // slot keep moving to the dedicated compat row until the persisted copy is
  // rewritten, so both rows coexist after any upgrade.
  let current: () => Config = () => migrateOpenAICompatConfig(config)
  const knownWorkspaceRoots = new Set<string>()
  // Host-side mirror of the workbench infinite canvas: fed by the canvas-state
  // route, read by the canvas tools, the edit_image canvas_selection source,
  // and the system-prompt context. Session-scratch, never persisted.
  const canvasMirror = new CanvasMirror()
  // Subscription image accounts: login flows, blob storage, refresh, and the
  // vendor wire calls. One instance per application; tokens stay host-side.
  const subscriptionManager = new SubscriptionManager(ctx)
  registerSubscriptionRoutes(ctx, subscriptionManager)

  installImageSettings(ctx, config, {
    setSource: source => { current = () => migrateOpenAICompatConfig(source()) },
    onChange: () => {},
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: IMAGE_ROUTE,
    handler: (req, res) => serveImage(req, res, { readImage: ref => ctx.attachments.readImage(ref) }),
  }), 'dsh-image-gen: image route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: DELETE_ROUTE,
    handler: (req, res) => serveDelete(req, res, {
      deleteWorkspaceImage: async filePath => {
        const discovered = await getDshWorkspaceRoots().catch(() => [])
        return deleteImageFromWorkspace(filePath, new Set([...knownWorkspaceRoots, ...discovered, process.cwd()]))
      },
    }),
  }), 'dsh-image-gen: delete route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: SAVE_WORKSPACE_ROUTE,
    handler: (req, res) => serveSaveWorkspace(req, res, {
      readImage: ref => ctx.attachments.readImage(ref),
      saveToWorkspace: options => {
        if (options.workspaceRoot) {
          knownWorkspaceRoots.add(options.workspaceRoot)
        }
        return saveImageToWorkspace({
          workspaceRoot: options.workspaceRoot,
          folder: current().workspaceFolder,
          attachmentId: options.attachmentId,
          mediaType: options.mediaType,
          data: options.data,
        })
      },
      getActiveWorkspaceRoot: () => Array.from(knownWorkspaceRoots)[0] || process.cwd(),
      getAllowedWorkspaceRoots: async () => {
        const discovered = await getDshWorkspaceRoots().catch(() => [])
        return new Set([...knownWorkspaceRoots, ...discovered, process.cwd()])
      },
      isSaveEnabled: () => current().saveToWorkspace !== false,
    }),
  }), 'dsh-image-gen: save workspace route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: TEST_CONNECTION_ROUTE,
    handler: (req, res) => serveTestConnection(req, res, {
      resolveKey: provider => resolveApiKey(ctx, provider),
      config: () => current(),
      subscriptionManager,
    }),
  }), 'dsh-image-gen: test connection route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: CANVAS_STATE_ROUTE,
    handler: (req, res) => serveCanvasState(req, res, {
      mirror: canvasMirror,
      // Base64 inflates the PNG by ~4/3; the slack covers the JSON envelope.
      maxBodyBytes: Math.ceil(ctx.attachments.imageLimits.maxImageBytes * 1.4) + 256 * 1024,
      maxImageBytes: ctx.attachments.imageLimits.maxImageBytes,
    }),
  }), 'dsh-image-gen: canvas state route')
  // A few lines of live canvas context per model request. The service is an
  // optional dependency: hosts without dsh-system-prompt boot unchanged and
  // the canvas tools remain the model's way to discover the canvas.
  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    promptCtx.systemPrompt.context({
      name: 'dsh-image-gen:canvas',
      order: 60,
      text: () => canvasMirror.digest(),
    })
  })
  registerCanvasTools(ctx, canvasMirror, {
    // Materialization hook: view_canvas persists a screenshot only when the
    // model actually views it. The content-addressed store dedupes repeat
    // views, and dead screenshots never reach the disk.
    persistSelectionImage: image => ctx.attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: 'canvas-selection' }),
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: STUDIO_ROUTE,
    handler: (req, res) => serveStudio(req, res, {
      describe: async () => {
        const base = await describeStudio(ctx, current(), subscriptionManager)
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
        return generateFromStudio(ctx, current(), input, signal, fallbackRoot, subscriptionManager)
      },
      maxBodyBytes: Math.ceil(ctx.attachments.imageLimits.maxImageBytes * 1.4 * 5) + 256 * 1024,
    }),
  }), 'dsh-image-gen: studio route')
  const serveInspiration = createInspirationRoute()
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: INSPIRATION_ROUTE,
    handler: (req, res) => {
      const originalUrl = req.url ?? '/'
      req.url = originalUrl.startsWith(INSPIRATION_ROUTE) ? originalUrl.slice(INSPIRATION_ROUTE.length) || '/' : originalUrl
      return serveInspiration(req, res)
    },
  }), 'dsh-image-gen: inspiration route')

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate a new image with the configured provider. Use when the user asks to create or draw a new image; use edit_image instead when they want to change an existing image. Give a complete visual prompt including subject, composition, style, lighting, and any exact text that should appear. The optional provider/model arguments switch provider or model for this call only when the user asks for a specific one. A successful image is attached directly to the conversation and may also be saved under the session workspace. Do not call read, glob, or other tools to locate or verify the image.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete description of the image to generate.' },
      provider: { type: 'string', enum: ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'], description: 'Optional provider for this call only (for example when the user asks to use a specific provider); omit to use the configured default. chatgpt-sub, grok-sub, and google-sub generate through the logged-in subscription account instead of an API key.' },
      model: { type: 'string', description: 'Optional model name for this call only, overriding the configured model. Not used by ComfyUI (use workflow instead) nor by the subscription providers (model fixed by the subscription).' },
      aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'], description: 'Optional output aspect ratio for Google Gemini.' },
      image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Optional output resolution for Google Gemini.' },
      size: { type: 'string', description: 'Optional dimensions or size tier for OpenAI, Seedream, or DashScope.' },
      workflow: { type: 'string', description: 'Optional name of the ComfyUI workflow to run; omit to use the active workflow from settings. Only meaningful when the ComfyUI provider is selected.' },
    },
    output: imageOutput('Generated'),
    async execute(args, exec): Promise<GeneratedValue> {
      const active = resolveProvider(withProviderOverrides(current(), providerOverrideOf(args.provider), args.model))
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
      if (active.provider === 'chatgpt-sub' || active.provider === 'grok-sub' || active.provider === 'google-sub') {
        const generated = await generateSubscriptionImage({
          manager: subscriptionManager,
          provider: active.provider,
          prompt: args.prompt,
          ...(args.size !== undefined ? { size: args.size } : {}),
          maxBytes: ctx.attachments.imageLimits.maxImageBytes,
          signal: exec.signal,
        })
        return saveGenerated(ctx, generated, active.provider, active.model, 'subscription', current(), exec, knownWorkspaceRoots)
      }
      const credential = await requireApiKey(ctx, active.provider, 'generate_image')
      if (active.provider === 'google') {
        const aspectRatio = (args.aspect_ratio ?? active.aspectRatio) as AspectRatio
        const imageSize = (args.image_size ?? active.imageSize) as ImageSize
        const generated = await generateGoogleImage({ apiKey: credential, endpoint: active.endpoint, model: active.model, prompt: args.prompt, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, `${aspectRatio}, ${imageSize}`, current(), exec, knownWorkspaceRoots)
      }
      if (active.provider === 'dashscope') {
        const size = args.size ?? active.imageSize
        const generated = await generateDashScopeImage({ apiKey: credential, endpoint: active.endpoint, model: active.model, prompt: args.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
      }
      const size = args.size ?? active.imageSize
      // Ark output controls exist only on the Seedream profile; every other
      // provider in this branch ignores them.
      const arkOptions = active.provider === 'seedream' ? active.arkOptions : undefined
      const generated = await generateOpenAICompatibleImage({ provider: active.provider, apiKey: credential, baseURL: active.baseURL, model: active.model, prompt: args.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal, ...(arkOptions === undefined ? {} : { arkOptions }) })
      return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
    },
    presentResult: (_args, result) => imagePresentation(result),
  }))

  ctx.tools.register(defineTool({
    name: 'edit_image',
    description: 'Edit, combine, or restyle existing images with the configured provider. Images attached inline to the latest human message are already readable DSH attachments even when no workspace file exists. In that case, call edit_image immediately with prompt only; NEVER call read_image, glob, or shell to locate them, and NEVER invent @ paths. All inline images will be used in upload order. For specific older conversation images use source_attachment_id or source_attachment_ids; both canonical sha256: IDs and full bare SHA-256 digests are accepted. For files the user explicitly names in the workspace use source_path or source_paths. For what the user selected or drew on the image-gen workbench canvas (for example a hand-drawn sketch) use source=canvas_selection; canvas_state can verify a selection exists first. Provide exactly one selector field. Without a selector, images from the latest human message take priority; only when that message has no images does editing fall back to the newest conversation image.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Describe the changes to make while preserving everything else that should remain.' },
      provider: { type: 'string', enum: ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'], description: 'Optional provider for this call only (for example when the user asks to use a specific provider); omit to use the configured default. chatgpt-sub, grok-sub, and google-sub edit images through the logged-in subscription account instead of an API key.' },
      model: { type: 'string', description: 'Optional model name for this call only, overriding the configured model. Not used by ComfyUI (use workflow instead) nor by the subscription providers (model fixed by the subscription).' },
      source: { type: 'string', enum: ['canvas_selection'], description: 'Use the current selection on the image-gen workbench infinite canvas as the reference image(s): full-resolution originals when the selection is conversation-generated images, plus a screenshot of the whole selection when it also contains other content (hand-drawn strokes, pasted images). Choose this when the user refers to what they selected or drew on the canvas; combine with no other selector field.' },
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
      const active = resolveProvider(withProviderOverrides(current(), providerOverrideOf(args.provider), args.model))
      const canvasSelection = args.source === 'canvas_selection'
      if (canvasSelection && (
        args.source_attachment_id !== undefined
        || Array.isArray(args.source_attachment_ids)
        || args.source_path !== undefined
        || Array.isArray(args.source_paths)
      )) {
        throw new Error('edit_image source=canvas_selection cannot be combined with source_attachment_id, source_attachment_ids, source_path, or source_paths; provide exactly one selector')
      }
      const sourceImages: ResolvedReferenceImage[] = canvasSelection
        ? await resolveCanvasSelectionReferences({
          mirror: canvasMirror,
          attachments: ctx.attachments,
          ...(exec.agent === undefined ? {} : { agent: exec.agent }),
          maxBytes: ctx.attachments.imageLimits.maxImageBytes,
          signal: exec.signal,
        })
        : await resolveReferenceImages({
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

      if (active.provider === 'chatgpt-sub' || active.provider === 'grok-sub' || active.provider === 'google-sub') {
        if (sourceImages.length === 0) throw new Error('edit_image requires a reference image')
        const generated = await generateSubscriptionImage({
          manager: subscriptionManager,
          provider: active.provider,
          prompt: args.prompt,
          sourceImages,
          ...(args.size !== undefined ? { size: args.size } : {}),
          maxBytes: ctx.attachments.imageLimits.maxImageBytes,
          signal: exec.signal,
        })
        return saveGenerated(ctx, generated, active.provider, active.model, 'subscription edit', current(), exec, knownWorkspaceRoots)
      }

      const credential = await requireApiKey(ctx, active.provider, 'edit_image')
      if (active.provider === 'google') {
        const aspectRatio = (args.aspect_ratio ?? active.aspectRatio) as AspectRatio
        const imageSize = (args.image_size ?? active.imageSize) as ImageSize
        const generated = await editGoogleImage({ apiKey: credential, endpoint: active.endpoint, model: active.model, prompt: args.prompt, sourceImages, aspectRatio, imageSize, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
        return saveGenerated(ctx, generated, active.provider, active.model, `${aspectRatio}, ${imageSize}`, current(), exec, knownWorkspaceRoots)
      }

      const size = args.size ?? active.imageSize
      if (active.provider === 'openai' || active.provider === 'openai-compat' || active.provider === 'xai' || active.provider === 'zhipu') {
        const generated = await editOpenAICompatibleImage({ apiKey: credential, baseURL: active.baseURL, model: active.model, prompt: args.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal, ...(active.provider === 'openai-compat' ? { editFormat: active.editFormat, editExtra: active.editExtra } : {}) })
        return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
      }
      if (active.provider === 'seedream') {
        const generated = await editSeedreamImage({ apiKey: credential, baseURL: active.baseURL, model: active.model, prompt: args.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal, arkOptions: active.arkOptions })
        return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
      }
      const generated = await editDashScopeImage({ apiKey: credential, endpoint: active.endpoint, model: active.model, prompt: args.prompt, sourceImages, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
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
