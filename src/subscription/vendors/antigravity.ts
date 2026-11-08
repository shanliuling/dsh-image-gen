/**
 * Google Antigravity (Nano Banana 2) subscription image vendor.
 *
 * Protocol adapted from opencode-antigravity-auth-remix (MIT,
 * (c) 2026 Darkstarrd-dev, based on NoeFabris/opencode-antigravity-auth):
 * Google OAuth with the Antigravity CLI's public client credentials, managed
 * project discovery via loadCodeAssist, and image generation through the
 * v1internal:streamGenerateContent endpoint. Reference:
 * dist/src/constants.js, dist/src/plugin/image.js,
 * dist/src/plugin/project.js.
 *
 * The dsh-subscriptions antigravity vendor left the OAuth client empty
 * (Google's is confidential); the remix package ships the Antigravity CLI's
 * own embedded client id/secret, which the community treats as public the
 * same way Codex CLI's and grok-cli's are.
 */
import { randomUUID } from 'node:crypto'
import { buildAuthorizeUrl, formTokenRequest, type Pkce } from '../oauth.js'
import type { SubscriptionBlob } from '../blob.js'
import { DEFAULT_SUBSCRIPTION_MODELS } from '../../shared.js'

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ')

/** Antigravity CLI's embedded OAuth client, treated as public like Codex's. */
export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_CLIENT_SECRET = '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'
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback'

/**
 * Preserve the working sandbox routes, then try ordinary daily (consumer
 * accounts) before the production compatibility fallback. A Gmail address
 * alone does not establish which backend an account can use.
 */
export const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const

/** loadCodeAssist is best supported on prod; discovery tries prod first. */
const LOAD_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
] as const

/** The image model served through this channel: Nano Banana 2. */
export const ANTIGRAVITY_IMAGE_MODEL = DEFAULT_SUBSCRIPTION_MODELS['google-sub']

/**
 * Antigravity client version carried in the browser User-Agent. Google's
 * backend routes by this: a non-Antigravity or outdated UA lands in the
 * enterprise-license check and fails with the misleading 403 #3501
 * "You do not have a valid license of this product". The official
 * auto-updater publishes the current version; changelog scrape and the
 * hardcoded fallback keep the header sane when the updater is unreachable
 * (same strategy as the reference implementation's version.js).
 */
/**
 * Oldest client version the backend still serves (#123): 2.x now gets HTTP 200
 * with a "no longer supported" text and no image. Raise it when the backend
 * asks for a newer client again.
 */
export const MIN_ANTIGRAVITY_VERSION = '3.0.0'
const ANTIGRAVITY_VERSION_FALLBACK = MIN_ANTIGRAVITY_VERSION
const VERSION_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app'
const CHANGELOG_URL = 'https://antigravity.google/changelog'
const VERSION_FETCH_TIMEOUT_MS = 5_000
const CHANGELOG_SCAN_CHARS = 5_000
const VERSION_REGEX = /\d+\.\d+\.\d+/

let antigravityVersion: string | undefined

/** Current client version: the fetched one, or the fallback until fetched. */
export function getAntigravityVersion(): string {
  // Never below the floor: the version services can lag behind it (#123).
  return antigravityVersion !== undefined && compareVersions(antigravityVersion, MIN_ANTIGRAVITY_VERSION) > 0
    ? antigravityVersion
    : ANTIGRAVITY_VERSION_FALLBACK
}

/** Numeric x.y.z comparison: negative, zero or positive like a sort comparator. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Test seam: pin the version so unit tests never depend on the network. */
export function setAntigravityVersionForTest(version: string | undefined): void {
  antigravityVersion = version
}

/** Fetch and cache the current version once; failures keep the fallback. */
export async function initAntigravityVersion(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (antigravityVersion !== undefined) return
  // The auto-updater still answers "Fixed Version: 2.0.6"; a version below the
  // floor is ignored, so the changelog (or the floor itself) decides instead.
  const usable = (version: string | undefined) => version !== undefined && compareVersions(version, MIN_ANTIGRAVITY_VERSION) >= 0 ? version : undefined
  const parsed = usable(await fetchVersionText(VERSION_URL, undefined, signal))
    ?? usable(await fetchVersionText(CHANGELOG_URL, CHANGELOG_SCAN_CHARS, signal))
  signal?.throwIfAborted()
  if (parsed !== undefined) antigravityVersion = parsed
}

