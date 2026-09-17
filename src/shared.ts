/** Values shared by the Host and browser Bundle faces. */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Browser route used by the generated-image card. */
export const IMAGE_ROUTE = '/plugins/dsh-image-gen/image'
/** Browser route used for deleting generated images and workspace files. */
export const DELETE_ROUTE = '/plugins/dsh-image-gen/delete'
/** Same-origin route used by the browser image workbench. */
export const STUDIO_ROUTE = '/plugins/dsh-image-gen/studio'
/** Same-origin route for built-in prompt inspiration metadata and images. */
export const INSPIRATION_ROUTE = '/plugins/dsh-image-gen/inspiration'
/** Browser route used for saving generated images to workspace on demand. */
export const SAVE_WORKSPACE_ROUTE = '/plugins/dsh-image-gen/save-workspace'
/** Browser route the settings card probes provider connectivity through. */
export const TEST_CONNECTION_ROUTE = '/plugins/dsh-image-gen/test'
/** Browser route the workbench infinite canvas pushes live state through. */
export const CANVAS_STATE_ROUTE = '/plugins/dsh-image-gen/canvas-state'
export const SUBSCRIPTION_LOGIN_ROUTE = '/plugins/dsh-image-gen/subscription-login'
export const SUBSCRIPTION_STATUS_ROUTE = '/plugins/dsh-image-gen/subscription-status'

/** Coarse model-facing kind of one shape on the workbench infinite canvas. */
export type CanvasNodeKind = 'image' | 'draw' | 'text' | 'note' | 'geo' | 'arrow' | 'frame' | 'other'

/** Every accepted canvas node kind, for validating untrusted pushes. */
export const CANVAS_NODE_KINDS: readonly CanvasNodeKind[] = ['image', 'draw', 'text', 'note', 'geo', 'arrow', 'frame', 'other']

/**
 * Cap on the selection identity list: the client trims `selection.items` to
 * this size and the canvas-state route rejects pushes carrying more, so the
 * two ends can never drift apart.
 */
export const CANVAS_MAX_SELECTION_ITEMS = 16

/**
 * Cap on the node inventory: the client trims `nodes` to this size and the
 * canvas-state route rejects pushes carrying more, so the two ends can never
 * drift apart. Sized to keep the model-facing digest compact.
 */
export const CANVAS_MAX_NODES = 48

/** Same shared-cap contract as CANVAS_MAX_NODES, for the selection kind list. */
export const CANVAS_MAX_SELECTION_KINDS = 8

/**
 * Cap on the generation prompt copied onto canvas image shapes and into the
 * model-facing summaries. The landing path truncates to this and the
 * canvas-state route rejects longer values, so the two ends can never drift.
 * The gallery keeps the full prompt; this is only the canvas-side digest view.
 */
export const CANVAS_MAX_PROMPT_CHARS = 120

/** One shape on the workbench infinite canvas, summarized for the model. */
export interface CanvasNodeSummary {
  kind: CanvasNodeKind
  /** Gallery id when the shape is a generated image landed from the bus. */
  galleryId?: string
  /** Conversation attachment id for generated images; edit_image can target it directly. */
  attachmentId?: string
  /** Human-facing label: image name, geo variant, or similar. */
  name?: string
  width?: number
  height?: number
  /** Short text preview for text-bearing shapes. */
  text?: string
  /**
   * Truncated generation prompt for landed generated images: the model can
   * reproduce or precisely vary a canvas image instead of guessing from pixels.
   */
  prompt?: string
  /** Provider id (e.g. "google") the landed image was generated with. */
  provider?: string
  /** Model (or ComfyUI workflow label) the landed image was generated with. */
  model?: string
}

/** What is currently selected on the canvas. */
export interface CanvasSelectionSummary {
  count: number
  kinds: readonly CanvasNodeKind[]
  /**
   * Capped identity list of the selected shapes, using the same summary shape
   * as canvas nodes: the model learns WHICH images or strokes are selected
   * (name, attachment id, dimensions), not just how many. Without this, two
   * selections of the same size and kind are indistinguishable.
   */
  items?: readonly CanvasNodeSummary[]
}

