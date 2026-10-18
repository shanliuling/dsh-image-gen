/** Same-origin connection probe the settings card runs per provider. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config, ImageProvider } from './config.js'
import { redactSecrets } from './redact.js'
import { googleModelsEndpoint } from './google.js'
import type { SubscriptionManager } from './subscription.js'
import {
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_DASHSCOPE_ENDPOINT,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_SEEDREAM_BASE_URL,
  DEFAULT_XAI_BASE_URL,
  DEFAULT_ZHIPU_BASE_URL,
  IMAGE_PROVIDERS,
  isSubscriptionProvider,
  TEST_CONNECTION_ROUTE,
  type CloudImageProvider,
} from './shared.js'

export { TEST_CONNECTION_ROUTE } from './shared.js'

const MAX_BODY_BYTES = 16 * 1024
const PROBE_TIMEOUT_MS = 10_000

/** One probe target a provider resolves to: a URL plus its auth headers. */
export interface ProbeTarget {
  url: string
  headers: Record<string, string>
}

/**
 * The endpoint each provider is probed on. All four cloud providers expose a
 * model-list GET that authenticates with the same credential image generation
 * uses; ComfyUI exposes its standard `system_stats` health endpoint.
 */
export function probeTarget(
  provider: ImageProvider,
  config: Config,
  apiKey?: string | undefined,
): ProbeTarget {
  if (provider === 'comfyui') {
    return { url: joinUrl(config.comfyuiBaseURL ?? DEFAULT_COMFYUI_BASE_URL, 'system_stats'), headers: {} }
  }
  // Subscription providers have no HTTP endpoint to probe: their "connection"
  // is the internal manager plus a logged-in account, checked by
  // probeSubscriptionConnection instead. Reaching here is a routing bug.
  if (isSubscriptionProvider(provider)) {
    throw new Error('Subscription providers are probed through the manager, not probeTarget')
  }
  if (provider === 'google') {
    return { url: googleModelsUrl(config), headers: { 'x-goog-api-key': apiKey ?? '' } }
  }
  const headers = { authorization: `Bearer ${apiKey ?? ''}` }
  if (provider === 'dashscope') {
    return { url: joinUrl(config.dashscopeEndpoint ?? DEFAULT_DASHSCOPE_ENDPOINT, 'models'), headers }
  }
  if (provider === 'seedream') {
    return { url: joinUrl(config.seedreamBaseURL ?? DEFAULT_SEEDREAM_BASE_URL, 'models'), headers }
  }
  if (provider === 'openai-compat') {
    const base = config.openaiCompatBaseURL?.trim() ?? ''
    // Never silently fall back to the official URL: probing api.openai.com with
    // a relay key would report a misleading "unauthorized".
    if (base.length === 0) throw new Error('OpenAI-compatible base URL is not configured')
    return { url: joinUrl(base, 'models'), headers }
  }
  if (provider === 'xai') {
    return { url: joinUrl(config.xaiBaseURL ?? DEFAULT_XAI_BASE_URL, 'models'), headers }
  }
  if (provider === 'zhipu') {
    return { url: joinUrl(config.zhipuBaseURL ?? DEFAULT_ZHIPU_BASE_URL, 'models'), headers }
  }
  return { url: joinUrl(config.openaiBaseURL ?? DEFAULT_OPENAI_BASE_URL, 'models'), headers }
}

/** `…/v1beta/interactions` (or any trailing path) becomes `…/v1beta/models`. */
function googleModelsUrl(config: Config): string {
  const endpoint = config.googleEndpoint
  const fallback = 'https://generativelanguage.googleapis.com/v1beta/models'
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return fallback
  return googleModelsEndpoint(endpoint, config.googleNative === true)
}

function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString()
}

/** Structured probe outcome the settings card maps onto localized text. */
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: 'missing-key' | 'unauthorized' | 'error'; message?: string }

/** Model-pull outcome: a filtered list of image-capable model ids on success. */
export type ModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'missing-key' | 'unauthorized' | 'error'; message?: string }

