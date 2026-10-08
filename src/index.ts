/** Multi-provider image-generation Bundle for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { Config, migrateOpenAICompatConfig, resolveProvider, selectComfyUIWorkflow, withProviderOverrides, type AspectRatio, type ImageSize } from './config.js'
import { requireApiKey, resolveApiKey } from './credentials.js'
import { CanvasMirror } from './canvas-state.js'
import { serveCanvasState } from './canvas-state-route.js'
import { serveCanvasAsset } from './canvas-asset-route.js'
import { CANVAS_ASSET_ROUTE } from './shared.js'
import { registerCanvasTools, resolveCanvasSelectionReferences } from './canvas-tools.js'
import { editComfyUIImage, generateComfyUIImage } from './comfyui.js'
import { editDashScopeImage, generateDashScopeImage } from './dashscope.js'
import { editGoogleImage, generateGoogleImage } from './google.js'
import { IMAGE_ROUTE, DELETE_ROUTE, SAVE_WORKSPACE_ROUTE, imageAttachmentFromMeta, serveImage, serveDelete, serveSaveWorkspace } from './image-route.js'
import { serveImport } from './import-route.js'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from './openai-compatible.js'
import { type ResolvedReferenceImage, resolveReferenceImages } from './reference-image.js'
import { editSeedreamImage } from './seedream.js'
import { generateSubscriptionImage, registerSubscriptionRoutes, subscriptionToolParameters, SubscriptionManager } from './subscription.js'
import { CANVAS_STATE_ROUTE, IMAGE_GENERATION_NAMESPACE, IMAGE_PROVIDERS, IMPORT_ROUTE, INSPIRATION_ROUTE, STUDIO_ROUTE, TEST_CONNECTION_ROUTE, mergeComfyUIPrompt, type ImageProvider } from './shared.js'
import { createInspirationRoute } from './inspiration-route.js'
import { BUNDLED_INSPIRATION_CATALOG, searchInspirationCases } from './inspiration.js'
import { generateFromStudio, describeStudio } from './studio.js'
import { serveStudio } from './studio-route.js'
import { serveTestConnection } from './test-route.js'
import { describeSettingsHealth, serveSettingsHealth } from './settings-health.js'
import { SETTINGS_HEALTH_ROUTE, type SettingsHealth } from './shared.js'
import { deleteImageFromWorkspace, getDshWorkspaceRoots, getDshWorkspacesFull, saveImageToWorkspace } from './workspace-save.js'
import { xaiToolParameters } from './xai-params.js'

export { Config } from './config.js'
export { IMAGE_ROUTE, DELETE_ROUTE, SAVE_WORKSPACE_ROUTE, imageAttachmentFromMeta } from './image-route.js'
export { IMPORT_ROUTE } from './shared.js'
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

/** Capped prompt hits for the find_inspiration tool; `total` counts all matches. */
interface InspirationSearchValue {
  total: number
  hits: { sourceId: string; id: string; title: string; category: string; prompt: string }[]
}

/** Per-item generation request fields shared by generate_image and generate_images. */
interface SingleGenerationArgs {
  prompt: string
  provider?: string
  model?: string
  aspect_ratio?: string
  image_size?: string
  size?: string
  workflow?: string
}