/**
 * One live state push from a browser tldraw instance of the workbench canvas.
 * The browser owns the canvas; the host keeps only this compact mirror, so
 * the conversation agent can reason about (and look at) what the user sees.
 */
export interface CanvasStatePush {
  /** Tldraw editor id; distinguishes simultaneously mounted canvases. */
  clientInstance: string
  /** False on the final push right before a canvas unmounts. */
  connected: boolean
  /** Total shape count on the current page (the node list may be capped). */
  nodeCount: number
  /** Capped shape inventory, capped client-side before transport. */
  nodes?: readonly CanvasNodeSummary[]
  selection?: CanvasSelectionSummary
  /**
   * PNG data-URL screenshot of the current selection, pushed whenever a
   * selection settles. It shows the selection as it looks on the canvas —
   * including annotations drawn over generated images — so the model sees the
   * live canvas state, not just the original conversation attachment.
   */
  selectionImage?: string
  updatedAt: number
}

/** Namespace persisted through DSH Settings. */
export const IMAGE_GENERATION_NAMESPACE = 'image-generation'

/** Supported providers. */
export const IMAGE_PROVIDERS = ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'] as const
export type ImageProvider = typeof IMAGE_PROVIDERS[number]

/**
 * Providers that generate through a logged-in subscription account instead
 * of an API key. They use no credential reference and never join the
 * cloud/BYOK sets.
 */
export const SUBSCRIPTION_PROVIDERS = ['chatgpt-sub', 'grok-sub', 'google-sub'] as const
export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number]

/** True when the provider generates through a logged-in subscription account. */
export function isSubscriptionProvider(provider: ImageProvider): provider is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider)
}

/** Providers supported by the first browser workbench release. */
export const CLOUD_IMAGE_PROVIDERS = ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu'] as const
export type CloudImageProvider = typeof CLOUD_IMAGE_PROVIDERS[number]

/**
 * Providers the browser workbench can drive: the BYOK cloud set plus the
 * logged-in subscription channels. ComfyUI stays out; it has its own workflow
 * pipeline and no shared request shape.
 */
export const STUDIO_PROVIDERS = [...CLOUD_IMAGE_PROVIDERS, ...SUBSCRIPTION_PROVIDERS] as const
export type StudioProvider = CloudImageProvider | SubscriptionProvider

/** True when the provider is selectable in the browser workbench. */
export function isStudioProvider(provider: ImageProvider): provider is StudioProvider {
  return (STUDIO_PROVIDERS as readonly string[]).includes(provider)
}

/** Timeout for one subscription image call, shared by the tool path and the
 * studio route so neither drifts from the other. */
export const SUBSCRIPTION_TIMEOUT_MS = 300_000

/**
 * Credential references resolved through the DSH Credentials service (BYOK).
 * These are POSIX-style reference names, not environment variables: the host
 * layers the process environment and its managed store behind them, so a name
 * like OPENAI_API_KEY is shared with any other plugin resolving the same ref.
 */
export const GOOGLE_API_KEY_ENV = 'GEMINI_API_KEY'
/** OpenAI Platform credential reference. */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY'
/**
 * OpenAI-compatible relay credential reference. Deliberately distinct from
 * OPENAI_API_KEY so an official key and a relay key can coexist without
 * overwriting each other.
 */
export const OPENAI_COMPAT_API_KEY_ENV = 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY'
/** Volcengine Ark credential reference. */
export const SEEDREAM_API_KEY_ENV = 'ARK_API_KEY'
/** DashScope credential reference. */
export const DASHSCOPE_API_KEY_ENV = 'DASHSCOPE_API_KEY'
/** xAI credential reference; matches the official xAI SDK environment name. */
export const XAI_API_KEY_ENV = 'XAI_API_KEY'
/** Zhipu credential reference; matches the official Zhipu SDK environment name. */
export const ZHIPU_API_KEY_ENV = 'ZHIPUAI_API_KEY'