async function fetchVersionText(url: string, maxChars?: number, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const timeout = AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS)
    const response = await fetch(url, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) })
    if (!response.ok) return undefined
    let text = await response.text()
    if (maxChars !== undefined) text = text.slice(0, maxChars)
    const match = text.match(VERSION_REGEX)
    return match === null ? undefined : match[0]
  } catch (error) {
    if (signal?.aborted === true) throw error
    return undefined
  }
}

/** Legacy compatibility project: not an account project or proof of entitlement. */
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc'

/** Generation timeout mirroring the reference implementation. */
const IMAGE_TIMEOUT_MS = 120_000

/** Aspect ratios the generationConfig.imageConfig accepts (gemini-3.1-flash-image). */
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const

/** Safety settings the image endpoint requires to not block benign prompts. */
const SAFETY_SETTINGS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
]

export interface AntigravityConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function antigravityConfig(): AntigravityConfig {
  return { clientId: ANTIGRAVITY_CLIENT_ID, clientSecret: ANTIGRAVITY_CLIENT_SECRET, redirectUri: ANTIGRAVITY_REDIRECT_URI }
}

export function antigravityAuthorizeUrl(cfg: AntigravityConfig, pkce: Pkce): string {
  return buildAuthorizeUrl({
    authUrl: AUTH,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    challenge: pkce.challenge,
    state: pkce.state,
    scope: SCOPE,
    // offline_access equivalent for Google: force a refresh token each login.
    extra: { access_type: 'offline', prompt: 'consent' },
  })
}

/**
 * Preserve the SDK discovery identity first. A no-project UNSUPPORTED_CLIENT
 * response can be retried with the same Antigravity identity as generation.
 */
function loadHeaders(projectId: string, identity: 'sdk' | 'antigravity'): Record<string, string> {
  return {
    'User-Agent': identity === 'antigravity' ? antigravityUserAgent() : 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify(clientMetadata(projectId)),
  }
}

