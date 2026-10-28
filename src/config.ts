/** User-facing configuration for supported image providers. */
import z from '@deepseek-ai/schemastery'
import { compatEditFormat } from './watermark.js'
import type { CompatEditFormat } from './openai-compatible.js'

import {
  ARK_BACKGROUND_MODES,
  ARK_OUTPUT_FORMATS,
  DEFAULT_CLOUD_TIMEOUT_MS,
  DEFAULT_DASHSCOPE_ENDPOINT,
  DEFAULT_DASHSCOPE_MODEL,
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_COMFYUI_TIMEOUT_MS,
  DEFAULT_COMFYUI_WORKFLOW_LABEL,
  DEFAULT_GOOGLE_ENDPOINT,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_SEEDREAM_BASE_URL,
  DEFAULT_SEEDREAM_MODEL,
  DEFAULT_SUBSCRIPTION_MODELS,
  DEFAULT_XAI_BASE_URL,
  DEFAULT_XAI_MODEL,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_MODEL,
  DASHSCOPE_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  IMAGE_PROVIDERS,
  OPENAI_API_KEY_ENV,
  OPENAI_COMPAT_API_KEY_ENV,
  SEEDREAM_API_KEY_ENV,
  XAI_API_KEY_ENV,
  ZHIPU_API_KEY_ENV,
  activeComfyUIWorkflow,
  resolveComfyUIWorkflows,
  resolveOpenAICompatChannel,
  type OpenAICompatChannel,
  type ArkBackgroundMode,
  type ArkOutputFormat,
  type ArkOutputOptions,
  type ComfyUIWorkflowEntry,
  type ImageProvider,
} from './shared.js'

export {
  ARK_BACKGROUND_MODES,
  ARK_OUTPUT_FORMATS,
  DEFAULT_CLOUD_TIMEOUT_MS,
  DEFAULT_DASHSCOPE_ENDPOINT,
  DEFAULT_DASHSCOPE_MODEL,
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_COMFYUI_TIMEOUT_MS,
  DEFAULT_COMFYUI_WORKFLOW_LABEL,
  DEFAULT_GOOGLE_ENDPOINT,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_SEEDREAM_BASE_URL,
  DEFAULT_SEEDREAM_MODEL,
  DEFAULT_XAI_BASE_URL,
  DEFAULT_XAI_MODEL,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_MODEL,
  DASHSCOPE_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  IMAGE_PROVIDERS,
  OPENAI_API_KEY_ENV,
  OPENAI_COMPAT_API_KEY_ENV,
  SEEDREAM_API_KEY_ENV,
  XAI_API_KEY_ENV,
  ZHIPU_API_KEY_ENV,
  activeComfyUIWorkflow,
  resolveComfyUIWorkflows,
  type ArkBackgroundMode,
  type ArkOutputFormat,
  type ArkOutputOptions,
  type ComfyUIWorkflowEntry,
  type ImageProvider,
}

/** Default workspace subfolder that receives generated image files. */
export const DEFAULT_WORKSPACE_FOLDER = 'dsh-image-gen'

/** Google tool-level controls. Aligned with gemini-3.1-flash-image's common set. */
export const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'] as const
export const IMAGE_SIZES = ['1K', '2K', '4K'] as const
export type AspectRatio = typeof ASPECT_RATIOS[number]
export type ImageSize = typeof IMAGE_SIZES[number]