/** The credential reference each cloud provider's API key is stored under. */
export const CLOUD_CREDENTIAL_REFS: Record<CloudImageProvider, string> = {
  google: GOOGLE_API_KEY_ENV,
  openai: OPENAI_API_KEY_ENV,
  'openai-compat': OPENAI_COMPAT_API_KEY_ENV,
  seedream: SEEDREAM_API_KEY_ENV,
  dashscope: DASHSCOPE_API_KEY_ENV,
  xai: XAI_API_KEY_ENV,
  zhipu: ZHIPU_API_KEY_ENV,
}

/** The credential reference storing this provider's API key, when it uses one. */
export function cloudCredentialRef(provider: ImageProvider): string | undefined {
  return (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(provider)
    ? CLOUD_CREDENTIAL_REFS[provider as CloudImageProvider]
    : undefined
}

/** Locale-neutral provider names for user-facing errors and status lines. */
export const PROVIDER_DISPLAY_NAMES: Record<ImageProvider, string> = {
  google: 'Google Gemini',
  openai: 'OpenAI',
  'openai-compat': 'OpenAI 兼容',
  seedream: 'Seedream',
  dashscope: 'DashScope',
  xai: 'xAI Grok',
  zhipu: '智谱 GLM',
  comfyui: 'ComfyUI',
  'chatgpt-sub': 'ChatGPT 订阅',
  'grok-sub': 'Grok 订阅',
  'google-sub': 'Google 订阅',
}

/** Display names for the subscription providers, separate from the BYOK table. */
export const SUBSCRIPTION_PROVIDER_DISPLAY_NAMES: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'ChatGPT 订阅',
  'grok-sub': 'Grok 订阅',
  'google-sub': 'Google 订阅',
}

/** One selectable output option exposed by a provider profile. */
export interface StudioOption {
  value: string
  label: string
}

/** Browser-safe provider description. Credentials and endpoints never cross this boundary. */
export interface StudioProviderProfile {
  provider: StudioProvider
  label: string
  model: string
  configured: boolean
  supportsEditing: boolean
  ratioOptions: StudioOption[]
  qualityOptions: StudioOption[]
  defaultRatio: string
  defaultQuality: string
}