/** Extract bare model ids from a Google `list models` payload (`models/{id}`). */
export function parseGoogleModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const models = (payload as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string' || name.length === 0) continue
    ids.push(name.startsWith('models/') ? name.slice('models/'.length) : name)
  }
  return ids
}

/** Heuristic filter: Gemini image models carry `image`/`imagen` in the id. */
export function filterImageModelIds(ids: readonly string[]): string[] {
  return ids.filter(id => /image|imagen/i.test(id))
}

/** Narrow filter for the official OpenAI catalog: gpt-image and DALL·E families. */
export function filterOpenAIImageModelIds(ids: readonly string[]): string[] {
  return ids.filter(id => /^(gpt-image|dall-e)/i.test(id))
}

/** Broad filter for relays: common image-model id fragments across vendors. */
export function filterRelayImageModelIds(ids: readonly string[]): string[] {
  return ids.filter(id => /(^|[-_.])(image|imagen|flux|seedream|seededit|sd|sdxl|sd3|cogview|janus|wan|kolors|hunyuan-image)/i.test(id) || /^(dall-e|gpt-image)/i.test(id))
}

/** Ark catalog filter: the Seedream (generation) and SeedEdit (editing) families. */
export function filterSeedreamImageModelIds(ids: readonly string[]): string[] {
  return ids.filter(id => /seedream|seededit/i.test(id))
}

/** Zhipu catalog filter: GLM-Image and CogView families. */
export function filterZhipuImageModelIds(ids: readonly string[]): string[] {
  return ids.filter(id => /glm-image|cogview/i.test(id))
}

/** Extract model ids from an OpenAI-style `{data:[{id}]}` or xAI-style `{models:[{id}]}` payload. */
export function parseOpenAIModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const data = (payload as { data?: unknown }).data
  const models = (payload as { models?: unknown }).models
  const entries = Array.isArray(data) ? data : Array.isArray(models) ? models : undefined
  if (entries === undefined) return []
  const ids: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/**
 * Extract image-capable model ids from a DashScope native
 * `{output:{models:[{model,capabilities}]}}` payload. The `capabilities`
 * array marks image generation as `IG`; name fragments are a fallback for
 * payloads that omit the field.
 */
export function parseDashScopeImageModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const output = (payload as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) return []
  const models = (output as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const model = (entry as { model?: unknown }).model
    if (typeof model !== 'string' || model.length === 0) continue
    const capabilities = (entry as { capabilities?: unknown }).capabilities
    const imageCapable = (Array.isArray(capabilities) && capabilities.includes('IG'))
      || /wanx|qwen-image|wan2|image/i.test(model)
    if (imageCapable) ids.push(model)
  }
  return ids
}

/** Gemini list-models pagination cap; one page comfortably covers the catalog. */
const GOOGLE_MODELS_PAGE_SIZE = 1000

/** Shared HTTP outcome for probes and model pulls: a JSON payload or a classified failure. */
type ClassifiedResponse =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'unauthorized' | 'error'; message?: string }

/** Fetch with the shared timeout and classify the outcome; secrets never leave redacted. */
async function fetchClassifiedJson(
  url: string | URL,
  headers: Record<string, string>,
  apiKey: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<ClassifiedResponse> {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
    redirect: 'follow',
  }).catch((error: unknown) => {
    throw new Error(error instanceof Error ? error.message : String(error))
  })
  if (response.ok) return { ok: true, payload: await response.json().catch(() => null) }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized' }
  const text = await response.text().catch(() => '')
  return {
    ok: false,
    reason: 'error',
    message: `HTTP ${String(response.status)}${text.length > 0 ? `: ${redactSecrets(text, apiKey).slice(0, 300)}` : ''}`,
  }
}