/** Bundle configuration from the profile patch and the Web settings page. */
export interface Config {
  provider?: ImageProvider
  cloudTimeoutMs?: number
  googleModel?: string
  googleEndpoint?: string
  /** Use Gemini generateContent instead of Interactions; opt-in for native-only gateways. */
  googleNative?: boolean
  openaiBaseURL?: string
  openaiModel?: string
  /** Official model size table: ratio -> resolution tier -> pixels. Empty uses model presets. */
  openaiSizes?: Record<string, Record<string, string>>
  /** OpenAI-compatible relay settings; independent from the official OpenAI row. */
  openaiCompatLabel?: string
  openaiCompatBaseURL?: string
  openaiCompatModel?: string
  /** Models offered by the workbench for the legacy default channel. */
  openaiCompatModels?: string[]
  /** Additional named relay channels; the flat fields above remain the default channel. */
  openaiCompatChannels?: OpenAICompatChannel[]
  openaiCompatActiveChannel?: string
  /** Editing model; empty reuses the generation model. */
  openaiCompatEditModel?: string
  /** Default quality; empty preserves the upstream default by omitting the field. */
  openaiCompatQuality?: string
  /** Quality values accepted by this relay; independent of resolution tiers. */
  openaiCompatQualityOptions?: string[]
  /** Generation-only JSON fields, merged last (e.g. watermark: false). */
  openaiCompatExtraBody?: Record<string, unknown>
  /** JSON edit sizing stays auto unless the relay supports selected dimensions. */
  openaiCompatEditSizeMode?: 'auto' | 'selected'
  /**
   * Request shape the relay's images/edits endpoint expects (#41). Most
    * relays take OpenAI's multipart form; some (e.g. SenseNova) accept the
    * generations endpoint but run edits on their own JSON contract with
    * `images: [{ image_url }]` objects; some take a multipart form whose
    * `reference_images` field is a JSON array of base64 strings. Defaults to
    * `multipart`.
    */
  openaiCompatEditFormat?: 'multipart' | 'jsonImageUrlArray' | 'formReferenceImages' | 'siliconflowJson'
  /**
   * Extra JSON fields merged into the JSON edit body last (can override the
   * built-in defaults), e.g. SenseNova's `watermark`/`prompt_extend`.
   * Used by JSON edit formats, including automatically recognized official contracts.
   */
  openaiCompatEditExtra?: Record<string, unknown>
  /**
   * Size table the OpenAI-compatible relay accepts, keyed
   * `ratio → resolution tier → exact size string`, e.g.
   * `{'16:9': {'1K': '1536x864', '2K': '2048x1152', '4K': '3840x2160'}}`.
   * Empty keeps the built-in OpenAI trio (`1024x1024`, `1536x1024`,
   * `1024x1536`). The workbench derives its ratio picker from the outer keys
   * and its resolution picker from the tier keys, so relays or models with
   * richer size tables expose every supported combination instead of the
   * fixed three. Generation sends the exact configured string.
   */
  openaiCompatSizes?: Record<string, Record<string, string>>
  seedreamBaseURL?: string
  seedreamModel?: string
  /**
   * Ark `output_format`. Ark defaults to `jpeg`, which is lossy and cannot
   * carry an alpha channel; `png` is lossless, so it survives later editing
   * (e.g. background removal) without JPEG ringing around the subject.
   */
  seedreamOutputFormat?: ArkOutputFormat
  /**
   * Ark `watermark`. Ark defaults to `true`, which bakes an "AI generated"
   * mark into the bottom-right corner.
   */
  seedreamWatermark?: boolean
  /**
   * Ark `background`. Only the edit path can honour `transparent`, and only
   * when every reference image already carries an alpha channel.
   */
  seedreamBackground?: ArkBackgroundMode
  dashscopeEndpoint?: string
  dashscopeModel?: string
  xaiBaseURL?: string
  xaiModel?: string
  zhipuBaseURL?: string
  zhipuModel?: string
  comfyuiBaseURL?: string
  /** Named ComfyUI workflows managed by the Web settings page. */
  comfyuiWorkflows?: ComfyUIWorkflowEntry[]
  /** Name of the workflow ComfyUI calls use by default. */
  comfyuiActiveWorkflow?: string
  /** Legacy single-workflow storage; synced to the active entry for downgrades. */
  comfyuiWorkflowJson?: string
  /** Original imported file name of the legacy single workflow. */
  comfyuiWorkflowName?: string
  comfyuiTimeoutMs?: number
  /** Also write every generated image as a file under the session workspace. */
  saveToWorkspace?: boolean
  /** Workspace subfolder for generated images; empty means the workspace root. */
  workspaceFolder?: string
  /** Show the provider switcher beside the chat input. */
  showProviderPill?: boolean
}