/** Lightweight workspace description exposed to the client for scoping. */
export interface StudioWorkspaceInfo {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

/** Read model and capability state for the workbench without exposing secrets. */
export interface StudioConfigResponse {
  providers: StudioProviderProfile[]
  activeProvider: StudioProvider
  workspaceRoot?: string | undefined
  workspaces?: StudioWorkspaceInfo[] | undefined
}

/** A browser-uploaded reference image used for one editing request. */
export interface StudioEncodedReference {
  mediaType: ImageMediaType
  data: string
  name?: string
}

/** A durable image reference selected from the existing gallery. */
export interface StudioAttachmentReference {
  attachment: ImageAttachmentRef
}

export type StudioReference = StudioEncodedReference | StudioAttachmentReference

/** One browser workbench generation or editing request. */
export interface StudioGenerateRequest {
  mode: 'generate' | 'edit'
  provider: StudioProvider
  model: string
  prompt: string
  ratio: string
  quality: string
  reference?: StudioReference
  references?: StudioReference[]
  count?: number | undefined
  workspaceRoot?: string | undefined
}

/** One individual generated image item in a workbench batch. */
export interface StudioGeneratedItem {
  attachment: ImageAttachmentRef
  output: string
  savedTo?: string | undefined
}

/** One completed workbench request. */
export interface StudioGenerateResponse extends StudioGeneratedItem {
  provider: StudioProvider
  model: string
  prompt: string
  createdAt: number
  elapsedMs: number
  items?: StudioGeneratedItem[] | undefined
  requestedCount?: number | undefined
  failedCount?: number | undefined
  errors?: Array<{ index: number; message: string }> | undefined
}

/** Default endpoints and base URLs. */
export const DEFAULT_GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_SEEDREAM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
export const DEFAULT_DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1'
export const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1'
export const DEFAULT_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188'
export const DEFAULT_COMFYUI_TIMEOUT_MS = 300_000
export const DEFAULT_COMFYUI_WORKFLOW_LABEL = 'API workflow'
export const MAX_COMFYUI_WORKFLOW_BYTES = 5 * 1024 * 1024

/** Content types Ark's Seedream endpoint can return. */
export const ARK_OUTPUT_FORMATS = ['png', 'jpeg'] as const
/** Whether Ark stamps an "AI generated" watermark on the result. */
export const ARK_BACKGROUND_MODES = ['opaque', 'transparent'] as const
export type ArkOutputFormat = typeof ARK_OUTPUT_FORMATS[number]
export type ArkBackgroundMode = typeof ARK_BACKGROUND_MODES[number]

/**
 * Ark (Seedream) output controls, shared by the generate and edit paths.
 *
 * Every field mirrors an Ark request-body field of the same meaning, and every
 * default below reproduces Ark's own default — so an untouched configuration
 * sends exactly what it sent before these options existed.
 */
export interface ArkOutputOptions {
  /** `output_format`. Ark defaults to `jpeg`; `png` is lossless and keeps an alpha channel. */
  outputFormat?: ArkOutputFormat
  /** `watermark`. Ark defaults to `true`, which bakes an "AI generated" mark into the image. */
  watermark?: boolean
  /** `background`. Ark defaults to `opaque`. */
  background?: ArkBackgroundMode
}

/**
 * Map the Ark output controls onto request-body fields.
 *
 * `background` is opt-in per call site because Ark restricts `transparent` to
 * image-to-image with a single alpha-bearing reference and rejects the whole
 * request otherwise:
 *
 *   text-to-image + transparent → 400 InvalidParameter
 *     "transparent background requires exactly one input image"
 *
 * So the generation endpoint must never carry it, and that caller passes
 * `{ background: false }`. `background: opaque` is never emitted anywhere: it
 * is already Ark's default, so sending it would change nothing while adding a
 * field only the edit path can act on.
 */
export function arkOutputBody(
  options: ArkOutputOptions | undefined,
  { background = true }: { background?: boolean } = {},
): Record<string, unknown> {
  if (options === undefined) return {}
  const body: Record<string, unknown> = {}
  if (options.outputFormat !== undefined) body.output_format = options.outputFormat
  if (options.watermark !== undefined) body.watermark = options.watermark
  if (background && options.background === 'transparent') body.background = 'transparent'
  return body
}

/** Default model names. */
export const DEFAULT_GOOGLE_MODEL = 'gemini-3.1-flash-image'
export const DEFAULT_OPENAI_MODEL = 'gpt-image-2'
export const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-260128'
export const DEFAULT_DASHSCOPE_MODEL = 'qwen-image-3.0'
export const DEFAULT_XAI_MODEL = 'grok-imagine-image'
export const DEFAULT_ZHIPU_MODEL = 'glm-image'

/** One named ComfyUI API-format workflow imported through settings. */
export interface ComfyUIWorkflowEntry {
  /** Unique human-readable label; used as the result model and by tool calls. */
  name: string
  /** API-format workflow JSON with {{prompt}} / {{seed}} and optional {{image}} placeholders. */
  json: string
  /** Optional preset prepended to the user prompt on every call of this workflow. */
  presetPrompt?: string
}

/** Raw ComfyUI workflow fields as persisted through DSH Settings. */
export interface ComfyUIWorkflowSource {
  /** Named workflows managed by the Web settings page. */
  comfyuiWorkflows?: readonly ComfyUIWorkflowEntry[]
  /** Name of the entry ComfyUI calls use by default. */
  comfyuiActiveWorkflow?: string
  /** Legacy single-workflow storage; synced to the active entry for downgrades. */
  comfyuiWorkflowJson?: string
  comfyuiWorkflowName?: string
}

/** Named workflows, falling back to the legacy single-workflow fields when the list is empty. */
export function resolveComfyUIWorkflows(source: ComfyUIWorkflowSource): ComfyUIWorkflowEntry[] {
  const named: ComfyUIWorkflowEntry[] = []
  for (const entry of source.comfyuiWorkflows ?? []) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const json = typeof entry?.json === 'string' ? entry.json : ''
    if (name.length > 0 && json.trim().length > 0) {
      const presetPrompt = typeof entry.presetPrompt === 'string' ? entry.presetPrompt.trim() : ''
      named.push(presetPrompt.length > 0 ? { name, json, presetPrompt } : { name, json })
    }
  }
  if (named.length > 0) return named
  const legacyJson = typeof source.comfyuiWorkflowJson === 'string' ? source.comfyuiWorkflowJson : ''
  if (legacyJson.trim().length === 0) return []
  const legacyName = typeof source.comfyuiWorkflowName === 'string' ? source.comfyuiWorkflowName.trim() : ''
  return [{ name: legacyName.length > 0 ? legacyName : DEFAULT_COMFYUI_WORKFLOW_LABEL, json: legacyJson }]
}