/** Ordered per-item outcomes for the generate_images batch tool. */
interface BatchGeneratedValue {
  images: (GeneratedValue & { prompt: string })[]
  failures: { index: number; prompt: string; error: string }[]
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
  // DSH 0.1.7 resolves every `.volatile()` schema field into a stable box
  // whose `.get()` returns the current snapshot, so a settings edit lands
  // without restarting this fiber. Unbox on every read; older hosts hand
  // over plain values, which the same walk returns untouched.
  const plainConfig = (source: Config): Config => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get(): unknown }).get()
        : value
    }
    return out as Config
  }
  // Migration on every read: relay configs saved under the old single OpenAI
  // slot keep moving to the dedicated compat row until the persisted copy is
  // rewritten, so both rows coexist after any upgrade.
  let current: () => Config = () => migrateOpenAICompatConfig(plainConfig(config))
  const knownWorkspaceRoots = new Set<string>()
  // Host-side mirror of the workbench infinite canvas: fed by the canvas-state
  // route, read by the canvas tools, the edit_image canvas_selection source,
  // and the system-prompt context. Session-scratch, never persisted.
  const canvasMirror = new CanvasMirror()
  // Subscription image accounts: login flows, blob storage, refresh, and the
  // vendor wire calls. One instance per application; tokens stay host-side.
  const subscriptionManager = new SubscriptionManager(ctx)
  registerSubscriptionRoutes(ctx, subscriptionManager)

  const settingsHealth = installImageSettings(ctx, current(), {
    setSource: source => { current = () => migrateOpenAICompatConfig(plainConfig(source())) },
    onChange: () => {},
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: SETTINGS_HEALTH_ROUTE,
    handler: (req, res) => serveSettingsHealth(req, res, settingsHealth()),
  }), 'dsh-image-gen: settings health')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: IMAGE_ROUTE,
    handler: (req, res) => serveImage(req, res, { readImage: ref => ctx.attachments.readImage(ref) }),
  }), 'dsh-image-gen: image route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: IMPORT_ROUTE,
    handler: (req, res) => serveImport(req, res, {
      saveImage: image => ctx.attachments.saveImage(image),
      maxImageBytes: ctx.attachments.imageLimits.maxImageBytes,
      mediaTypes: ctx.attachments.imageLimits.mediaTypes,
    }),
  }), 'dsh-image-gen: import route')
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
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: CANVAS_ASSET_ROUTE,
    handler: (req, res) => serveCanvasAsset(req, res, {
      maxImageBytes: ctx.attachments.imageLimits.maxImageBytes,
      saveImage: image => ctx.attachments.saveImage(image),
    }),
  }), 'dsh-image-gen: canvas asset route')
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

  /** Per-item generation request shared by generate_image and generate_images. */
  const generateSingle = async (args: SingleGenerationArgs, exec: { agent?: { session: { header: { cwd?: string } } }; signal: AbortSignal }): Promise<GeneratedValue> => {
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
      const subscriptionParams = subscriptionToolParameters(active.provider, { ...(args.size !== undefined ? { size: args.size } : {}), ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}), ...(args.image_size !== undefined ? { imageSize: args.image_size } : {}) })
      const generated = await generateSubscriptionImage({
        manager: subscriptionManager,
        provider: active.provider,
        prompt: args.prompt,
        ...subscriptionParams,
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
    if (active.provider === 'xai') {
      const extraBody = xaiToolParameters({ ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}), ...(args.image_size !== undefined ? { imageSize: args.image_size } : {}), ...(args.size !== undefined ? { size: args.size } : {}) })
      const generated = await generateOpenAICompatibleImage({ provider: 'xai', apiKey: credential, baseURL: active.baseURL, model: active.model, prompt: args.prompt, extraBody, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal })
      return saveGenerated(ctx, generated, active.provider, active.model, extraBody.aspect_ratio ?? 'auto', current(), exec, knownWorkspaceRoots)
    }
    const size = args.size ?? active.imageSize
    // Ark output controls exist only on the Seedream profile; every other
    // provider in this branch ignores them.
    const arkOptions = active.provider === 'seedream' ? active.arkOptions : undefined
    const generated = await generateOpenAICompatibleImage({ provider: active.provider, apiKey: credential, baseURL: active.baseURL, model: active.model, prompt: args.prompt, size, maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal, ...(arkOptions === undefined ? {} : { arkOptions }) })
    return saveGenerated(ctx, generated, active.provider, active.model, size, current(), exec, knownWorkspaceRoots)
  }

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate a new image with the configured provider. Use when the user asks to create or draw a new image; use edit_image instead when they want to change an existing image. Give a complete visual prompt including subject, composition, style, lighting, and any exact text that should appear. The optional provider/model arguments switch provider or model for this call only when the user asks for a specific one. A successful image is attached directly to the conversation and may also be saved under the session workspace. Do not call read, glob, or other tools to locate or verify the image.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete description of the image to generate.' },
      provider: { type: 'string', enum: ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'], description: 'Optional provider for this call only (for example when the user asks to use a specific provider); omit to use the configured default. chatgpt-sub, grok-sub, and google-sub generate through the logged-in subscription account instead of an API key.' },
      model: { type: 'string', description: 'Optional model name for this call only, overriding the configured model. Not used by ComfyUI (use workflow instead) nor by the subscription providers (model fixed by the subscription).' },
      aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'], description: 'Optional output aspect ratio for Google Gemini, xAI Grok, and subscription channels.' },
      image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Optional output resolution for Google Gemini, xAI Grok, Grok subscription (1K/2K), or Google subscription (1K/4K).' },
      size: { type: 'string', description: 'Optional dimensions or size tier for OpenAI, Seedream, or DashScope; WIDTHxHEIGHT maps to aspect_ratio for xAI Grok.' },
      workflow: { type: 'string', description: 'Optional name of the ComfyUI workflow to run; omit to use the active workflow from settings. Only meaningful when the ComfyUI provider is selected.' },
    },
    output: imageOutput('Generated'),
    async execute(args, exec): Promise<GeneratedValue> {
      return generateSingle(args, exec)
    },
    presentResult: (_args, result) => imagePresentation(result),
  }))

  ctx.tools.register(defineTool({
    name: 'generate_images',
    description: 'Generate several images in one call, one per prompt, in order. Use for batches, variations, or illustration sets; prefer generate_image for a single image. Every successful image is attached to the conversation and may be saved under the session workspace. Items generate sequentially; a failed item is reported in the failures list and does not abort the rest. The optional provider/model/size arguments apply to every item.',
    parameters: {
      prompts: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered complete prompts; one image is generated per entry (1-10).' },
      provider: { type: 'string', enum: ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'], description: 'Optional provider for this call only, applied to every item; omit to use the configured default.' },
      model: { type: 'string', description: 'Optional model name for this call only, applied to every item.' },
      aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'], description: 'Optional output aspect ratio for Google Gemini, xAI Grok, and subscription channels.' },
      image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Optional output resolution for Google Gemini, xAI Grok, Grok subscription (1K/2K), or Google subscription (1K/4K).' },
      size: { type: 'string', description: 'Optional dimensions or size tier for OpenAI, Seedream, or DashScope; WIDTHxHEIGHT maps to aspect_ratio for xAI Grok.' },
      workflow: { type: 'string', description: 'Optional name of the ComfyUI workflow to run; omit to use the active workflow from settings.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          images: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            attachment: { type: 'object', required: true, additionalProperties: false, properties: {
              attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' }, originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
            } },
            provider: { type: 'string', required: true }, model: { type: 'string', required: true }, output: { type: 'string', required: true }, savedTo: { type: 'string' }, saveError: { type: 'string' }, seed: { type: 'integer' }, prompt: { type: 'string', required: true },
          } } },
          failures: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            index: { type: 'integer', required: true }, prompt: { type: 'string', required: true }, error: { type: 'string', required: true },
          } } },
        },
      },
      render: (_args: unknown, value: BatchGeneratedValue) => [
        {
          type: 'text' as const,
          text: `Generated ${String(value.images.length)} of ${String(value.images.length + value.failures.length)} images.\n${value.failures.map(failure => `${failure.prompt.slice(0, 80)} — failed: ${failure.error}`).join('\n')}`,
        },
        ...value.images.flatMap(image => imageOutput('Generated').render({}, image).map(block =>
          block.type === 'text' ? { ...block, text: `${block.text}\nImage prompt: ${image.prompt}` } : block)),
      ],
      presentationMeta: (_args: unknown, value: BatchGeneratedValue) => ({
        kind: 'dsh-image-gen-batch',
        images: value.images.map(image => imageOutput('Generated').presentationMeta({ prompt: image.prompt }, image)),
      }),
    },
    async execute(args, exec): Promise<BatchGeneratedValue> {
      if (args.prompts.length === 0) throw new Error('generate_images requires at least one prompt')
      if (args.prompts.length > 10) throw new Error(`generate_images accepts at most 10 prompts per call (got ${String(args.prompts.length)}); split larger batches into several calls`)
      const images: BatchGeneratedValue['images'] = []
      const failures: BatchGeneratedValue['failures'] = []
      for (const [index, prompt] of args.prompts.entries()) {
        if (exec.signal.aborted) {
          failures.push({ index, prompt, error: 'aborted before this image started' })
          continue
        }
        try {
          const value = await generateSingle({
            prompt,
            ...(args.provider !== undefined ? { provider: args.provider } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.aspect_ratio !== undefined ? { aspect_ratio: args.aspect_ratio } : {}),
            ...(args.image_size !== undefined ? { image_size: args.image_size } : {}),
            ...(args.size !== undefined ? { size: args.size } : {}),
            ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
          }, exec)
          images.push({ ...value, prompt })
        } catch (error) {
          failures.push({ index, prompt, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return { images, failures }
    },
    presentResult: (_args, result) => imagePresentation(result),
  }))

  ctx.tools.register(defineTool({
    name: 'edit_image',
    description: 'Edit, combine, or restyle existing images with the configured provider. Images attached inline to the latest human message are already readable DSH attachments even when no workspace file exists. In that case, call edit_image immediately with prompt only; NEVER call read_image, glob, or shell to locate them, and NEVER invent @ paths. All inline images will be used in upload order. For specific older conversation images use source_attachment_id or source_attachment_ids; both canonical sha256: IDs and full bare SHA-256 digests are accepted. For files the user explicitly names in the workspace use source_path or source_paths. For what the user selected or drew on the image-gen workbench canvas (for example a hand-drawn sketch) use source=canvas_selection; canvas_state can verify a selection exists first. Provide exactly one selector field. Without a selector, images from the latest human message take priority; only when that message has no images does editing fall back to the newest conversation image. When the user wants a person, character, or object from the reference images kept as the same identity, write short hard identity-preservation instructions (use the same subject from the references; do not redesign it or synthesize a similar-looking replacement; change only scene, clothing, pose, lighting, style, or composition) instead of long generic appearance descriptions, which make the model replace the subject with a synthesized lookalike.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Describe the changes to make while preserving everything else that should remain.' },
      provider: { type: 'string', enum: ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'], description: 'Optional provider for this call only (for example when the user asks to use a specific provider); omit to use the configured default. chatgpt-sub, grok-sub, and google-sub edit images through the logged-in subscription account instead of an API key.' },
      model: { type: 'string', description: 'Optional model name for this call only, overriding the configured model. Not used by ComfyUI (use workflow instead) nor by the subscription providers (model fixed by the subscription).' },
      source: { type: 'string', enum: ['canvas_selection'], description: 'Use the current selection on the image-gen workbench infinite canvas as the reference image(s): full-resolution originals when the selection is conversation-generated images, plus a screenshot of the whole selection when it also contains other content (hand-drawn strokes, pasted images). Choose this when the user refers to what they selected or drew on the canvas; combine with no other selector field.' },
      source_attachment_id: { type: 'string', description: 'Optional attachment id of a specific image already present in the current conversation.' },
      source_attachment_ids: { type: 'array', items: { type: 'string' }, description: 'Optional ordered attachment ids of multiple images already present in the current conversation. Prompt references such as image 1 and image 2 follow this order.' },
      source_path: { type: 'string', description: 'Optional absolute or workspace-relative path of a specific image file inside the active session workspace. Prefer this when the user names a saved file.' },
      source_paths: { type: 'array', items: { type: 'string' }, description: 'Optional ordered absolute or workspace-relative paths of multiple image files inside the active session workspace.' },
      aspect_ratio: { type: 'string', enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'], description: 'Optional output aspect ratio for Google Gemini, xAI Grok, and subscription channels.' },
      image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Optional output resolution for Google Gemini, xAI Grok, Grok subscription (1K/2K), or Google subscription (1K/4K).' },
      size: { type: 'string', description: 'Optional output size for OpenAI, Seedream, or DashScope; WIDTHxHEIGHT maps to aspect_ratio for xAI Grok.' },
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
        const subscriptionParams = subscriptionToolParameters(active.provider, { ...(args.size !== undefined ? { size: args.size } : {}), ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}), ...(args.image_size !== undefined ? { imageSize: args.image_size } : {}) })
        const generated = await generateSubscriptionImage({
          manager: subscriptionManager,
          provider: active.provider,
          prompt: args.prompt,
          sourceImages,
          ...subscriptionParams,
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
        const xaiExtraBody = active.provider === 'xai' ? xaiToolParameters({ ...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}), ...(args.image_size !== undefined ? { imageSize: args.image_size } : {}), ...(args.size !== undefined ? { size: args.size } : {}) }) : undefined
        const generated = await editOpenAICompatibleImage({ apiKey: credential, baseURL: active.baseURL, model: active.model, prompt: args.prompt, sourceImages, ...(active.provider === 'xai' ? {} : { size }), maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: exec.signal, ...(active.provider === 'openai-compat' ? { editFormat: active.editFormat, editExtra: active.editExtra } : active.provider === 'xai' ? { editFormat: 'xaiJson' as const, ...(xaiExtraBody === undefined ? {} : { extraBody: xaiExtraBody }) } : {}) })
        return saveGenerated(ctx, generated, active.provider, active.model, active.provider === 'xai' ? (xaiExtraBody?.aspect_ratio ?? 'auto') : size, current(), exec, knownWorkspaceRoots)
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

  ctx.tools.register(defineTool({
    name: 'find_inspiration',
    description: 'Search the bundled inspiration libraries for ready-made image prompts: the handdraw-style cookbook (styles 风格, layouts 排版, theme colors 单色) plus the awesome-gpt-image-2 example set. Use before generate_image whenever the user wants a specific art style, layout template, or theme color, mentions a numbered style like 风格 #123, or asks for reference or example prompts. Each hit carries a full prompt reusable with generate_image; handdraw style prompts contain a 主题 placeholder to replace with the user\'s topic, and may be combined with a layout and a theme-color prompt.',
    parameters: {
      query: { type: 'string', description: 'Keyword matched against titles, prompts, categories, and style/scene tags; Chinese or English. Omit to sample what a library offers.' },
      category: { type: 'string', description: 'Optional exact category filter, for example "风格 · D 日本作者 / 当代插画体系", "排版 · 信息图", or "单色 · 中性色系".' },
      source: { type: 'string', enum: ['handraw-style', 'awesome-gpt-image-2'], description: 'Optional single library to search; omit to search both.' },
      limit: { type: 'integer', description: 'Optional maximum number of hits to return, 1-20 (default 8).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          total: { type: 'integer', required: true },
          hits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            sourceId: { type: 'string', required: true },
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            category: { type: 'string', required: true },
            prompt: { type: 'string', required: true },
          } } },
        },
      },
      render: (_args: unknown, value: InspirationSearchValue) => [{
        type: 'text' as const,
        text: `${String(value.hits.length)} of ${String(value.total)} matching inspiration cases.\n\n${value.hits.map(hit => `[${hit.sourceId} · ${hit.category}] ${hit.title}\n${hit.prompt}`).join('\n\n')}`,
      }],
    },
    async execute(args): Promise<InspirationSearchValue> {
      const { total, hits } = searchInspirationCases(BUNDLED_INSPIRATION_CATALOG, {
        query: args.query ?? '',
        sourceId: args.source,
        category: args.category,
        limit: args.limit,
      })
      return { total, hits: hits.map(({ sourceId, id, title, category, prompt }) => ({ sourceId, id, title, category, prompt })) }
    },
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
  const meta = result.meta
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)
    && meta.kind === 'dsh-image-gen-batch' && Array.isArray(meta.images)) {
    const content = meta.images.flatMap(image => {
      const attachment = imageAttachmentFromMeta(image)
      return attachment === undefined ? [] : [{ type: 'image' as const, attachment }]
    })
    return content.length === 0 ? undefined : { card: 'generic' as const, title: 'Generated images', content }
  }
  const attachment = imageAttachmentFromMeta(result.meta)
  return attachment === undefined ? undefined : { card: 'generic' as const, title: 'Generated image', content: [{ type: 'image' as const, attachment }] }
}