/**
 * Mark a schema field live for DSH 0.1.7+: the host serves a plugin's settings
 * form only for `.volatile()` fields and hands `apply` a `Volatile` box per
 * field (unwrapped in `src/index.ts`). Hosts ≤0.1.6 ship a schemastery without
 * the method, so marking is conditional — an unmarked schema stays plain there
 * and the old settings relay keeps working.
 */
function volatile<T extends z>(schema: T): T {
  const mark = (schema as unknown as { volatile?: () => T }).volatile
  return typeof mark === 'function' ? mark.call(schema) : schema
}

/**
 * Cordis configuration schema. Volatile marking happens per field (see
 * `volatile`); the `z<Config>` annotation keeps the plain output type for the
 * rest of the codebase because the wrapping is unwrapped at the entry.
 */
export const Config = z.object({
  provider: volatile(z.union(IMAGE_PROVIDERS).default('google')),
  cloudTimeoutMs: volatile(z.number().min(5_000).max(3_600_000).default(DEFAULT_CLOUD_TIMEOUT_MS)),
  googleModel: volatile(z.string().default(DEFAULT_GOOGLE_MODEL)),
  googleEndpoint: volatile(z.string().default(DEFAULT_GOOGLE_ENDPOINT)),
  googleNative: volatile(z.boolean().default(false)),
  openaiBaseURL: volatile(z.string().default(DEFAULT_OPENAI_BASE_URL)),
  openaiModel: volatile(z.string().default(DEFAULT_OPENAI_MODEL)),
  openaiSizes: volatile(z.dict(z.dict(z.string())).default({})),
  openaiCompatLabel: volatile(z.string().default('')),
  openaiCompatBaseURL: volatile(z.string().default('')),
  openaiCompatModel: volatile(z.string().default('')),
  openaiCompatModels: volatile(z.array(z.string()).default([])),
  openaiCompatChannels: volatile(z.array(z.object({
    id: z.string(),
    label: z.string().default(''),
    keyRef: z.string(),
    baseURL: z.string().default(''),
    model: z.string().default(''),
    models: z.array(z.string()).default([]),
    editModel: z.string().default(''),
    quality: z.string().default(''),
    qualityOptions: z.array(z.string()).default([]),
    extraBody: z.dict(z.any()).default({}),
    editSizeMode: z.union(['auto', 'selected']).default('auto'),
    editFormat: z.union([z.const('multipart'), z.const('jsonImageUrlArray'), z.const('formReferenceImages'), z.const('siliconflowJson')]).default('multipart'),
    editExtra: z.dict(z.any()).default({}),
    sizes: z.dict(z.dict(z.string())).default({}),
  })).default([])),
  openaiCompatActiveChannel: volatile(z.string().default('')),
  openaiCompatEditModel: volatile(z.string().default('')),
  openaiCompatQuality: volatile(z.string().default('')),
  openaiCompatQualityOptions: volatile(z.array(z.string()).default(['auto', 'low', 'medium', 'high'])),
  openaiCompatExtraBody: volatile(z.dict(z.any()).default({})),
  openaiCompatEditSizeMode: volatile(z.union(['auto', 'selected']).default('auto')),
  openaiCompatEditFormat: volatile(z.union([z.const('multipart'), z.const('jsonImageUrlArray'), z.const('formReferenceImages'), z.const('siliconflowJson')]).default('multipart')),
  openaiCompatEditExtra: volatile(z.dict(z.any()).default({})),
  openaiCompatSizes: volatile(z.dict(z.dict(z.string())).default({})),
  seedreamBaseURL: volatile(z.string().default(DEFAULT_SEEDREAM_BASE_URL)),
  seedreamModel: volatile(z.string().default(DEFAULT_SEEDREAM_MODEL)),
  seedreamOutputFormat: volatile(z.union(ARK_OUTPUT_FORMATS).default('jpeg')),
  seedreamWatermark: volatile(z.boolean().default(true)),
  seedreamBackground: volatile(z.union(ARK_BACKGROUND_MODES).default('opaque')),
  dashscopeEndpoint: volatile(z.string().default(DEFAULT_DASHSCOPE_ENDPOINT)),
  dashscopeModel: volatile(z.string().default(DEFAULT_DASHSCOPE_MODEL)),
  xaiBaseURL: volatile(z.string().default(DEFAULT_XAI_BASE_URL)),
  xaiModel: volatile(z.string().default(DEFAULT_XAI_MODEL)),
  zhipuBaseURL: volatile(z.string().default(DEFAULT_ZHIPU_BASE_URL)),
  zhipuModel: volatile(z.string().default(DEFAULT_ZHIPU_MODEL)),
  comfyuiBaseURL: volatile(z.string().default(DEFAULT_COMFYUI_BASE_URL)),
  comfyuiWorkflows: volatile(z.array(z.object({ name: z.string(), json: z.string(), presetPrompt: z.string().default('') })).default([])),
  comfyuiActiveWorkflow: volatile(z.string().default('')),
  comfyuiWorkflowJson: volatile(z.string().default('')),
  comfyuiWorkflowName: volatile(z.string().default('')),
  comfyuiTimeoutMs: volatile(z.number().min(1_000).max(3_600_000).default(DEFAULT_COMFYUI_TIMEOUT_MS)),
  saveToWorkspace: volatile(z.boolean().default(true)),
  workspaceFolder: volatile(z.string().default(DEFAULT_WORKSPACE_FOLDER)),
  showProviderPill: volatile(z.boolean().default(false)),
}) as unknown as z<Config>