/** The workflow ComfyUI calls use by default: the configured active name, else the first entry. */
export function activeComfyUIWorkflow(source: ComfyUIWorkflowSource): ComfyUIWorkflowEntry | undefined {
  const workflows = resolveComfyUIWorkflows(source)
  if (workflows.length === 0) return undefined
  const activeName = typeof source.comfyuiActiveWorkflow === 'string' ? source.comfyuiActiveWorkflow.trim() : ''
  return workflows.find(workflow => workflow.name === activeName) ?? workflows[0]
}

/** Derive a workflow label that does not collide with the given existing names. */
export function uniqueComfyUIWorkflowName(name: string, existing: readonly string[]): string {
  const base = name.trim().length > 0 ? name.trim() : DEFAULT_COMFYUI_WORKFLOW_LABEL
  if (!existing.includes(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})`
    if (!existing.includes(candidate)) return candidate
  }
}

/**
 * Combine a workflow's preset with the user prompt: preset first, user second,
 * joined by one comma — never doubled when the preset already ends in a
 * separator, and reduced to the non-empty side when the other is blank.
 */
export function mergeComfyUIPrompt(preset: string | undefined, user: string): string {
  const presetText = typeof preset === 'string' ? preset.trim().replace(/[,;\s]+$/, '') : ''
  const userText = user.trim()
  if (presetText.length === 0) return userText
  if (userText.length === 0) return presetText
  return `${presetText}, ${userText}`
}

/** Default models for the subscription channels; fixed by the bridge protocol. */
export const DEFAULT_SUBSCRIPTION_MODELS: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'gpt-image-2.5-flare',
  'grok-sub': 'grok-imagine-image-2.0',
  'google-sub': 'gemini-3-pro-image',
}

export const DEFAULT_MODELS: Record<ImageProvider, string> = {
  google: DEFAULT_GOOGLE_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  // Relays expose arbitrary model ids; there is no sensible default to offer.
  'openai-compat': '',
  seedream: DEFAULT_SEEDREAM_MODEL,
  dashscope: DEFAULT_DASHSCOPE_MODEL,
  xai: DEFAULT_XAI_MODEL,
  zhipu: DEFAULT_ZHIPU_MODEL,
  comfyui: DEFAULT_COMFYUI_WORKFLOW_LABEL,
  'chatgpt-sub': DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
  'grok-sub': DEFAULT_SUBSCRIPTION_MODELS['grok-sub'],
  'google-sub': DEFAULT_SUBSCRIPTION_MODELS['google-sub'],
}

export const DEFAULT_BASE_URLS: Record<ImageProvider, string> = {
  google: DEFAULT_GOOGLE_ENDPOINT,
  openai: DEFAULT_OPENAI_BASE_URL,
  // Relay addresses are user-specific; empty until the compat row is filled in.
  'openai-compat': '',
  seedream: DEFAULT_SEEDREAM_BASE_URL,
  dashscope: DEFAULT_DASHSCOPE_ENDPOINT,
  xai: DEFAULT_XAI_BASE_URL,
  zhipu: DEFAULT_ZHIPU_BASE_URL,
  comfyui: DEFAULT_COMFYUI_BASE_URL,
  // Subscription channels call an in-process service, never a URL.
  'chatgpt-sub': '',
  'grok-sub': '',
  'google-sub': '',
}