function antigravityUserAgent(): string {
  const uaPlatform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${getAntigravityVersion()} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`
}

/**
 * Headers for content requests (image generation): the full Electron
 * browser User-Agent with the Antigravity client version, matching the
 * official IDE. This is the identity the license check keys on — the plain
 * SDK UA here is what produced 403 #3501 on personal accounts.
 */
function contentHeaders(projectId: string): Record<string, string> {
  return {
    'User-Agent': antigravityUserAgent(),
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify(clientMetadata(projectId)),
  }
}

function tokenBlobFromOAuth(json: Record<string, unknown>): SubscriptionBlob {
  const access = json.access_token
  const refresh = json.refresh_token
  const idToken = typeof json.id_token === 'string' ? json.id_token : ''
  return {
    accessToken: typeof access === 'string' ? access : '',
    refreshToken: typeof refresh === 'string' ? refresh : '',
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    label: '',
    email: emailFromIdToken(idToken),
    accountId: '',
  }
}

/** Decode the id_token's JWT payload for the account email (identity only). */
function emailFromIdToken(idToken: string): string {
  const parts = idToken.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : ''
  } catch {
    return ''
  }
}

export async function antigravityExchangeCode(cfg: AntigravityConfig, pkce: Pkce, code: string): Promise<SubscriptionBlob> {
  const json = await formTokenRequest(TOKEN, {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: pkce.verifier,
  }, fetch)
  const blob = tokenBlobFromOAuth(json)
  if (blob.accessToken.length === 0) throw new Error('Antigravity token endpoint returned no access token')
  return blob
}

export async function antigravityRefresh(blob: SubscriptionBlob): Promise<SubscriptionBlob> {
  const json = await formTokenRequest(TOKEN, {
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: blob.refreshToken,
  }, fetch)
  const next = tokenBlobFromOAuth(json)
  return {
    ...next,
    // Google does not always return a new refresh token; keep the old one.
    refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
    label: blob.label,
    email: blob.email.length > 0 ? blob.email : next.email,
    accountId: '',
  }
}

export interface AntigravityProjectContext {
  projectId: string
  source: 'account' | 'fallback'
  /** Bounded, redacted discovery outcomes, retained for generation failures. */
  diagnostics: string[]
}

/** Compatibility helper for callers that only need the project string. */
export async function antigravityResolveProject(blob: SubscriptionBlob, signal?: AbortSignal): Promise<string> {
  return (await antigravityResolveProjectContext(blob, signal)).projectId
}

/**
 * Discover an actual account project, preserving HTTP and eligibility failures.
 * Keep the legacy fallback for accounts whose image route still accepts it;
 * UNSUPPORTED_CLIENT here describes Code Assist, not a universal image ban.
 * Do not invoke onboarding or accept account terms during image generation.
 */
export async function antigravityResolveProjectContext(blob: SubscriptionBlob, signal?: AbortSignal): Promise<AntigravityProjectContext> {
  signal?.throwIfAborted()
  const metadata = clientMetadata('')
  const diagnostics: string[] = []
  const identityRetryEndpoints: string[] = []
  for (const identity of ['sdk', 'antigravity'] as const) {
    const endpoints = identity === 'sdk' ? LOAD_ENDPOINTS : identityRetryEndpoints
    if (identity === 'antigravity') {
      if (endpoints.length === 0) break
      await initAntigravityVersion(signal)
    }
    for (const base of endpoints) {
      signal?.throwIfAborted()
      const label = `loadCodeAssist ${new URL(base).hostname}${identity === 'antigravity' ? ` [Antigravity/${getAntigravityVersion()}]` : ''}`
      try {
        const response = await fetch(`${base}/v1internal:loadCodeAssist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${blob.accessToken}`, ...loadHeaders('', identity) },
          body: JSON.stringify({ metadata }),
          signal: signal === undefined ? AbortSignal.timeout(25_000) : AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        })
        if (!response.ok) {
          diagnostics.push(`${label}: ${httpDiagnostic(response.status, await response.text().catch(() => ''), blob)}`)
          continue
        }
        const payload = recordOf(await response.json().catch(() => null))
        if (payload === undefined) {
          diagnostics.push(`${label}: HTTP ${String(response.status)}, invalid response`)
          continue
        }
        const project = payload.cloudaicompanionProject
        const projectRecord = recordOf(project)
        const id = typeof project === 'string' ? project
          : typeof projectRecord?.id === 'string' ? projectRecord.id
          : ''
        if (id.trim().length > 0) return { projectId: id.trim(), source: 'account', diagnostics }
        diagnostics.push(`${label}: HTTP ${String(response.status)}, ${missingProjectDiagnostic(payload, blob)}`)
        if (identity === 'sdk' && Array.isArray(payload.ineligibleTiers)
          && payload.ineligibleTiers.some(tier => recordOf(tier)?.reasonCode === 'UNSUPPORTED_CLIENT')) {
          identityRetryEndpoints.push(base)
        }
      } catch (error) {
        if (signal?.aborted === true) throw error
        diagnostics.push(`${label}: ${diagnosticText(error instanceof Error ? error.message : 'request failed', blob)}`)
      }
    }
  }
  return { projectId: DEFAULT_PROJECT_ID, source: 'fallback', diagnostics }
}

/** Google ClientMetadata.Platform enum, shared by request body and headers. */
function platformOf(): string {
  if (process.platform === 'win32' && process.arch === 'x64') return 'WINDOWS_AMD64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'DARWIN_AMD64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'DARWIN_ARM64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'LINUX_AMD64'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'LINUX_ARM64'
  return 'PLATFORM_UNSPECIFIED'
}

function clientMetadata(projectId: string): Record<string, string> {
  return { ideType: 'ANTIGRAVITY', platform: platformOf(), pluginType: 'GEMINI', ...(projectId.length > 0 ? { duetProject: projectId } : {}) }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Upstream errors may echo request identity; redact before bounding the text. */
function diagnosticText(value: unknown, blob: SubscriptionBlob): string {
  let text = typeof value === 'string' ? value : ''
  for (const secret of [blob.accessToken, blob.refreshToken, blob.accountId, blob.email]) {
    if (secret.length > 0) text = text.replaceAll(secret, '[redacted]')
  }
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function httpDiagnostic(status: number, text: string, blob: SubscriptionBlob): string {
  let detail = text
  try {
    const error = recordOf(recordOf(JSON.parse(text))?.error)
    if (typeof error?.message === 'string') detail = `${typeof error.status === 'string' ? `${error.status}: ` : ''}${error.message}`
  } catch { /* Non-JSON error bodies still provide a bounded diagnostic. */ }
  const safe = diagnosticText(detail, blob)
  return `HTTP ${String(status)}${safe.length > 0 ? `: ${safe}` : ''}`
}

function missingProjectDiagnostic(payload: Record<string, unknown>, blob: SubscriptionBlob): string {
  const reasons = Array.isArray(payload.ineligibleTiers) ? payload.ineligibleTiers.flatMap(value => {
    const tier = recordOf(value)
    return typeof tier?.reasonCode === 'string' ? [`${tier.reasonCode}${typeof tier.reasonMessage === 'string' ? `: ${tier.reasonMessage}` : ''}`] : []
  }) : []
  const allowed = Array.isArray(payload.allowedTiers) ? payload.allowedTiers.flatMap(value => {
    const tier = recordOf(value)
    return typeof tier?.id === 'string' ? [tier.id] : []
  }) : []
  const current = recordOf(payload.paidTier)?.id ?? recordOf(payload.currentTier)?.id
  const detail = [...reasons, ...(typeof current === 'string' ? [`tier=${current}`] : []), ...(allowed.length > 0 ? [`allowedTiers=${allowed.join(',')}`] : [])]
  return `未返回账号项目${detail.length > 0 ? `; ${diagnosticText(detail.join('; '), blob)}` : ''}`
}

/**
 * Build the streamGenerateContent request body for one image generation.
 * Ported from the reference buildImageRequest + the wrapping envelope: no
 * tools, no systemInstruction, no thinkingConfig; responseModalities asks
 * for TEXT+IMAGE. Reference images (edits) ride along as inlineData parts
 * before the text part, mirroring the reference implementation.
 */
export function antigravityImageBody(options: {
  prompt: string
  aspectRatio?: string
  hd?: boolean
  referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }>
}): Record<string, unknown> {
  const ratio = options.aspectRatio !== undefined && (ASPECT_RATIOS as readonly string[]).includes(options.aspectRatio) ? options.aspectRatio : undefined
  // An unset aspectRatio lets the model choose (the `auto` picker option);
  // the API's own default applies. HD maps onto the documented 4K tier.
  const imageConfig: Record<string, unknown> = ratio === undefined ? {} : { aspectRatio: ratio }
  if (options.hd === true) imageConfig.imageSize = '4K'
  const parts: Array<Record<string, unknown>> = []
  for (const image of options.referenceImages ?? []) {
    parts.push({ inlineData: { mimeType: image.mediaType, data: Buffer.from(image.data).toString('base64') } })
  }
  parts.push({ text: options.prompt })
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { candidateCount: 1, imageConfig, responseModalities: ['TEXT', 'IMAGE'] },
    safetySettings: SAFETY_SETTINGS_OFF,
  }
}

/** Wrap the inner request in the Antigravity agent envelope. */
export function antigravityEnvelope(projectId: string, request: Record<string, unknown>): Record<string, unknown> {
  return {
    project: projectId,
    model: ANTIGRAVITY_IMAGE_MODEL,
    userAgent: 'antigravity',
    requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    requestType: 'agent',
    request: { ...request, session_id: `sess-${randomUUID()}` },
  }
}

export interface AntigravityImageResult {
  b64: string
  mimeType: string
  text?: string
}

/**
 * Generate one image on the logged-in Antigravity account: resolve the
 * project, POST the wrapped body to each endpoint in fallback order, and
 * parse the SSE stream for the inlineData image part.
 */
export async function antigravityGenerateImage(options: {
  blob: SubscriptionBlob
  projectId: string
  projectContext?: AntigravityProjectContext
  prompt: string
  aspectRatio?: string
  hd?: boolean
  referenceImages?: ReadonlyArray<{ data: Uint8Array; mediaType: string }>
  signal?: AbortSignal
}): Promise<AntigravityImageResult> {
  options.signal?.throwIfAborted()
  // Content requests carry the browser UA with the client version, which the
  // license check keys on; warm the fetched version before building headers.
  await initAntigravityVersion(options.signal)
  const inner = antigravityImageBody({
    prompt: options.prompt,
    ...(options.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
    ...(options.hd !== undefined ? { hd: options.hd } : {}),
    ...(options.referenceImages !== undefined ? { referenceImages: options.referenceImages } : {}),
  })
  const body = antigravityEnvelope(options.projectId, inner)
  const failures: string[] = []
  for (const base of ANTIGRAVITY_ENDPOINTS) {
    const url = `${base}/v1internal:streamGenerateContent?alt=sse`
    const timeoutSignal = AbortSignal.timeout(IMAGE_TIMEOUT_MS)
    const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...contentHeaders(options.projectId),
          Authorization: `Bearer ${options.blob.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        failures.push(`${new URL(base).hostname}: ${httpDiagnostic(response.status, text, options.blob)}`)
        continue
      }
      const text = await response.text()
      const parsed = parseSseImage(text)
      if (parsed !== undefined) return parsed
      // Endpoint answered but with no image; remember why and try the next.
      const reason = parseSseError(text)
      // A text-only answer says why (e.g. "This version of Antigravity is no longer supported").
      const said = reason === undefined ? parseSseText(text) : undefined
      failures.push(`${new URL(base).hostname}: ${diagnosticText(reason ?? (said === undefined ? 'response contained no image' : `returned text instead of an image: ${said.slice(0, 200)}`), options.blob)}`)
      continue
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      failures.push(`${new URL(base).hostname}: ${diagnosticText(error instanceof Error ? error.message : 'request failed', options.blob)}`)
      continue
    }
  }
  const discovery = options.projectContext?.source === 'fallback'
    ? ['项目发现未返回账号项目，已尝试兼容项目。', ...options.projectContext.diagnostics]
    : []
  throw new Error(`antigravity image generation failed: ${[...discovery, ...failures].join(' | ')}`)
}