/** Resolve exactly one provider profile for a tool call. */
export function resolveProvider(config: Config):
  | { provider: 'google'; apiKeyEnv: string; model: string; endpoint: string; native: boolean; aspectRatio: AspectRatio; imageSize: ImageSize }
  | { provider: 'openai'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string }
  | { provider: 'openai-compat'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string; editFormat: CompatEditFormat; editExtra: Record<string, unknown> }
  | { provider: 'seedream'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string; arkOptions: ArkOutputOptions }
  | { provider: 'dashscope'; apiKeyEnv: string; model: string; endpoint: string; imageSize: string }
  | { provider: 'xai'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string }
  | { provider: 'zhipu'; apiKeyEnv: string; model: string; baseURL: string; imageSize: string }
  | { provider: 'comfyui'; baseURL: string; workflows: ComfyUIWorkflowEntry[]; workflow?: ComfyUIWorkflowEntry; timeoutMs: number }
  | { provider: 'chatgpt-sub'; model: string }
  | { provider: 'grok-sub'; model: string }
  | { provider: 'google-sub'; model: string } {
  switch (config.provider ?? 'google') {
    case 'openai': return { provider: 'openai', apiKeyEnv: OPENAI_API_KEY_ENV, model: config.openaiModel ?? DEFAULT_OPENAI_MODEL, baseURL: config.openaiBaseURL ?? DEFAULT_OPENAI_BASE_URL, imageSize: '1024x1024' }
    case 'openai-compat': {
      const baseURL = config.openaiCompatBaseURL?.trim()
      if (baseURL === undefined || baseURL.length === 0) {
        throw new Error('OpenAI 兼容 provider requires a base URL; set it in Settings > Plugins > Image generation.')
      }
      const model = config.openaiCompatModel?.trim()
      if (model === undefined || model.length === 0) {
        throw new Error('OpenAI 兼容 provider requires a model name; set it in Settings > Plugins > Image generation.')
      }
      return { provider: 'openai-compat', apiKeyEnv: OPENAI_COMPAT_API_KEY_ENV, model, baseURL, imageSize: '1024x1024', editFormat: compatEditFormat(config), editExtra: config.openaiCompatEditExtra ?? {} }
    }
    case 'seedream': {
      const seedreamBackground = config.seedreamBackground ?? 'opaque'
      return {
        provider: 'seedream',
        apiKeyEnv: SEEDREAM_API_KEY_ENV,
        model: config.seedreamModel ?? DEFAULT_SEEDREAM_MODEL,
        baseURL: config.seedreamBaseURL ?? DEFAULT_SEEDREAM_BASE_URL,
        imageSize: '2K',
        arkOptions: {
          // Ark rejects `output_format: jpeg` together with `background: transparent`
          // outright — a JPEG cannot carry the alpha channel the transparent mode
          // exists to produce. The two controls are independent in the settings UI,
          // so couple them here rather than letting the combination reach the wire.
          outputFormat: seedreamBackground === 'transparent' ? 'png' : config.seedreamOutputFormat ?? 'jpeg',
          watermark: config.seedreamWatermark ?? true,
          background: seedreamBackground,
        },
      }
    }
    case 'dashscope': return { provider: 'dashscope', apiKeyEnv: DASHSCOPE_API_KEY_ENV, model: config.dashscopeModel ?? DEFAULT_DASHSCOPE_MODEL, endpoint: config.dashscopeEndpoint ?? DEFAULT_DASHSCOPE_ENDPOINT, imageSize: '1024*1024' }
    case 'xai': return { provider: 'xai', apiKeyEnv: XAI_API_KEY_ENV, model: config.xaiModel ?? DEFAULT_XAI_MODEL, baseURL: config.xaiBaseURL ?? DEFAULT_XAI_BASE_URL, imageSize: '1024x1024' }
    case 'zhipu': return { provider: 'zhipu', apiKeyEnv: ZHIPU_API_KEY_ENV, model: config.zhipuModel ?? DEFAULT_ZHIPU_MODEL, baseURL: config.zhipuBaseURL ?? DEFAULT_ZHIPU_BASE_URL, imageSize: '1024x1024' }
    case 'comfyui': {
      const workflows = resolveComfyUIWorkflows(config)
      const workflow = activeComfyUIWorkflow(config)
      return {
        provider: 'comfyui',
        baseURL: config.comfyuiBaseURL ?? DEFAULT_COMFYUI_BASE_URL,
        workflows,
        ...(workflow === undefined ? {} : { workflow }),
        timeoutMs: config.comfyuiTimeoutMs ?? DEFAULT_COMFYUI_TIMEOUT_MS,
      }
    }
    case 'chatgpt-sub': return { provider: 'chatgpt-sub', model: DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'] }
    case 'grok-sub': return { provider: 'grok-sub', model: DEFAULT_SUBSCRIPTION_MODELS['grok-sub'] }
    case 'google-sub': return { provider: 'google-sub', model: DEFAULT_SUBSCRIPTION_MODELS['google-sub'] }
    case 'google': return { provider: 'google', apiKeyEnv: GOOGLE_API_KEY_ENV, model: config.googleModel ?? DEFAULT_GOOGLE_MODEL, endpoint: config.googleEndpoint ?? DEFAULT_GOOGLE_ENDPOINT, native: config.googleNative === true, aspectRatio: '1:1', imageSize: '1K' }
  }
}

/** Project one named relay channel onto the legacy flat fields used by all provider adapters. */
export function withOpenAICompatChannel(config: Config, channelId?: string): Config {
  const channel = resolveOpenAICompatChannel(config, channelId)
  if (channel.id === 'default') return { ...config, openaiCompatActiveChannel: 'default' }
  return {
    ...config,
    openaiCompatLabel: channel.label,
    openaiCompatBaseURL: channel.baseURL,
    openaiCompatModel: channel.model,
    openaiCompatModels: channel.models ?? [],
    openaiCompatEditModel: channel.editModel ?? '',
    openaiCompatQuality: channel.quality ?? '',
    openaiCompatQualityOptions: channel.qualityOptions ?? [],
    openaiCompatExtraBody: channel.extraBody ?? {},
    openaiCompatEditSizeMode: channel.editSizeMode ?? 'auto',
    openaiCompatEditFormat: channel.editFormat ?? 'multipart',
    openaiCompatEditExtra: channel.editExtra ?? {},
    openaiCompatSizes: channel.sizes ?? {},
    openaiCompatActiveChannel: channel.id,
  }
}

/**
 * Apply a per-call provider and/or model override on top of the saved config.
 * `model` is ignored for ComfyUI, whose per-call equivalent is `workflow`.
 */
export function withProviderOverrides(config: Config, provider?: ImageProvider, model?: string, mode: 'generate' | 'edit' = 'generate'): Config {
  const base: Config = provider === undefined ? { ...config } : { ...config, provider }
  const trimmed = model?.trim() || (mode === 'edit' && base.provider === 'openai-compat' ? base.openaiCompatEditModel?.trim() : '') || ''
  if (trimmed.length === 0) return base
  switch (base.provider ?? 'google') {
    case 'google': return { ...base, googleModel: trimmed }
    case 'openai': return { ...base, openaiModel: trimmed }
    case 'openai-compat': return { ...base, openaiCompatModel: trimmed, ...(mode === 'edit' ? { openaiCompatEditModel: trimmed } : {}) }
    case 'seedream': return { ...base, seedreamModel: trimmed }
    case 'dashscope': return { ...base, dashscopeModel: trimmed }
    case 'xai': return { ...base, xaiModel: trimmed }
    case 'zhipu': return { ...base, zhipuModel: trimmed }
    // Subscription models are fixed by the bridge protocol; the override is ignored.
    case 'chatgpt-sub': return base
    case 'grok-sub': return base
    case 'google-sub': return base
    case 'comfyui': return base
  }
}

/**
 * One-time migration: when the legacy single OpenAI slot points at a relay
 * (non-official base URL) and the compat row is empty, move the relay config
 * to the compat row so both can coexist. Returns the input untouched when
 * nothing needs moving.
 */
export function migrateOpenAICompatConfig(config: Config): Config {
  const legacyBase = config.openaiBaseURL?.trim() ?? ''
  if (legacyBase.length === 0 || legacyBase === DEFAULT_OPENAI_BASE_URL) return config
  if (hostOf(legacyBase) === 'api.openai.com') return config
  if ((config.openaiCompatBaseURL?.trim() ?? '').length > 0) return config
  const compatModel = config.openaiCompatModel?.trim() ?? ''
  return {
    ...config,
    openaiCompatBaseURL: legacyBase,
    ...(compatModel.length > 0 ? {} : { openaiCompatModel: config.openaiModel }),
    ...((config.openaiCompatModels?.length ?? 0) > 0 ? {} : { openaiCompatModels: [compatModel || config.openaiModel?.trim() || ''].filter(Boolean) }),
    openaiBaseURL: DEFAULT_OPENAI_BASE_URL,
    ...(config.provider === 'openai' ? { provider: 'openai-compat' as const } : {}),
  }
}

/** Host part of a URL, or null when it cannot be parsed. */
function hostOf(raw: string): string | null {
  try {
    return new URL(raw).host
  } catch {
    return null
  }
}

/** The workflow a ComfyUI call runs: the requested name when given, else the active one. */
export function selectComfyUIWorkflow(
  active: { workflows: ComfyUIWorkflowEntry[]; workflow?: ComfyUIWorkflowEntry },
  requested?: string,
): ComfyUIWorkflowEntry {
  if (active.workflow === undefined) {
    throw new Error('ComfyUI image generation requires an imported workflow; import one in Settings > Plugins > Image generation.')
  }
  if (typeof requested !== 'string' || requested.trim().length === 0) return active.workflow
  const name = requested.trim()
  const workflow = active.workflows.find(candidate => candidate.name === name)
  if (workflow === undefined) {
    throw new Error(`No ComfyUI workflow named "${name}" is configured. Available workflows: ${active.workflows.map(entry => entry.name).join(', ')}.`)
  }
  return workflow
}