/** Pull and filter the image-capable models from the Google endpoint. */
export async function fetchGoogleImageModels(
  config: Config,
  apiKey: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<ModelsResult> {
  if (apiKey === undefined) return { ok: false, reason: 'missing-key' }
  const url = new URL(googleModelsUrl(config))
  url.searchParams.set('pageSize', String(GOOGLE_MODELS_PAGE_SIZE))
  const result = await fetchClassifiedJson(url, { 'x-goog-api-key': apiKey }, apiKey, signal)
  if (!result.ok) return result
  return { ok: true, models: filterImageModelIds(parseGoogleModelIds(result.payload)) }
}

/** Pull and filter image-capable models from an OpenAI-compatible endpoint (official, relay, Ark, xAI, Zhipu). */
export async function fetchOpenAIImageModels(
  provider: 'openai' | 'openai-compat' | 'seedream' | 'xai' | 'zhipu',
  config: Config,
  apiKey: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<ModelsResult> {
  if (apiKey === undefined) return { ok: false, reason: 'missing-key' }
  const configured = provider === 'openai' ? config.openaiBaseURL?.trim() ?? ''
    : provider === 'openai-compat' ? config.openaiCompatBaseURL?.trim() ?? ''
    : provider === 'seedream' ? config.seedreamBaseURL?.trim() ?? ''
    : provider === 'xai' ? config.xaiBaseURL?.trim() ?? ''
    : config.zhipuBaseURL?.trim() ?? ''
  // Official rows fall back to their vendor defaults like the probe does; the
  // relay row is dead without its user-specific address.
  const fallback = provider === 'openai' ? DEFAULT_OPENAI_BASE_URL
    : provider === 'seedream' ? DEFAULT_SEEDREAM_BASE_URL
    : provider === 'xai' ? DEFAULT_XAI_BASE_URL
    : provider === 'zhipu' ? DEFAULT_ZHIPU_BASE_URL
    : ''
  const base = configured.length > 0 ? configured : fallback
  if (base.length === 0) return { ok: false, reason: 'error', message: 'Base URL is not configured' }
  // xAI exposes a dedicated image-generation model list; everyone else shares /models.
  const path = provider === 'xai' ? 'image-generation-models' : 'models'
  const result = await fetchClassifiedJson(joinUrl(base, path), { authorization: `Bearer ${apiKey}` }, apiKey, signal)
  if (!result.ok) return result
  const ids = parseOpenAIModelIds(result.payload)
  return {
    ok: true,
    models: provider === 'openai' ? filterOpenAIImageModelIds(ids)
      : provider === 'openai-compat' ? filterRelayImageModelIds(ids)
      : provider === 'seedream' ? filterSeedreamImageModelIds(ids)
      : provider === 'xai' ? ids
      : filterZhipuImageModelIds(ids),
  }
}

/** Pull and filter image-capable models from the DashScope native model list (`capabilities=IG`). */
export async function fetchDashScopeImageModels(
  config: Config,
  apiKey: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<ModelsResult> {
  if (apiKey === undefined) return { ok: false, reason: 'missing-key' }
  const configured = config.dashscopeEndpoint?.trim() ?? ''
  const base = configured.length > 0 ? configured : DEFAULT_DASHSCOPE_ENDPOINT
  const url = new URL(joinUrl(base, 'models'))
  // Ask the service to pre-filter image-generation models (IG capability) and
  // return a generous page; the parser re-checks the capability field anyway.
  url.searchParams.set('capabilities', 'IG')
  url.searchParams.set('page_no', '1')
  url.searchParams.set('page_size', '100')
  const result = await fetchClassifiedJson(url, { authorization: `Bearer ${apiKey}` }, apiKey, signal)
  if (!result.ok) return result
  return { ok: true, models: parseDashScopeImageModelIds(result.payload) }
}

/** Run one provider probe and classify the outcome; secrets never leave redacted. */
export async function probeProviderConnection(
  provider: CloudImageProvider,
  config: Config,
  apiKey: string | undefined,
  signal?: AbortSignal | undefined,
): Promise<ProbeResult> {
  if (apiKey === undefined) return { ok: false, reason: 'missing-key' }
  // The compat row is unusable without its relay address; fail loudly instead
  // of probing anything else with the relay key.
  if (provider === 'openai-compat' && (config.openaiCompatBaseURL?.trim() ?? '').length === 0) {
    return { ok: false, reason: 'error', message: 'Base URL is not configured' }
  }
  const target = probeTarget(provider, config, apiKey)
  const result = await fetchClassifiedJson(target.url, target.headers, apiKey, signal)
  return result.ok ? { ok: true } : result
}

/** Probe the local ComfyUI service without any credential. */
export async function probeComfyUIConnection(
  config: Config,
  signal?: AbortSignal | undefined,
): Promise<ProbeResult> {
  const target = probeTarget('comfyui', config)
  const response = await fetch(target.url, {
    method: 'GET',
    signal: signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
    redirect: 'follow',
  }).catch((error: unknown) => {
    throw new Error(error instanceof Error ? error.message : String(error))
  })
  if (response.ok) return { ok: true }
  return { ok: false, reason: 'error', message: `HTTP ${String(response.status)}` }
}

/**
 * Probe a subscription provider: the internal manager's login state for the
 * matching vendor. No network call and no token access; the probe reports
 * signed-in (with the account email) or signed-out guidance.
 */
export async function probeSubscriptionConnection(
  provider: 'chatgpt-sub' | 'grok-sub' | 'google-sub',
  manager: SubscriptionManager,
): Promise<ProbeResult> {
  const vendor = provider === 'chatgpt-sub' ? 'codex' : provider === 'google-sub' ? 'antigravity' : 'grok'
  const display = provider === 'chatgpt-sub' ? 'ChatGPT' : provider === 'google-sub' ? 'Google' : 'Grok'
  const status = await manager.loginStatus(vendor)
  if (status.state === 'logged-in') return { ok: true }
  if (status.state === 'logged-out') {
    return {
      ok: false,
      reason: 'missing-key',
      message: `${display} 账号未登录：请在设置卡片中点击“登录”完成授权`,
    }
  }
  return { ok: false, reason: 'error', message: '登录状态读取失败' }
}

/** Dependencies the test route needs from the plugin entry. */
export interface TestRouteDeps {
  /** The credential each cloud provider probes with, when one is stored. */
  resolveKey(provider: CloudImageProvider): Promise<string | undefined>
  /** The currently authoritative config, including unsaved defaults. */
  config(): Config
  /** The internal subscription account manager for the login-state probes. */
  subscriptionManager: SubscriptionManager
}

/** Serve the settings card's per-provider connectivity probe. */
export async function serveTestConnection(req: IncomingMessage, res: ServerResponse, deps: TestRouteDeps): Promise<void> {
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return jsonError(res, 415, 'json-required')
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return jsonError(res, 400, 'invalid-request')
  }
  const provider = record(body)?.provider
  if (typeof provider !== 'string' || !(IMAGE_PROVIDERS as readonly string[]).includes(provider)) {
    return jsonError(res, 400, 'invalid-provider')
  }
  const active = provider as ImageProvider
  const action = record(body)?.action

  if (action === 'models') {
    // Model pulling ships for every cloud provider; ComfyUI and the
    // subscription channels have no catalog to list.
    if (active === 'comfyui' || isSubscriptionProvider(active)) return jsonError(res, 400, 'models-unsupported')
    let result: ModelsResult
    try {
      const apiKey = await deps.resolveKey(active as CloudImageProvider)
      result = active === 'google'
        ? await fetchGoogleImageModels(deps.config(), apiKey)
        : active === 'dashscope'
          ? await fetchDashScopeImageModels(deps.config(), apiKey)
          : await fetchOpenAIImageModels(active as 'openai' | 'openai-compat' | 'seedream' | 'xai' | 'zhipu', deps.config(), apiKey)
    } catch (error) {
      result = { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    return json(res, 200, result)
  }

  let result: ProbeResult
  try {
    if (active === 'comfyui') {
      result = await probeComfyUIConnection(deps.config())
    } else if (isSubscriptionProvider(active)) {
      result = await probeSubscriptionConnection(active, deps.subscriptionManager)
    } else {
      const apiKey = await deps.resolveKey(active as CloudImageProvider)
      result = await probeProviderConnection(active as CloudImageProvider, deps.config(), apiKey)
    }
  } catch (error) {
    result = { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  json(res, 200, result)
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  return origin === undefined || host === undefined || origin === `http://${host}` || origin === `https://${host}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  json(res, status, { error: code })
}