/** Settings hooks shape shared by both dsh-settings API generations. */
interface SettingsHooks {
  setSource: (source: () => Config) => void
  onChange: () => void
}

/** The `settings` Context service as typed by dsh-settings 0.1.2–0.1.6. */
interface SettingsSectionInstaller {
  installSection(ctx: Context, namespace: unknown, schema: unknown, entry: unknown, hooks: SettingsHooks): void
}

/**
 * Wire the settings namespace across both dsh-settings API generations.
 * The probe reads the HOST's `settings` service, never the bundled
 * dsh-settings module: the build inlines that module, so its exports always
 * look like the compile-time generation while only the service handed to this
 * fiber reflects the running host. dsh-settings 0.1.2–0.1.6 put `installSection`
 * on the service, so the namespace registers through it; DSH 0.1.7 replaced it
 * with schema-derived forms served by the loader itself (keyed by entry id),
 * so its service carries no installer and a host without any settings service
 * simply never runs the callback. A modern host with an unmarked schema is
 * incompatible and must be diagnosed, while old hosts keep their installer.
 */
function installImageSettings(ctx: Context, config: Config, hooks: SettingsHooks): () => SettingsHealth {
  let service: unknown
  ctx.inject(['settings'], settingsCtx => {
    const settings = settingsCtx.settings as SettingsForms & Partial<SettingsSectionInstaller>
    service = settings
    const health = describeSettingsHealth(settings, Config)
    if (health.settings === 'live' && !health.liveSchema) {
      ctx.logger.warn('dsh-image-gen: the loaded schema lacks volatile fields required by this DSH settings service. Install @deepseek-ai/schemastery >=3.18.4 <4 in the plugin profile and check which copy the plugin resolves; settings cannot be saved with this schema.')
    }
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, IMAGE_GENERATION_NAMESPACE, Config, config, hooks)
    }
    return () => { service = undefined }
  })
  return () => describeSettingsHealth(service, Config)
}