/** Scan an SSE body for the first image part in any data: line. */
function parseSseImage(text: string): AntigravityImageResult | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice('data: '.length).trim()
    if (raw.length === 0 || raw === '[DONE]') continue
    try {
      const data = JSON.parse(raw) as { response?: { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> } }
      for (const candidate of data.response?.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const inline = part.inlineData
          if (typeof inline?.data === 'string' && inline.data.length > 0 && typeof inline.mimeType === 'string' && inline.mimeType.startsWith('image/')) {
            return { b64: inline.data, mimeType: inline.mimeType }
          }
        }
      }
    } catch {
      // skip unparseable lines
    }
  }
  return undefined
}

/** The text parts of an SSE body, for a response that carried no image. */
function parseSseText(text: string): string | undefined {
  const pieces: string[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice('data: '.length).trim()
    if (raw.length === 0 || raw === '[DONE]') continue
    try {
      const data = JSON.parse(raw) as { response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> } }
      for (const candidate of data.response?.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) if (typeof part.text === 'string') pieces.push(part.text)
      }
    } catch {
      // skip
    }
  }
  const joined = pieces.join('').replace(/\s+/g, ' ').trim()
  return joined.length > 0 ? joined : undefined
}

/** Pull the first error block an SSE body reports, for better messages. */
function parseSseError(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice('data: '.length).trim()
    if (raw.length === 0 || raw === '[DONE]') continue
    try {
      const data = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } }
      if (data.error !== undefined) {
        const code = typeof data.error.code === 'string' || typeof data.error.code === 'number' ? String(data.error.code) : ''
        const message = typeof data.error.message === 'string' ? data.error.message : ''
        const joined = `${code.length > 0 ? `${code}: ` : ''}${message}`.trim()
        if (joined.length > 0) return joined
      }
    } catch {
      // skip
    }
  }
  return undefined
}
