// Must stay the first import: it shims CSS.supports before tldraw's
// module-scope environment probe runs (#40); see css-supports-shim.ts.
import './tl/css-supports-shim.js'
import { installDatalistScrollFix } from './datalist-scroll-fix.js'
import { compatEditFormat } from '../watermark.js'
import { useEffect, useState, useRef, type ChangeEvent, type FormEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { fetchSettingsHealth, settingsState, type SettingsScopeSnapshot, type SettingsState } from './settings-state.js'
import type { SettingsHealth } from '../shared.js'
export type { SettingsScopeSnapshot } from './settings-state.js'
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  /** New hosts return true/false; legacy settings scopes resolve to void. */
  set(field: string, value: unknown): Promise<boolean | void>
}
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import {
  CLOUD_CREDENTIAL_REFS,
  CLOUD_IMAGE_PROVIDERS,
  DEFAULT_BASE_URLS,
  DEFAULT_CLOUD_TIMEOUT_MS,
  DEFAULT_COMFYUI_TIMEOUT_MS,
  DEFAULT_MODELS,
  IMAGE_GENERATION_ENTRY_ID,
  IMAGE_GENERATION_NAMESPACE,
  IMAGE_PROVIDERS,
  IMAGE_ROUTE,
  MAX_COMFYUI_WORKFLOW_BYTES,
  STUDIO_ROUTE,
  SUBSCRIPTION_LOGIN_ROUTE,
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_STATUS_ROUTE,
  TEST_CONNECTION_ROUTE,
  activeComfyUIWorkflow,
  cloudCredentialRef,
  isSubscriptionProvider,
  openAICompatKeyRef,
  resolveComfyUIWorkflows,
  resolveOpenAICompatChannels,
  resolveOpenAICompatModels,
  uniqueComfyUIWorkflowName,
  type CloudImageProvider,
  type ComfyUIWorkflowEntry,
  type OpenAICompatChannel,
  type ImageProvider,
  type StudioGenerateResponse,
  type SubscriptionProvider,
} from '../shared.js'
import { validateComfyUIWorkflowJson } from '../comfyui-workflow.js'
import { saveGalleryItem } from './gallery-store.js'
import { GalleryViewTab, type GalleryViewTabProps, type LocaleService } from './gallery-view.js'
import { GeneratedImageCard, GeneratedImagesCard, PromotedImageResultNode, type ImageCardFace } from './image-result-view.js'
export { GeneratedImageCard, GeneratedImagesCard, PromotedImageResultNode } from './image-result-view.js'
import { DICT, type DictKey } from './plugin-i18n.js'
import { PLUGIN_STYLE } from './plugin-style.js'
import { createCanvasSessionSelection, startConversationLandings, type CanvasSessions, type CanvasSessionSelection } from './tl/conversation-landings.js'
import { STUDIO_STYLE } from './studio-style.js'
import { TL_CSS } from './tl/tl-css.js'
import { TL_THEME_CSS } from './tl/tl-theme-css.js'
import { INSPIRATION_STYLE } from './inspiration-style.js'
import {
  IMAGE_RESULT_NODE_KIND,
  createImageResultDefinition,
} from './image-result-node.js'
import { conversationRegenerateRequest } from './conversation-regenerate.js'
import { parseExtraFields, parseSizeTable } from './output-settings.js'
import { DEFAULT_COMPAT_QUALITIES, validateOfficialSize } from '../openai-output.js'
import { ImageProviderPill, PROVIDER_PILL_STYLE, type ProviderPillFace } from './provider-pill.js'
import { writeSetting } from './settings-write.js'

/** Build timestamp injected by tsdown at bundle time. */
declare const __CANVAS_BUILD_TS__: string

// Convention: the canvas bundle announces its build timestamp on load, so a
// stale host webview cache is provable from the browser console. The typeof
// guard keeps the module importable where the define is absent (vitest).
if (typeof __CANVAS_BUILD_TS__ !== 'undefined') {
  console.info(`[dsh-image-gen] canvas bundle ${__CANVAS_BUILD_TS__}`)
}

type Provider = ImageProvider
type ProviderRowTarget = Provider | `openai-compat:${string}`
type ProviderRows = Record<ProviderRowTarget, ProviderRowState>
interface ImageSettings {
  provider?: Provider
  cloudTimeoutMs?: number
  googleModel?: string
  googleEndpoint?: string
  googleNative?: boolean
  openaiBaseURL?: string
  openaiModel?: string
  openaiSizes?: Record<string, Record<string, string>>
  openaiCompatLabel?: string
  openaiCompatBaseURL?: string
  openaiCompatModel?: string
  openaiCompatModels?: string[]
  openaiCompatChannels?: OpenAICompatChannel[]
  openaiCompatActiveChannel?: string
  openaiCompatEditModel?: string
  openaiCompatSizes?: Record<string, Record<string, string>>
  openaiCompatQuality?: string
  openaiCompatQualityOptions?: string[]
  openaiCompatExtraBody?: Record<string, unknown>
  openaiCompatEditSizeMode?: 'auto' | 'selected'
  /** Edit-request shape for the openai-compat relay (#41); see src/config.ts. */
  openaiCompatEditFormat?: 'multipart' | 'jsonImageUrlArray' | 'formReferenceImages' | 'siliconflowJson'
  /** Extra JSON fields merged into the JSON edit body; ignored in multipart mode. */
  openaiCompatEditExtra?: Record<string, unknown>
  seedreamBaseURL?: string
  seedreamModel?: string
  /** Ark `output_format`; `png` is lossless and keeps an alpha channel. */
  seedreamOutputFormat?: 'png' | 'jpeg'
  /** Ark `watermark`; off removes the baked-in "AI generated" mark. */
  seedreamWatermark?: boolean
  /** Ark `background`; `transparent` needs an alpha-bearing edit reference. */
  seedreamBackground?: 'opaque' | 'transparent'
  dashscopeEndpoint?: string
  dashscopeModel?: string
  xaiBaseURL?: string
  xaiModel?: string
  zhipuBaseURL?: string
  zhipuModel?: string
  comfyuiBaseURL?: string
  comfyuiWorkflows?: ComfyUIWorkflowEntry[]
  comfyuiActiveWorkflow?: string
  comfyuiWorkflowJson?: string
  comfyuiWorkflowName?: string
  comfyuiTimeoutMs?: number
  saveToWorkspace?: boolean
  workspaceFolder?: string
  showProviderPill?: boolean
}
interface CredentialInfo { configured?: boolean; source?: string; writable?: boolean }
interface CredentialResult { ok: boolean; value?: Readonly<Record<string, CredentialInfo>> }
interface CredentialMutationResult { ok: boolean; error?: { message?: string } }
interface CredentialsRemote {
  describe(refs: string[]): Promise<CredentialResult>
  set(ref: string, value: string): Promise<CredentialMutationResult>
  /** Present only on modern hosts; feature-detected before use; undefined while degraded. */
  unset?: ((ref: string) => Promise<CredentialMutationResult>) | undefined
}
type LegacyCredentialRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message?: string } }
interface LegacyCredentialsApi {
  describe(request: { refs: string[] }): Promise<{
    result: LegacyCredentialRpcResult<{ credentials: Readonly<Record<string, CredentialInfo>> }>
  }>
  set(request: { ref: string; value: string }): Promise<{
    result: LegacyCredentialRpcResult<unknown>
  }>
}
/** Notifies the settings card whenever any credential reference changes on the host. */
interface CredentialEvents { listen(callback: () => void): () => void }
interface SettingsFace {
  scope: SettingsScope<ImageSettings>
  credentials: CredentialsRemote
  /** False while the host core exposes no credentials service; the key UI degrades but the card stays mounted. */
  credentialsAvailable: () => boolean
  locale?: LocaleService | undefined
  credentialEvents?: CredentialEvents | undefined
}
type SettingsCardProps = PropsRuntime<'settings.plugins.tab'> & InjectFace<SettingsFace>
type SlotInject = (key: string, factory: () => () => void) => void

interface ModernUiConversation {
  events: { register(definition: ReturnType<typeof createImageResultDefinition>): () => void }
}

/** Right-sidebar tab-type registration id (DSH 0.1.5 `sidebarRightTabs`). */
const SIDEBAR_STUDIO_TAB_ID = 'dsh-image-gen/studio'
/** The tab kind: a page type opened by kind, recognizing no resource address. */
const SIDEBAR_STUDIO_TAB_KIND = 'dsh-image-gen-studio'
/**
 * Runtime face of DSH 0.1.5's `sidebarRightTabs` service (stage one of a
 * right-sidebar tab type's registration). Kept local and duck-typed: hosts
 * without the service never reach this code (deferred inject).
 */
interface SidebarRightTabsFace {
  register(definition: {
    id: string
    kind: string
    priority?: string
    title: (address: string) => string
    guide?: ReadonlyArray<{ order: number; title: () => string; description?: () => string }>
  }): () => void
}





/**
 * Required browser services. The settings form reader is deliberately absent:
 * DSH 0.1.7 serves it as `configForms` (keyed by the Loader entry id) while
 * 0.1.5/0.1.6 expose `settingsScope` (keyed by the legacy namespace), so it is
 * probed at runtime in `apply`. A static inject of either name would park this
 * fiber forever on hosts from the other generation — the issue #55 failure.
 */
export const inject = ['slots', 'connection', 'remote', 'locale']

/** Settings-form reader as shaped by DSH 0.1.7's `configForms` service. */
interface ConfigFormsApi {
  get<T>(id: string): SettingsScope<T>
}
/** Settings-form reader as shaped by DSH 0.1.5/0.1.6's `settingsScope` service. */
interface SettingsScopeApi {
  bind<T>(options: { namespace: string }): SettingsScope<T>
}

/** Host with neither settings generation: reads empty, writes refuse, never throws. */
function degradedScope<T>(): SettingsScope<T> {
  return {
    getSnapshot: () => ({ value: undefined, writable: false, status: 'unavailable' }),
    subscribe: () => () => {},
    set: async () => false,
  }
}

/** Mount the settings card, generated-image card, and native conversation gallery view. */
export function apply(ctx: Context): void {
  // Probe instead of inject (see `inject`): 0.1.7+ resolves `configForms`,
  // older hosts fall back to `settingsScope`, and `ctx.get` reads undefined for
  // a service the host never declared.
  const configForms = ctx.get('configForms') as ConfigFormsApi | undefined
  const settingsScopeApi = configForms === undefined
    ? ctx.get('settingsScope') as SettingsScopeApi | undefined
    : undefined
  const scope = configForms?.get<ImageSettings>(IMAGE_GENERATION_ENTRY_ID)
    ?? settingsScopeApi?.bind<ImageSettings>({ namespace: IMAGE_GENERATION_NAMESPACE })
    ?? degradedScope<ImageSettings>()
  const locale = ctx.get('locale') as LocaleService | undefined
  const promotion = { enabled: false }
  // Chromium keeps a native datalist popup at its original position while the
  // page or a panel scrolls, so close it on scroll/resize; focusing reopens it.
  installDatalistScrollFix()

  ;(ctx.inject as unknown as (services: string[], callback: (owner: Context) => void) => void)(
    ['sessions'],
    owner => {
      const sessions = owner.get('sessions') as CanvasSessions | undefined
      if (typeof sessions?.binding !== 'function' || typeof sessions.list?.subscribe !== 'function') return
      const selection = createCanvasSessionSelection()
      owner.effect(() => startConversationLandings(sessions, selection), 'dsh-image-gen: live canvas images')
      // Optional injection keeps old hosts working and also handles uiSession
      // becoming available after the session controller has already started.
      ;(owner.inject as unknown as (services: string[], callback: (uiOwner: Context) => void) => void)(['uiSession'], uiOwner => {
        const ui = uiOwner.get('uiSession') as { adapter?: { current?: CanvasSessionSelection } } | undefined
        const current = ui?.adapter?.current
        if (typeof current?.getSnapshot !== 'function' || typeof current.subscribe !== 'function') return
        uiOwner.effect(() => selection.bind(current), 'dsh-image-gen: current canvas session')
      })
    },
  )

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-image-gen'
    style.textContent = `${PLUGIN_STYLE}\n${STUDIO_STYLE}\n${INSPIRATION_STYLE}\n${PROVIDER_PILL_STYLE}\n${TL_CSS}\n${TL_THEME_CSS}`
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, 'dsh-image-gen: styles')

  // One-time cleanup: the workflow canvas tab was removed; drop its orphaned
  // IndexedDB database. Best-effort only: a missing database succeeds
  // immediately, and failures (locked/blocked) are ignored.
  if (typeof indexedDB !== 'undefined') {
    const request = indexedDB.deleteDatabase('dsh_image_gen_canvas')
    request.onerror = () => {}
    request.onblocked = () => {}
  }

  const register = ctx.slots.register.bind(ctx.slots) as unknown as (options: object, component: unknown) => () => void

  ;(ctx.inject as unknown as (services: string[], callback: (owner: Context) => void) => void)(
    ['uiConversation'],
    (owner) => {
      const uiConversation = asModernUiConversation(owner.get('uiConversation'))
      if (uiConversation === undefined) {
        throw new Error('dsh-image-gen: uiConversation has an incompatible interface')
      }
      promotion.enabled = true
      const ownerRegister = owner.slots.register.bind(owner.slots) as unknown as (options: object, component: unknown) => () => void
      owner.effect(
      () => uiConversation.events.register(createImageResultDefinition()),
      'dsh-image-gen: promoted image result node',
      )
      ;(owner.slots.inject as SlotInject)('conversation.chat.node', () => ownerRegister({
        name: 'conversation.chat.node',
        key: IMAGE_RESULT_NODE_KIND,
        inject: () => ({ locale }),
      }, PromotedImageResultNode))
    },
  )

  // 1. Settings item
  // Credential badges stay fresh: relay host reference-updated events to the settings card.
  const credentialListeners = new Set<() => void>()
  const notifyCredentialsUpdated = (): void => { for (const listener of credentialListeners) listener() }
  ctx.effect(() => {
    const remote = ctx.get('remote') as { $on?: (event: 'credentials/reference-updated', listener: () => void) => () => void } | undefined
    if (typeof remote?.$on !== 'function') return () => {}
    return remote.$on('credentials/reference-updated', notifyCredentialsUpdated)
  }, 'dsh-image-gen: credential events')
  const credentialEvents: CredentialEvents = {
    listen(callback: () => void): () => void {
      credentialListeners.add(callback)
      return () => { credentialListeners.delete(callback) }
    },
  }
  // The card lives on this plugin's own page in the Plugins manager. DSH's
  // plugins page renders the keyed list slot 'plugins.bundle.config' inside a
  // bundle's detail page — keyed by the bundle's package name — so the card is
  // one click from the plugin row it configures, and the settings rail keeps no
  // extra row or tab. The page host renders it with view: 'page' and the card
  // draws its own title, form and save controls.
  //
  // The older per-plugin seat ('settings.plugin.item', hosts <=0.1.5) stays
  // registered so one build stays reachable on every host this plugin supports;
  // a host without that slot never mounts it.
  const injectSettingsItem = (owner: Context): void => {
    const ownerRegister = owner.slots.register.bind(owner.slots) as unknown as (options: object, component: unknown) => () => void
    const injectSettingsFace = (): SettingsFace => ({ scope, credentials: credentialsProxy, credentialsAvailable, locale, credentialEvents })
    ;(owner.slots.inject as (key: string, factory: () => () => void) => void)('plugins.bundle.config', () => ownerRegister({
      name: 'plugins.bundle.config',
      // Keyed slots select by bundle package name, and this plugin ships as the
      // 'dsh-image-gen' bundle.
      key: 'dsh-image-gen',
      locale,
      inject: injectSettingsFace,
    }, ImageGenerationSettingsCard))
    ;(owner.slots.inject as (key: string, factory: () => () => void) => void)('settings.plugin.item', () => ownerRegister({
      name: 'settings.plugin.item',
      key: IMAGE_GENERATION_NAMESPACE,
      inject: injectSettingsFace,
    }, ImageGenerationSettingsCard))
  }
  // Composer tool-row pill (DSH official slot: 'conversation.input.right', the
  // seat right beside the model select): switch the default image provider
  // without leaving the chat. Writes the same 'provider' field as the card.
  const injectComposerPill = (owner: Context): void => {
    const ownerRegister = owner.slots.register.bind(owner.slots) as unknown as (options: object, component: unknown) => () => void
    ;(owner.slots.inject as (key: string, factory: () => () => void) => void)('conversation.input.right', () => ownerRegister({
      name: 'conversation.input.right',
      id: 'image-provider',
      order: 10,
      inject: (): ProviderPillFace => ({ scope, credentials: credentialsProxy, locale, credentialEvents }),
    }, ImageProviderPill))
  }
  // Credentials resolve through a mutable holder: hosts expose the service
  // synchronously (probed now) or later (deferred inject below). The card and
  // the pill mount unconditionally — a missing service degrades only the key
  // UI instead of hiding the whole card (issue #32).
  const credentialsRef: { current: CredentialsRemote | undefined } = {
    current: asCredentialsRemote(ctx.get('remote.credentials')) ?? credentialsFromLegacyConnection(ctx.get('connection')),
  }
  /** Stable delegating remote so the host-cached inject face never goes stale. */
  const credentialsProxy: CredentialsRemote = {
    describe(refs) {
      const remote = credentialsRef.current
      return remote === undefined ? Promise.resolve({ ok: false }) : remote.describe(refs)
    },
    set(ref, value) {
      const remote = credentialsRef.current
      return remote === undefined
        ? Promise.resolve({ ok: false, error: { message: 'credentials service unavailable' } })
        : remote.set(ref, value)
    },
    get unset() {
      const remote = credentialsRef.current
      return remote?.unset?.bind(remote)
    },
  }
  /** False while the host core exposes no credentials service (preview cores). */
  const credentialsAvailable = (): boolean => credentialsRef.current !== undefined
  injectSettingsItem(ctx)
  injectComposerPill(ctx)
  // Preview cores can expose the credentials service after this plugin loads:
  // adopt it late and refresh every mounted card through the shared events.
  ctx.inject(['remote.credentials'], (remoteCtx) => {
    const credentials = asCredentialsRemote(remoteCtx.get('remote.credentials'))
    if (credentials === undefined) {
      console.warn('dsh-image-gen: remote.credentials resolved with an incompatible interface; key settings stay degraded')
      return
    }
    credentialsRef.current = credentials
    notifyCredentialsUpdated()
  })

  // 2. Tool result view card in chat stream
  ctx.slots.inject('tool.call.toolview', () => register({
    name: 'tool.call.toolview',
    key: 'generate_image',
    inject: (): ImageCardFace => ({ locale, promoted: promotion.enabled }),
  }, GeneratedImageCard))
  ctx.slots.inject('tool.call.toolview', () => register({
    name: 'tool.call.toolview',
    key: 'generate_images',
    inject: (): ImageCardFace => ({ locale, promoted: promotion.enabled }),
  }, GeneratedImagesCard))
  ctx.slots.inject('tool.call.toolview', () => register({
    name: 'tool.call.toolview',
    key: 'edit_image',
    inject: (): ImageCardFace => ({ locale, promoted: promotion.enabled }),
  }, GeneratedImageCard))

  // 3. Native conversation view tab (DSH official slot: 'conversation.view')
  ;(ctx.slots.inject as SlotInject)('conversation.view', () => register({
    name: 'conversation.view',
    id: 'gallery',
    order: 20,
    label: () => {
      const active = locale?.getSnapshot?.()?.active
      return active?.startsWith('en') ? 'Gallery' : '画廊'
    },
    inject: () => ({ locale, credentialEvents }),
  }, GalleryViewTab))

  // 4. Right-sidebar studio tab (DSH 0.1.5 official `sidebar.right.pane.tab`
  // seat): the native conversation keeps the main column while the workbench -
  // tldraw infinite canvas + generate form + recent list - docks beside it in
  // the old image-details seat. Two-stage registration, exactly as
  // ui-sidebar-documentpreview does it: the type into `sidebarRightTabs`, the
  // body into the keyed seat under the definition's id. Deferred injection
  // keeps pre-0.1.5 hosts booting: without the service the seat simply never
  // appears and the conversation-view gallery tab remains the only surface.
  ;(ctx.inject as unknown as (services: string[], callback: (owner: Context) => void) => void)(
    ['sidebarRightTabs'],
    (owner) => {
      const sidebarTabs = owner.get('sidebarRightTabs') as SidebarRightTabsFace
      const sidebarTitle = (): string => {
        const active = locale?.getSnapshot?.()?.active
        return active?.startsWith('en') ? 'Image Studio' : '图像工作台'
      }
      // Stage one - the page type. The guide entry is the only one registered
      // (the shipped guide declares none), so `defaultSeed` lands every new
      // sidebar straight onto the studio tab.
      owner.effect(() => sidebarTabs.register({
        id: SIDEBAR_STUDIO_TAB_ID,
        kind: SIDEBAR_STUDIO_TAB_KIND,
        priority: 'extension',
        title: () => sidebarTitle(),
        guide: [{ order: 100, title: () => sidebarTitle() }],
      }), 'dsh-image-gen: sidebar studio tab type')
      // Stage two - the body, keyed by the definition id.
      const ownerRegister = owner.slots.register.bind(owner.slots) as unknown as (options: object, component: unknown) => () => void
      ;(owner.slots.inject as (key: string, factory: () => () => void) => void)('sidebar.right.pane.tab', () => ownerRegister({
        name: 'sidebar.right.pane.tab',
        key: SIDEBAR_STUDIO_TAB_ID,
        inject: (): GalleryViewTabProps => ({
          locale,
          credentialEvents,
          inSidebar: true,
          defaultTab: 'studio',
          initialCanvasSurface: 'infinite',
        }),
      }, GalleryViewTab))
    },
  )
}

function asModernUiConversation(value: unknown): ModernUiConversation | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const events = (value as { events?: unknown }).events
  if (events === null || typeof events !== 'object') return undefined
  return typeof (events as { register?: unknown }).register === 'function'
    ? value as ModernUiConversation
    : undefined
}

function asCredentialsRemote(value: unknown): CredentialsRemote | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<CredentialsRemote>
  return typeof candidate.describe === 'function' && typeof candidate.set === 'function'
    ? candidate as CredentialsRemote
    : undefined
}

function credentialsFromLegacyConnection(value: unknown): CredentialsRemote | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const credentials = (value as { api?: { credentials?: Partial<LegacyCredentialsApi> } }).api?.credentials
  if (credentials === undefined || typeof credentials.describe !== 'function' || typeof credentials.set !== 'function') return undefined
  const legacy = credentials as LegacyCredentialsApi
  return {
    async describe(refs) {
      const response = await legacy.describe({ refs })
      return response.result.ok
        ? { ok: true, value: response.result.value.credentials }
        : { ok: false }
    },
    async set(ref, credentialValue) {
      const response = await legacy.set({ ref, value: credentialValue })
      return response.result.ok
        ? { ok: true }
        : { ok: false, error: response.result.error }
    },
  }
}

/** Structured connectivity probe outcome returned by the test-connection route. */
interface ProbeOutcome {
  ok: boolean
  reason?: 'missing-key' | 'unauthorized' | 'error'
  message?: string
}

/** Credential badge states a provider row can render. */
type KeyStatus = 'checking' | 'configured' | 'missing' | 'unknown' | 'unavailable'

/** Per-provider editable form state; every provider row saves independently. */
interface ProviderRowState {
  expanded: boolean
  label: string
  model: string
  models: string[]
  editModel: string
  baseURL: string
  googleNative: boolean
  keyInput: string
  keyStatus: KeyStatus
  keyInfo: CredentialInfo | undefined
  testing: boolean
  testResult: ProbeOutcome | undefined
  fetchingModels: boolean
  modelOptions: string[]
  modelFetchMessage: string
  modelFetchIsError: boolean
  saving: boolean
  message: string
  messageIsError: boolean
  workflows: ComfyUIWorkflowEntry[]
  activeWorkflow: string
  timeoutSeconds: number
  /** openai-compat only: edits request shape (#41). Other rows keep the default. */
  editFormat: 'multipart' | 'jsonImageUrlArray' | 'formReferenceImages' | 'siliconflowJson'
  /** openai-compat only: extra JSON fields for the JSON edit body, as user text. */
  editExtraText: string
  sizeTableText: string
  generationQuality: string
  qualityOptionsText: string
  generateExtraText: string
  editSizeMode: 'auto' | 'selected'
  /** seedream only: Ark output controls. Other rows keep the defaults. */
  outputFormat: 'png' | 'jpeg'
  watermark: boolean
  background: 'opaque' | 'transparent'
}

function emptyProviderRow(): ProviderRowState {
  return {
    expanded: false,
    label: '',
    model: '',
    models: [],
    editModel: '',
    baseURL: '',
    googleNative: false,
    keyInput: '',
    keyStatus: 'checking',
    keyInfo: undefined,
    testing: false,
    testResult: undefined,
    fetchingModels: false,
    modelOptions: [],
    modelFetchMessage: '',
    modelFetchIsError: false,
    saving: false,
    message: '',
    messageIsError: false,
    workflows: [],
    activeWorkflow: '',
    timeoutSeconds: DEFAULT_COMFYUI_TIMEOUT_MS / 1000,
    editFormat: 'multipart',
    editExtraText: '',
    sizeTableText: '',
    generationQuality: '',
    qualityOptionsText: DEFAULT_COMPAT_QUALITIES.join(', '),
    generateExtraText: '',
    editSizeMode: 'auto',
    outputFormat: 'jpeg',
    watermark: true,
    background: 'opaque',
  }
}

/** Settings field each cloud provider persists its model under. */
const CLOUD_MODEL_FIELDS = {
  google: 'googleModel',
  openai: 'openaiModel',
  'openai-compat': 'openaiCompatModel',
  seedream: 'seedreamModel',
  dashscope: 'dashscopeModel',
  xai: 'xaiModel',
  zhipu: 'zhipuModel',
} as const satisfies Record<CloudImageProvider, keyof ImageSettings>

/** Settings field each cloud provider persists its endpoint or base URL under. */
const CLOUD_URL_FIELDS = {
  google: 'googleEndpoint',
  openai: 'openaiBaseURL',
  'openai-compat': 'openaiCompatBaseURL',
  seedream: 'seedreamBaseURL',
  dashscope: 'dashscopeEndpoint',
  xai: 'xaiBaseURL',
  zhipu: 'zhipuBaseURL',
} as const satisfies Record<CloudImageProvider, keyof ImageSettings>

/** Dictionary key of each cloud provider's endpoint hint. */
const CLOUD_HINT_KEYS = {
  google: 'endpointHintGoogle',
  openai: 'endpointHintOpenAI',
  'openai-compat': 'endpointHintOpenAICompat',
  seedream: 'endpointHintSeedream',
  dashscope: 'endpointHintDashScope',
  xai: 'endpointHintXAI',
  zhipu: 'endpointHintZhipu',
} as const satisfies Record<CloudImageProvider, DictKey>

/** Config field a cloud provider persists its model under. */
function modelFieldOf(provider: CloudImageProvider): string {
  return CLOUD_MODEL_FIELDS[provider]
}

/** Config field a cloud provider persists its endpoint or base URL under. */
function baseURLFieldOf(provider: CloudImageProvider): string {
  return CLOUD_URL_FIELDS[provider]
}

/** Providers whose settings row offers the "pull models" button. */
function modelPullSupported(_provider: CloudImageProvider): boolean {
  // Every cloud provider ships a model pull; ComfyUI rows never reach here.
  return true
}

/** Serialize the extra-fields record into editor text; empty record becomes ''. */
function editExtraTextOf(value: Record<string, unknown> | undefined): string {
  if (value === undefined || Object.keys(value).length === 0) return ''
  try { return JSON.stringify(value) } catch { return '' }
}

/** Persisted or selected edit-format value → row state; unknown values fall back to standard multipart. */
function parseEditFormat(value: string | undefined): ProviderRowState['editFormat'] {
  return value === 'jsonImageUrlArray' || value === 'formReferenceImages' || value === 'siliconflowJson' ? value : 'multipart'
}

function compatChannelRowKey(channelId: string): `openai-compat:${string}` {
  return `openai-compat:${channelId}`
}

function compatRowFields(channel: OpenAICompatChannel): Partial<ProviderRowState> {
  return {
    label: channel.label,
    model: channel.model,
    models: resolveOpenAICompatModels({ openaiCompatModel: channel.model, openaiCompatModels: channel.models ?? [] }),
    editModel: channel.editModel ?? '',
    baseURL: channel.baseURL,
    editFormat: parseEditFormat(channel.editFormat),
    editExtraText: editExtraTextOf(channel.editExtra),
    sizeTableText: editExtraTextOf(channel.sizes),
    generationQuality: channel.quality ?? '',
    qualityOptionsText: (channel.qualityOptions !== undefined && channel.qualityOptions.length > 0 ? channel.qualityOptions : DEFAULT_COMPAT_QUALITIES).join(', '),
    generateExtraText: editExtraTextOf(channel.extraBody),
    editSizeMode: channel.editSizeMode === 'selected' ? 'selected' : 'auto',
  }
}

/** Build one row per provider from persisted settings, including ComfyUI extras. */
function rowsFromSettings(value: ImageSettings | undefined): ProviderRows {
  const rows = {} as ProviderRows
  for (const provider of IMAGE_PROVIDERS) {
    rows[provider] = {
      ...emptyProviderRow(),
      model: modelOf(provider, value),
      baseURL: baseURLOf(provider, value),
      ...(provider === 'google' ? { googleNative: value?.googleNative === true } : {}),
      ...(provider === 'openai' ? { sizeTableText: editExtraTextOf(value?.openaiSizes) } : {}),
      ...(provider === 'comfyui' ? {
        workflows: resolveComfyUIWorkflows(value ?? {}),
        activeWorkflow: activeComfyUIWorkflow(value ?? {})?.name ?? '',
        timeoutSeconds: Math.max(1, Math.round((value?.comfyuiTimeoutMs ?? DEFAULT_COMFYUI_TIMEOUT_MS) / 1000)),
      } : {}),
      ...(provider === 'openai-compat' ? compatRowFields(resolveOpenAICompatChannels(value ?? {})[0]!) : {}),
      ...(provider === 'seedream' ? {
        outputFormat: value?.seedreamOutputFormat === 'png' ? 'png' : 'jpeg',
        watermark: value?.seedreamWatermark !== false,
        background: value?.seedreamBackground === 'transparent' ? 'transparent' : 'opaque',
      } : {}),
    }
  }
  for (const channel of resolveOpenAICompatChannels(value ?? {}).slice(1)) {
    rows[compatChannelRowKey(channel.id)] = { ...emptyProviderRow(), ...compatRowFields(channel) }
  }
  return rows
}

/** Edit each provider independently, pick an explicit default, and verify keys inline. */
export function ImageGenerationSettingsCard(props: SettingsCardProps) {
  // Always open: DSH renders this card inside the plugin's own page, so the
  // old click-to-expand header (and the card chrome around the fields) is gone
  // — the fields sit directly on the page. `open` stays as the flag the
  // health/login effects gate on, and is now simply always true.
  const [open] = useState(true)
  const [snapshot, setSnapshot] = useState(() => props.scope.getSnapshot())
  const [health, setHealth] = useState<SettingsHealth>()
  const state = settingsState(snapshot, health)
  const settingsWritable = state === 'ready'
  const [lang, setLang] = useState(() => (props.locale?.getSnapshot?.()?.active?.startsWith('en') ? 'en' : 'zh'))
  const [defaultProvider, setDefaultProvider] = useState<Provider>(() => props.scope.getSnapshot().value?.provider ?? 'google')
  const [providerMessage, setProviderMessage] = useState('')
  const [providerMessageIsError, setProviderMessageIsError] = useState(false)
  const [cloudTimeoutSeconds, setCloudTimeoutSeconds] = useState(() => (props.scope.getSnapshot().value?.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS) / 1000)
  const [cloudTimeoutMessage, setCloudTimeoutMessage] = useState('')
  const [saveToWorkspace, setSaveToWorkspace] = useState(() => props.scope.getSnapshot().value?.saveToWorkspace ?? true)
  const [workspaceFolder, setWorkspaceFolder] = useState(() => props.scope.getSnapshot().value?.workspaceFolder ?? 'dsh-image-gen')
  const [showPill, setShowPill] = useState(() => props.scope.getSnapshot().value?.showProviderPill === true)
  const [uiMessage, setUiMessage] = useState('')
  const [uiMessageIsError, setUiMessageIsError] = useState(false)
  const [workspaceMessage, setWorkspaceMessage] = useState('')
  const [workspaceMessageIsError, setWorkspaceMessageIsError] = useState(false)
  const [rows, setRows] = useState<ProviderRows>(() => rowsFromSettings(props.scope.getSnapshot().value))
  const [compatChannels, setCompatChannels] = useState<OpenAICompatChannel[]>(() => resolveOpenAICompatChannels(props.scope.getSnapshot().value ?? {}).slice(1))
  // Bumped by host credential events so every badge re-checks without remounting.
  const [keyTick, setKeyTick] = useState(0)
  // Subscription login state per provider, read from the host login-status route.
  const [subStatus, setSubStatus] = useState<Record<SubscriptionProvider, { state: 'logged-in' | 'logged-out' | 'unknown'; email?: string }>>(
    () => ({ 'chatgpt-sub': { state: 'unknown' }, 'grok-sub': { state: 'unknown' }, 'google-sub': { state: 'unknown' } }),
  )
  const [subTick, setSubTick] = useState(0)
  const [subBusy, setSubBusy] = useState<Partial<Record<SubscriptionProvider, 'login' | 'logout'>>>({})
  // Providers whose browser login is still completing: the status probe keeps
  // polling until each lands as logged-in (or the loopback window expires), so
  // the badge flips without closing and reopening the settings card.
  const [subPending, setSubPending] = useState<Array<{ provider: SubscriptionProvider; startedAt: number }>>([])

  useEffect(() => {
    const sync = (): void => { setSnapshot(props.scope.getSnapshot()) }
    const unsubscribe = props.scope.subscribe(sync)
    // The host may accept its first view between render and subscription.
    // Re-read after subscribing so the card cannot stay in a stale loading state.
    sync()
    return unsubscribe
  }, [props.scope])
  useEffect(() => {
    if (!open || snapshot.mode === 'memory') return undefined
    const controller = new AbortController()
    void fetchSettingsHealth(controller.signal).then(value => {
      if (!controller.signal.aborted) setHealth(value)
    })
    return () => { controller.abort() }
  }, [open, snapshot.status, snapshot.mode])
  useEffect(() => {
    return props.locale?.subscribe?.(() => {
      setLang(props.locale?.getSnapshot?.()?.active?.startsWith('en') ? 'en' : 'zh')
    })
  }, [props.locale])
  const credentialEvents = props.credentialEvents
  useEffect(() => credentialEvents?.listen(() => { setKeyTick(tick => tick + 1) }), [credentialEvents])

  // Subscription login badges: one status probe on card open, after every
  // login/logout, on window focus (the user just returned from the authorize
  // tab), and every 2s while a browser login is still completing. The browser
  // never touches tokens; the host route reports only the state word and the
  // account email.
  const pending = subPending
  useEffect(() => {
    if (!open) return undefined
    let active = true
    const probe = async (): Promise<void> => {
      try {
        const response = await fetch(SUBSCRIPTION_STATUS_ROUTE, { method: 'POST', cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json() as { statuses?: Record<string, { state?: string; email?: string }> }
        if (!active || payload.statuses === undefined) return
        const next: Record<SubscriptionProvider, { state: 'logged-in' | 'logged-out' | 'unknown'; email?: string }> = { 'chatgpt-sub': { state: 'unknown' }, 'grok-sub': { state: 'unknown' }, 'google-sub': { state: 'unknown' } }
        for (const provider of SUBSCRIPTION_PROVIDERS) {
          const row = payload.statuses[provider]
          if (row?.state === 'logged-in') next[provider] = { state: 'logged-in', ...(typeof row.email === 'string' ? { email: row.email } : {}) }
          else if (row?.state === 'logged-out') next[provider] = { state: 'logged-out' }
        }
        setSubStatus(next)
        // A pending login just landed: drop it from the poll set and surface
        // the success message on that provider's row.
        const landed = pending.filter(entry => next[entry.provider].state === 'logged-in')
        if (landed.length > 0) {
          setSubPending(current => current.filter(entry => next[entry.provider].state !== 'logged-in'))
          for (const entry of landed) {
            updateRow(entry.provider, { message: t('subLoginOk'), messageIsError: false })
          }
        }
        // Bounded by the host's 10-minute loopback window: entries older than
        // that stop polling instead of spinning forever.
        const WINDOW_MS = 10.5 * 60_000
        const stale = pending.filter(entry => Date.now() - entry.startedAt > WINDOW_MS)
        if (stale.length > 0) {
          setSubPending(current => current.filter(entry => Date.now() - entry.startedAt <= WINDOW_MS))
        }
      } catch { /* badges stay unknown */ }
    }
    void probe()
    // While a browser login is in flight, keep polling; stop when none is.
    let timer: ReturnType<typeof setInterval> | undefined
    if (pending.length > 0) {
      timer = setInterval(() => { void probe() }, 2000)
    }
    const onFocus = (): void => { void probe() }
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      if (timer !== undefined) clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
    // pending is read fresh from the closure each render; its identity changes
    // on setSubPending and restarts the interval with the updated set.
  }, [open, subTick, pending])

  /** Start a subscription login: the host registers PKCE and the loopback
   * catch server, then the browser opens the vendor's authorize URL. The
   * provider joins the pending set so the badge polls until login lands. */
  const subscriptionLogin = async (provider: SubscriptionProvider): Promise<void> => {
    updateRow(provider, { message: '', messageIsError: false })
    setSubBusy(current => ({ ...current, [provider]: 'login' }))
    try {
      const response = await fetch(SUBSCRIPTION_LOGIN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string | { message?: string } }
      if (!response.ok || payload.ok !== true || typeof payload.url !== 'string') {
        const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message
        throw new Error(detail ?? `HTTP ${String(response.status)}`)
      }
      // The loopback catch window is 10 minutes; the poll set drops the row
      // earlier if it lands, and this expiry drops it if it never does.
      setSubPending(current => [...current.filter(entry => entry.provider !== provider), { provider, startedAt: Date.now() }])
      window.open(payload.url, '_blank', 'noopener')
      updateRow(provider, { message: t('subWaitingLogin'), messageIsError: false })
    } catch (cause) {
      updateRow(provider, { message: cause instanceof Error ? cause.message : String(cause), messageIsError: true })
    } finally {
      setSubBusy(current => { const next = { ...current }; delete next[provider]; return next })
    }
  }

  /** Sign out one subscription account; nothing else changes. */
  const subscriptionLogout = async (provider: SubscriptionProvider): Promise<void> => {
    setSubBusy(current => ({ ...current, [provider]: 'logout' }))
    try {
      const response = await fetch(SUBSCRIPTION_LOGIN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, action: 'logout' }),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      updateRow(provider, { message: '', messageIsError: false })
    } catch (cause) {
      updateRow(provider, { message: cause instanceof Error ? cause.message : String(cause), messageIsError: true })
    } finally {
      setSubBusy(current => { const next = { ...current }; delete next[provider]; return next })
      setSubTick(tick => tick + 1)
    }
  }

  const t = (keyName: DictKey, params?: Record<string, string>): string => {
    const dict = lang === 'en' ? DICT.en : DICT.zh
    let text: string = dict[keyName] || DICT.zh[keyName] || keyName
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v)
      }
    }
    return text
  }
  const stateMessages = {
    loading: 'settingsLoading', remote: 'settingsRemote', unavailable: 'settingsUnavailable',
    readOnly: 'settingsReadOnly', incompatible: 'settingsIncompatible',
  } as const satisfies Record<Exclude<SettingsState, 'ready'>, DictKey>
  const settingsMessage = state === 'ready' ? undefined : t(stateMessages[state])
  const saveSetting = async (field: string, value: unknown): Promise<void> => {
    if (settingsMessage !== undefined) throw new Error(settingsMessage)
    await writeSetting(props.scope, field, value, t('settingsWriteRejected'))
  }

  const providerLabels: Record<Provider, string> = {
    google: t('providerGoogle'),
    openai: t('providerOpenAI'),
    'openai-compat': t('providerOpenAICompat'),
    seedream: t('providerSeedream'),
    dashscope: t('providerDashScope'),
    xai: t('providerXAI'),
    zhipu: t('providerZhipu'),
    comfyui: t('providerComfyUI'),
    'chatgpt-sub': t('providerChatGPTSub'),
    'grok-sub': t('providerGrokSub'),
    'google-sub': t('providerGoogleSub'),
  }

  useEffect(() => {
    const value = snapshot.value
    setDefaultProvider(value?.provider ?? 'google')
    setCloudTimeoutSeconds((value?.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS) / 1000)
    setSaveToWorkspace(value?.saveToWorkspace ?? true)
    setWorkspaceFolder(value?.workspaceFolder ?? 'dsh-image-gen')
    setShowPill(value?.showProviderPill === true)
    setRows(current => {
      const next = { ...current }
      for (const provider of IMAGE_PROVIDERS) {
        next[provider] = {
          ...current[provider],
          model: modelOf(provider, value),
          ...(provider === 'openai-compat' ? compatRowFields(resolveOpenAICompatChannels(value ?? {})[0]!) : {}),
          baseURL: baseURLOf(provider, value),
          ...(provider === 'comfyui' ? {
            workflows: resolveComfyUIWorkflows(value ?? {}),
            activeWorkflow: activeComfyUIWorkflow(value ?? {})?.name ?? '',
            timeoutSeconds: Math.max(1, Math.round((value?.comfyuiTimeoutMs ?? DEFAULT_COMFYUI_TIMEOUT_MS) / 1000)),
          } : {}),
          ...(provider === 'seedream' ? {
            outputFormat: value?.seedreamOutputFormat === 'png' ? 'png' : 'jpeg',
            watermark: value?.seedreamWatermark !== false,
            background: value?.seedreamBackground === 'transparent' ? 'transparent' : 'opaque',
          } : {}),
        }
      }
      for (const channel of resolveOpenAICompatChannels(value ?? {}).slice(1)) {
        const key = compatChannelRowKey(channel.id)
        next[key] = { ...(current[key] ?? emptyProviderRow()), ...compatRowFields(channel) }
      }
      return next
    })
  }, [snapshot])

  const credentials = props.credentials
  const credentialsAvailable = props.credentialsAvailable
  useEffect(() => {
    let active = true
    const targets: Array<{ key: ProviderRowTarget; keyRef: string }> = [
      ...CLOUD_IMAGE_PROVIDERS.flatMap(provider => {
        const keyRef = cloudCredentialRef(provider)
        return keyRef === undefined ? [] : [{ key: provider as ProviderRowTarget, keyRef }]
      }),
      ...compatChannels.map(channel => ({ key: compatChannelRowKey(channel.id), keyRef: channel.keyRef })),
    ]
    if (!credentialsAvailable()) {
      setRows(current => {
        const next = { ...current }
        for (const target of targets) next[target.key] = { ...(current[target.key] ?? emptyProviderRow()), keyStatus: 'unavailable', keyInfo: undefined }
        return next
      })
      return () => { active = false }
    }
    for (const target of targets) {
      setRows(current => ({ ...current, [target.key]: { ...current[target.key], keyStatus: 'checking' } }))
      void credentials.describe([target.keyRef]).then(response => {
        if (!active) return
        const info = response.ok ? response.value?.[target.keyRef] : undefined
        setRows(current => ({ ...current, [target.key]: { ...current[target.key], keyStatus: response.ok ? (info?.configured ? 'configured' : 'missing') : 'unknown', keyInfo: info } }))
      }).catch(() => {
        if (!active) return
        setRows(current => ({ ...current, [target.key]: { ...current[target.key], keyStatus: 'unknown' } }))
      })
    }
    return () => { active = false }
  }, [credentials, credentialsAvailable, keyTick, compatChannels])

  const updateRow = (target: ProviderRowTarget, patch: Partial<ProviderRowState>): void => {
    setRows(current => ({ ...current, [target]: { ...current[target], ...patch } }))
  }

  /** The only action that ever changes the default provider; saving a key never does. */
  const selectDefaultProvider = (provider: Provider): void => {
    setDefaultProvider(provider)
    setProviderMessage(''); setProviderMessageIsError(false)
    void saveSetting('provider', provider).catch((cause: unknown) => {
      setDefaultProvider(snapshot.value?.provider ?? 'google')
      setProviderMessage(cause instanceof Error ? cause.message : String(cause))
      setProviderMessageIsError(true)
    })
  }

  const saveProviderRow = async (provider: Provider, channel?: OpenAICompatChannel): Promise<void> => {
    const target = channel === undefined ? provider : compatChannelRowKey(channel.id)
    const row = rows[target]!
    updateRow(target, { saving: true, message: '', messageIsError: false })
    try {
      if (channel !== undefined) {
        const label = row.label.trim()
        if (label.length === 0) throw new Error(t('channelNameRequired'))
        const updated: OpenAICompatChannel = {
          ...channel,
          label,
          baseURL: row.baseURL.trim(),
          model: row.model.trim(),
          models: resolveOpenAICompatModels({ openaiCompatModel: row.model, openaiCompatModels: row.models }),
          editModel: row.editModel.trim(),
          quality: row.generationQuality.trim(),
          qualityOptions: [...new Set(row.qualityOptionsText.split(',').map(value => value.trim()).filter(Boolean))],
          extraBody: parseExtraFields(row.generateExtraText, t('editExtraInvalid')),
          editSizeMode: row.editSizeMode,
          editFormat: row.editFormat,
          editExtra: parseExtraFields(row.editExtraText, t('editExtraInvalid')),
          sizes: parseSizeTable(row.sizeTableText, t('sizeTableInvalid')),
        }
        const nextChannels = compatChannels.some(entry => entry.id === channel.id)
          ? compatChannels.map(entry => entry.id === channel.id ? updated : entry)
          : [...compatChannels, updated]
        await saveSetting('openaiCompatChannels', nextChannels)
        setCompatChannels(nextChannels)
        if (row.keyInput.trim().length > 0) {
          if (!credentialsAvailable()) throw new Error(t('credentialsUnavailable'))
          const response = await props.credentials.set(channel.keyRef, row.keyInput.trim())
          if (!response.ok) throw new Error(response.error?.message ?? t('saveKeyFailed'))
          updateRow(target, { keyInput: '', keyStatus: 'configured' })
        }
      } else if (provider === 'comfyui') {
        const entries = row.workflows.map(entry => ({ name: entry.name.trim(), json: entry.json, presetPrompt: (entry.presetPrompt ?? '').trim() }))
        for (const entry of entries) {
          if (entry.name.length === 0) throw new Error(t('workflowNameRequired'))
          validateComfyUIWorkflowJson(entry.json)
        }
        if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error(t('workflowDuplicateName'))
        const activeEntry = entries.find(entry => entry.name === row.activeWorkflow) ?? entries[0]
        await saveSetting('comfyuiBaseURL', row.baseURL)
        await saveSetting('comfyuiWorkflows', entries)
        await saveSetting('comfyuiActiveWorkflow', activeEntry === undefined ? '' : activeEntry.name)
        await saveSetting('comfyuiWorkflowJson', activeEntry === undefined ? '' : activeEntry.json)
        await saveSetting('comfyuiWorkflowName', activeEntry === undefined ? '' : activeEntry.name)
        await saveSetting('comfyuiTimeoutMs', Math.max(1, Math.round(row.timeoutSeconds)) * 1000)
      } else if (isSubscriptionProvider(provider)) {
        await Promise.resolve()
      } else {
        const editExtra = provider === 'openai-compat' ? parseExtraFields(row.editExtraText, t('editExtraInvalid')) : {}
        const sizeTable = provider === 'openai' || provider === 'openai-compat' ? parseSizeTable(row.sizeTableText, t('sizeTableInvalid')) : {}
        const generateExtra = provider === 'openai-compat' ? parseExtraFields(row.generateExtraText, t('editExtraInvalid')) : {}
        if (provider === 'openai') for (const tiers of Object.values(sizeTable)) for (const size of Object.values(tiers)) validateOfficialSize(row.model, size)
        await saveSetting(modelFieldOf(provider), row.model)
        await saveSetting(baseURLFieldOf(provider), row.baseURL)
        if (provider === 'google') await saveSetting('googleNative', row.googleNative)
        if (provider === 'openai') await saveSetting('openaiSizes', sizeTable)
        if (provider === 'openai-compat') {
          await saveSetting('openaiCompatLabel', row.label.trim())
          await saveSetting('openaiCompatModels', resolveOpenAICompatModels({ openaiCompatModel: row.model, openaiCompatModels: row.models }))
          await saveSetting('openaiCompatEditModel', row.editModel.trim())
          await saveSetting('openaiCompatEditFormat', row.editFormat)
          await saveSetting('openaiCompatEditExtra', editExtra)
          await saveSetting('openaiCompatSizes', sizeTable)
          await saveSetting('openaiCompatQuality', row.generationQuality.trim())
          await saveSetting('openaiCompatQualityOptions', [...new Set(row.qualityOptionsText.split(',').map(value => value.trim()).filter(Boolean))])
          await saveSetting('openaiCompatExtraBody', generateExtra)
          await saveSetting('openaiCompatEditSizeMode', row.editSizeMode)
        }
        if (provider === 'seedream') {
          await saveSetting('seedreamOutputFormat', row.outputFormat)
          await saveSetting('seedreamWatermark', row.watermark)
          await saveSetting('seedreamBackground', row.background)
        }
        if (row.keyInput.trim().length > 0) {
          const keyRef = cloudCredentialRef(provider)
          if (keyRef === undefined) throw new Error(t('comfyuiNoKey'))
          if (!credentialsAvailable()) throw new Error(t('credentialsUnavailable'))
          const response = await props.credentials.set(keyRef, row.keyInput.trim())
          if (!response.ok) throw new Error(response.error?.message ?? t('saveKeyFailed'))
          updateRow(target, { keyInput: '', keyStatus: 'configured' })
        }
      }
      updateRow(target, {
        message: t('saved'), messageIsError: false,
        testResult: undefined, modelFetchMessage: '', modelFetchIsError: false,
      })
    } catch (cause) {
      updateRow(target, { message: cause instanceof Error ? cause.message : String(cause), messageIsError: true })
    } finally {
      updateRow(target, { saving: false })
    }
  }

  const addCompatChannel = (): void => {
    const id = `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const label = `OpenAI 兼容 ${compatChannels.length + 2}`
    const channel: OpenAICompatChannel = {
      id,
      label,
      keyRef: openAICompatKeyRef(id),
      baseURL: '',
      model: '',
      models: [],
      qualityOptions: [...DEFAULT_COMPAT_QUALITIES],
    }
    setCompatChannels(current => [...current, channel])
    setRows(current => ({
      ...current,
      [compatChannelRowKey(id)]: { ...emptyProviderRow(), ...compatRowFields(channel), expanded: true },
    }))
  }

  const removeCompatChannel = async (channel: OpenAICompatChannel): Promise<void> => {
    if (!window.confirm(t('removeChannelConfirm', { label: channel.label }))) return
    const target = compatChannelRowKey(channel.id)
    const persisted = snapshot.value?.openaiCompatChannels?.some(entry => entry.id === channel.id) === true
    if (!persisted) {
      setCompatChannels(current => current.filter(entry => entry.id !== channel.id))
      setRows(current => {
        const next = { ...current }
        delete next[target]
        return next
      })
      return
    }
    let removed = false
    updateRow(target, { saving: true, message: '', messageIsError: false })
    try {
      const nextChannels = compatChannels.filter(entry => entry.id !== channel.id)
      await saveSetting('openaiCompatChannels', nextChannels)
      if (snapshot.value?.openaiCompatActiveChannel === channel.id) await saveSetting('openaiCompatActiveChannel', 'default')
      removed = true
      setCompatChannels(nextChannels)
      setRows(current => {
        const next = { ...current }
        delete next[target]
        return next
      })
    } catch (cause) {
      updateRow(target, { message: cause instanceof Error ? cause.message : String(cause), messageIsError: true })
    } finally {
      if (!removed) updateRow(target, { saving: false })
    }
  }

  /** These actions use host settings, so drafts must be saved before making a request. */
  const providerActionBlockMessage = (provider: Provider, channel?: OpenAICompatChannel): string | undefined => {
    const target = channel === undefined ? provider : compatChannelRowKey(channel.id)
    const row = rows[target]!
    if (row.keyInput.trim().length > 0) return t('saveKeyFirst')
    if (isSubscriptionProvider(provider)) return undefined
    const address = row.baseURL.trim()
    if (address.length === 0) return t('endpointRequired')
    const savedAddress = channel === undefined ? baseURLOf(provider, props.scope.getSnapshot().value) : channel.baseURL
    if (address !== savedAddress.trim()) return t('saveEndpointFirst')
    if (provider === 'google' && row.googleNative !== (props.scope.getSnapshot().value?.googleNative === true)) return t('saveGoogleProtocolFirst')
    return undefined
  }

  /** Localize the host's missing-address error while preserving upstream details. */
  const providerErrorMessage = (message: string | undefined): string =>
    message === 'Base URL is not configured' ? t('savedEndpointMissing') : message ?? t('testFailed')

  /** Probe through the host route so the browser side never touches credential values. */
  const testConnection = async (provider: Provider, channel?: OpenAICompatChannel): Promise<void> => {
    const target = channel === undefined ? provider : compatChannelRowKey(channel.id)
    const blocked = providerActionBlockMessage(provider, channel)
    if (blocked !== undefined) {
      updateRow(target, { message: blocked, messageIsError: false, testResult: undefined })
      return
    }
    updateRow(target, { testing: true, testResult: undefined, message: '', messageIsError: false })
    try {
      const response = await fetch(TEST_CONNECTION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, ...(channel === undefined ? {} : { channel: channel.id }) }),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      updateRow(target, { testResult: await response.json() as ProbeOutcome })
    } catch (cause) {
      updateRow(target, { testResult: { ok: false, reason: 'error', message: cause instanceof Error ? cause.message : String(cause) } })
    } finally {
      updateRow(target, { testing: false })
    }
  }

  /** Pull the provider's image-capable model ids through the host route (Google and the OpenAI family). */
  const fetchProviderModels = async (provider: CloudImageProvider, channel?: OpenAICompatChannel): Promise<void> => {
    const target = channel === undefined ? provider : compatChannelRowKey(channel.id)
    const blocked = providerActionBlockMessage(provider, channel)
    if (blocked !== undefined) {
      updateRow(target, { modelFetchMessage: blocked, modelFetchIsError: false })
      return
    }
    updateRow(target, { fetchingModels: true, modelFetchMessage: '', modelFetchIsError: false })
    try {
      const response = await fetch(TEST_CONNECTION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, action: 'models', ...(channel === undefined ? {} : { channel: channel.id }) }),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const payload = await response.json() as { ok: boolean; models?: unknown; reason?: string; message?: string }
      if (payload.ok && Array.isArray(payload.models)) {
        const models = payload.models.filter((id): id is string => typeof id === 'string')
        updateRow(target, {
          modelOptions: models,
          modelFetchMessage: models.length > 0 ? t('modelsFound', { n: String(models.length) }) : t('modelsNone'),
          modelFetchIsError: models.length === 0,
        })
      } else if (payload.reason === 'missing-key') {
        updateRow(target, { modelFetchMessage: t('badgeMissing'), modelFetchIsError: true })
      } else if (payload.reason === 'unauthorized') {
        updateRow(target, { modelFetchMessage: t('testUnauthorized'), modelFetchIsError: true })
      } else {
        updateRow(target, { modelFetchMessage: providerErrorMessage(payload.message), modelFetchIsError: true })
      }
    } catch (cause) {
      updateRow(target, { modelFetchMessage: cause instanceof Error ? cause.message : String(cause), modelFetchIsError: true })
    } finally {
      updateRow(target, { fetchingModels: false })
    }
  }

  const clearProviderKey = async (provider: CloudImageProvider, channel?: OpenAICompatChannel): Promise<void> => {
    const target = channel === undefined ? provider : compatChannelRowKey(channel.id)
    const keyRef = channel === undefined ? cloudCredentialRef(provider) : channel.keyRef
    if (keyRef === undefined) return
    if (typeof props.credentials.unset !== 'function') {
      updateRow(target, { message: t('clearKeyUnsupported'), messageIsError: true })
      return
    }
    updateRow(target, { saving: true, message: '', messageIsError: false })
    try {
      const response = await props.credentials.unset(keyRef)
      if (!response.ok) throw new Error(response.error?.message ?? t('clearKeyFailed'))
      updateRow(target, { keyStatus: 'missing', keyInput: '', testResult: undefined, message: t('keyCleared'), messageIsError: false })
    } catch (cause) {
      updateRow(target, { message: cause instanceof Error ? cause.message : String(cause), messageIsError: true })
    } finally {
      updateRow(target, { saving: false })
    }
  }

  const testResultText = (result: ProbeOutcome | undefined): string => {
    if (result === undefined) return ''
    if (result.ok) return t('testOk')
    if (result.reason === 'missing-key') return t('badgeMissing')
    if (result.reason === 'unauthorized') return t('testUnauthorized')
    return `${t('testFailed')}${result.message !== undefined && result.message.length > 0 ? `: ${providerErrorMessage(result.message)}` : ''}`
  }

  const badgeOf = (provider: Provider, channel?: OpenAICompatChannel): { text: string; className: string } => {
    if (provider === 'comfyui') return { text: t('comfyuiNoKey'), className: 'dsh-ig-badge dsh-ig-badge-neutral' }
    if (isSubscriptionProvider(provider)) {
      const status = subStatus[provider].state
      if (status === 'logged-in') return { text: t('subBadgeLoggedIn'), className: 'dsh-ig-badge dsh-ig-badge-ok' }
      if (status === 'logged-out') return { text: t('subBadgeLoggedOut'), className: 'dsh-ig-badge dsh-ig-badge-missing' }
      return { text: t('subBadgeUnknown'), className: 'dsh-ig-badge dsh-ig-badge-neutral' }
    }
    const target = channel === undefined ? provider : compatChannelRowKey(channel.id)
    const status = rows[target]!.keyStatus
    if (status === 'checking') return { text: t('badgeChecking'), className: 'dsh-ig-badge dsh-ig-badge-neutral dsh-ig-badge-checking' }
    if (status === 'configured') return { text: t('badgeConfigured'), className: 'dsh-ig-badge dsh-ig-badge-ok' }
    if (status === 'missing') return { text: t('badgeMissing'), className: 'dsh-ig-badge dsh-ig-badge-missing' }
    if (status === 'unavailable') return { text: t('badgeUnavailable'), className: 'dsh-ig-badge dsh-ig-badge-neutral' }
    return { text: t('badgeUnknown'), className: 'dsh-ig-badge dsh-ig-badge-neutral' }
  }

  const importWorkflow = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    updateRow('comfyui', { message: '', messageIsError: false })
    try {
      if (file.size > MAX_COMFYUI_WORKFLOW_BYTES) throw new Error(t('workflowTooLarge'))
      const json = await file.text()
      validateComfyUIWorkflowJson(json)
      const name = uniqueComfyUIWorkflowName(file.name, rows.comfyui.workflows.map(entry => entry.name))
      setRows(current => ({ ...current, comfyui: { ...current.comfyui, workflows: [...current.comfyui.workflows, { name, json }], activeWorkflow: current.comfyui.activeWorkflow.length > 0 ? current.comfyui.activeWorkflow : name } }))
      updateRow('comfyui', { message: t('workflowImported', { name }), messageIsError: false })
    } catch (cause) {
      updateRow('comfyui', { message: cause instanceof Error ? cause.message : String(cause), messageIsError: true })
    }
  }

  /** Renaming the active entry keeps the active selection following its new name. */
  const renameWorkflow = (index: number, name: string): void => {
    setRows(current => {
      const previous = current.comfyui.workflows[index]
      const workflows = current.comfyui.workflows.map((entry, position) => position === index ? { ...entry, name } : entry)
      const activeWorkflow = previous !== undefined && previous.name === current.comfyui.activeWorkflow ? name : current.comfyui.activeWorkflow
      return { ...current, comfyui: { ...current.comfyui, workflows, activeWorkflow } }
    })
  }

  /** Removing the active entry moves the selection to the first remaining workflow. */
  const removeWorkflow = (index: number): void => {
    setRows(current => {
      const previous = current.comfyui.workflows[index]
      const workflows = current.comfyui.workflows.filter((_entry, position) => position !== index)
      const activeWorkflow = previous !== undefined && previous.name === current.comfyui.activeWorkflow ? workflows[0]?.name ?? '' : current.comfyui.activeWorkflow
      return { ...current, comfyui: { ...current.comfyui, workflows, activeWorkflow } }
    })
  }

  /** Editing one entry's preset leaves the rest of the entry untouched. */
  const setWorkflowPreset = (index: number, presetPrompt: string): void => {
    setRows(current => {
      const workflows = current.comfyui.workflows.map((entry, position) => position === index ? { ...entry, presetPrompt } : entry)
      return { ...current, comfyui: { ...current.comfyui, workflows } }
    })
  }

  const commitCloudTimeout = (): void => {
    if (!Number.isInteger(cloudTimeoutSeconds) || cloudTimeoutSeconds < 5 || cloudTimeoutSeconds > 3600) {
      setCloudTimeoutSeconds((snapshot.value?.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS) / 1000)
      return
    }
    const next = cloudTimeoutSeconds * 1000
    if (next === (snapshot.value?.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS)) return
    setCloudTimeoutMessage('')
    void saveSetting('cloudTimeoutMs', next).catch((cause: unknown) => {
      setCloudTimeoutSeconds((snapshot.value?.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS) / 1000)
      setCloudTimeoutMessage(cause instanceof Error ? cause.message : String(cause))
    })
  }

  /** Workspace checkbox persists immediately, like every other toggle on this card. */
  const toggleSaveToWorkspace = (next: boolean): void => {
    setSaveToWorkspace(next)
    setWorkspaceMessage(''); setWorkspaceMessageIsError(false)
    void saveSetting('saveToWorkspace', next).catch((cause: unknown) => {
      setSaveToWorkspace(snapshot.value?.saveToWorkspace ?? true)
      setWorkspaceMessage(cause instanceof Error ? cause.message : String(cause))
      setWorkspaceMessageIsError(true)
    })
  }

  /** Folder input persists on Enter or blur; no save button needed. */
  const commitWorkspaceFolder = (): void => {
    const next = workspaceFolder.trim()
    if (next === (snapshot.value?.workspaceFolder ?? 'dsh-image-gen')) return
    setWorkspaceMessage(''); setWorkspaceMessageIsError(false)
    void saveSetting('workspaceFolder', next).then(() => {
      setWorkspaceMessage(t('saved'))
    }).catch((cause: unknown) => {
      setWorkspaceFolder(snapshot.value?.workspaceFolder ?? 'dsh-image-gen')
      setWorkspaceMessage(cause instanceof Error ? cause.message : String(cause))
      setWorkspaceMessageIsError(true)
    })
  }

  /** The pill toggle saves immediately, like the default-provider radio. */
  const toggleShowPill = (next: boolean): void => {
    setShowPill(next)
    setUiMessage(''); setUiMessageIsError(false)
    void saveSetting('showProviderPill', next).catch((cause: unknown) => {
      setShowPill(snapshot.value?.showProviderPill === true)
      setUiMessage(cause instanceof Error ? cause.message : String(cause))
      setUiMessageIsError(true)
    })
  }

  const renderCloudBody = (provider: CloudImageProvider, channel?: OpenAICompatChannel) => {
    const target = channel === undefined ? provider : compatChannelRowKey(channel.id)
    const row = rows[target]!
    const update = (patch: Partial<ProviderRowState>): void => { updateRow(target, patch) }
    const modelListId = `dsh-ig-${target.replace(/[^A-Za-z0-9_-]/g, '-')}-model-options`
    const officialEditFormat = provider === 'openai-compat'
      ? compatEditFormat({ openaiCompatBaseURL: row.baseURL, openaiCompatModel: row.editModel.trim() || row.model }) : 'multipart'
    const automaticEditFormat = officialEditFormat !== 'multipart'
    const editFormat = automaticEditFormat ? officialEditFormat : row.editFormat
    const keyRef = channel === undefined ? cloudCredentialRef(provider) ?? '' : channel.keyRef
    const keyReadOnly = row.keyInfo?.writable === false
    const keyUnavailable = !credentialsAvailable()
    const providerLabel = provider === 'openai-compat' && row.label.trim().length > 0 ? row.label.trim() : providerLabels[provider]
    const compatModelChoices = provider === 'openai-compat'
      ? resolveOpenAICompatModels({ openaiCompatModel: row.model, openaiCompatModels: [...row.models, ...row.modelOptions] })
      : []
    return (
      <div className="dsh-ig-provider-body">
        <form onSubmit={(event) => { event.preventDefault(); void saveProviderRow(provider, channel) }}>
          {provider === 'openai-compat' ? (
            <label className="dsh-ig-field">
              <span className="dsh-ig-label">{t('channelName')}</span>
              <input className="dsh-ig-input" value={row.label} onChange={event => { update({ label: event.target.value }) }} placeholder={providerLabels[provider]} required={channel !== undefined} disabled={!settingsWritable} />
            </label>
          ) : null}
          <label className="dsh-ig-field">
            <span className="dsh-ig-label">{t('apiKeyLabel', { provider: providerLabel })}</span>
            <input
              className="dsh-ig-input"
              type="password"
              autoComplete="off"
              value={row.keyInput}
              onChange={event => { update({ keyInput: event.target.value }) }}
              placeholder={row.keyStatus === 'configured' ? t('apiKeyPlaceholder') : ''}
              disabled={!settingsWritable || keyReadOnly || keyUnavailable}
            />
            <span className="dsh-ig-hint">
              {keyUnavailable ? t('credentialsUnavailable')
                : keyReadOnly ? t('keyReadOnly', { source: row.keyInfo?.source ?? '' })
                : t('apiKeyHint', { key: keyRef })}
            </span>
          </label>
          <label className="dsh-ig-field">
            <span className="dsh-ig-label">{t('endpoint')}</span>
            <div className="dsh-ig-input-group">
              <input className="dsh-ig-input" type="url" value={row.baseURL} onChange={event => { update({ baseURL: event.target.value }) }} required disabled={!settingsWritable} />
              {provider !== 'openai-compat' ? (
                <button type="button" className="dsh-ig-btn-reset" title={t('resetTitle')} onClick={() => { update({ baseURL: DEFAULT_BASE_URLS[provider] }) }} disabled={!settingsWritable}>{t('reset')}</button>
              ) : null}
            </div>
            <span className="dsh-ig-hint">{t(provider === 'google' && row.googleNative ? 'endpointHintGoogleNative' : CLOUD_HINT_KEYS[provider])}</span>
          </label>
          {provider === 'google' ? (
            <label className="dsh-ig-field">
              <span className="dsh-ig-label">{t('googleProtocol')}</span>
              <select className="dsh-ig-input" value={row.googleNative ? 'native' : 'interactions'} onChange={event => { update({ googleNative: event.target.value === 'native' }) }} disabled={!settingsWritable}>
                <option value="interactions">{t('googleInteractions')}</option>
                <option value="native">{t('googleNative')}</option>
              </select>
            </label>
          ) : null}
          <label className="dsh-ig-field">
            <span className="dsh-ig-label">{t(provider === 'openai-compat' ? 'defaultModel' : 'model')}</span>
            {modelPullSupported(provider) ? (
              <div className="dsh-ig-input-group">
                <input
                  className="dsh-ig-input"
                  value={row.model}
                  onChange={event => { update({ model: event.target.value }) }}
                  onBlur={() => {
                    if (provider === 'openai-compat') update({ models: resolveOpenAICompatModels({ openaiCompatModel: row.model, openaiCompatModels: row.models }) })
                  }}
                  list={modelListId}
                  required={provider !== 'openai-compat'}
                  disabled={!settingsWritable}
                />
                <datalist id={modelListId}>
                  {row.modelOptions.map(id => <option key={id} value={id} />)}
                </datalist>
                <button
                  type="button"
                  className="dsh-ig-btn-secondary"
                  disabled={row.fetchingModels || row.saving || !settingsWritable}
                  onClick={() => { void fetchProviderModels(provider, channel) }}
                >{row.fetchingModels ? t('fetchingModels') : t('fetchModels')}</button>
              </div>
            ) : (
              <input className="dsh-ig-input" value={row.model} onChange={event => { update({ model: event.target.value }) }} required disabled={!settingsWritable} />
            )}
            {modelPullSupported(provider) ? (
              row.modelFetchMessage.length > 0 ? (
                <span className={`dsh-ig-hint${row.modelFetchIsError ? ' dsh-ig-hint-error' : ''}`} role="status">{row.modelFetchMessage}</span>
              ) : (
                <span className="dsh-ig-hint">{t('fetchModelsHint')}</span>
              )
            ) : null}
          </label>
          {provider === 'openai-compat' && compatModelChoices.length > 0 ? (
            <div className="dsh-ig-field">
              <span className="dsh-ig-label">{t('availableModels')}</span>
              <div className="dsh-ig-model-picker">
                {compatModelChoices.map(id => {
                  const isDefault = row.model.trim() === id
                  const checked = isDefault || row.models.includes(id)
                  return (
                    <label className="dsh-ig-check-row" key={id} title={id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!settingsWritable || isDefault}
                        onChange={event => {
                          const models = event.target.checked ? [...row.models, id] : row.models.filter(model => model !== id)
                          update({ models: resolveOpenAICompatModels({ openaiCompatModel: row.model, openaiCompatModels: models }) })
                        }}
                      />
                      <span className="dsh-ig-model-option">{id}</span>
                      {isDefault ? <span className="dsh-ig-model-default">{t('defaultModelTag')}</span> : null}
                    </label>
                  )
                })}
              </div>
              <span className="dsh-ig-hint">{t('availableModelsHint')}</span>
            </div>
          ) : null}
          {provider === 'openai-compat' ? (
            <label className="dsh-ig-field">
              <span className="dsh-ig-label">{t('editModel')}</span>
              <input className="dsh-ig-input" value={row.editModel} onChange={event => { update({ editModel: event.target.value }) }} list={modelListId} disabled={!settingsWritable} />
              <span className="dsh-ig-hint">{t('editModelHint')}</span>
            </label>
          ) : null}
          {provider === 'openai-compat' ? (
            <label className="dsh-ig-field">
              <span className="dsh-ig-label">{t('editFormat')}</span>
              <select
                className="dsh-ig-input"
                value={automaticEditFormat ? '__official__' : row.editFormat}
                onChange={event => { update({ editFormat: parseEditFormat(event.target.value) }) }}
                disabled={!settingsWritable || automaticEditFormat}
              >
                {automaticEditFormat ? <option value="__official__">{t('editFormatAutomatic')}</option> : null}
                <option value="multipart">{t('editFormatMultipart')}</option>
                <option value="jsonImageUrlArray">{t('editFormatJsonImageUrlArray')}</option>
                <option value="formReferenceImages">{t('editFormatFormReferenceImages')}</option>
                <option value="siliconflowJson">{t('editFormatSiliconFlow')}</option>
              </select>
              <span className="dsh-ig-hint">{t(editFormat === 'siliconflowJson' ? 'editFormatSiliconFlowHint' : 'editFormatHint')}</span>
            </label>
          ) : null}
          {provider === 'seedream' ? (
            <>
              <label className="dsh-ig-field">
                <span className="dsh-ig-label">{t('arkOutputFormat')}</span>
                <select
                  className="dsh-ig-input"
                  value={row.outputFormat}
                  onChange={event => { update({ outputFormat: event.target.value === 'png' ? 'png' : 'jpeg' }) }}
                  disabled={!settingsWritable}
                >
                  <option value="jpeg">{t('arkOutputFormatJpeg')}</option>
                  <option value="png">{t('arkOutputFormatPng')}</option>
                </select>
                <span className="dsh-ig-hint">{t('arkOutputFormatHint')}</span>
              </label>
              <label className="dsh-ig-field">
                <span className="dsh-ig-label">{t('arkWatermark')}</span>
                <select
                  className="dsh-ig-input"
                  value={row.watermark ? 'on' : 'off'}
                  onChange={event => { update({ watermark: event.target.value === 'on' }) }}
                  disabled={!settingsWritable}
                >
                  <option value="on">{t('arkWatermarkOn')}</option>
                  <option value="off">{t('arkWatermarkOff')}</option>
                </select>
                <span className="dsh-ig-hint">{t('arkWatermarkHint')}</span>
              </label>
              <label className="dsh-ig-field">
                <span className="dsh-ig-label">{t('arkBackground')}</span>
                <select
                  className="dsh-ig-input"
                  value={row.background}
                  onChange={event => { update({ background: event.target.value === 'transparent' ? 'transparent' : 'opaque' }) }}
                  disabled={!settingsWritable}
                >
                  <option value="opaque">{t('arkBackgroundOpaque')}</option>
                  <option value="transparent">{t('arkBackgroundTransparent')}</option>
                </select>
                <span className="dsh-ig-hint">{t('arkBackgroundHint')}</span>
              </label>
            </>
          ) : null}
          {provider === 'openai' || provider === 'openai-compat' ? (
            <label className="dsh-ig-field">
              <span className="dsh-ig-label">{t('sizeTable')}</span>
              <textarea className="dsh-ig-input dsh-ig-textarea" value={row.sizeTableText} onChange={event => { update({ sizeTableText: event.target.value }) }} rows={3} disabled={!settingsWritable} />
              <span className="dsh-ig-hint">{t('sizeTableHint')}</span>
            </label>
          ) : null}
          {provider === 'openai-compat' ? (
            <>
              <label className="dsh-ig-field">
                <span className="dsh-ig-label">{t('defaultQuality')}</span>
                <input className="dsh-ig-input" value={row.generationQuality} onChange={event => { update({ generationQuality: event.target.value }) }} placeholder="high" disabled={!settingsWritable} />
                <span className="dsh-ig-hint">{t('defaultQualityHint')}</span>
              </label>
              <label className="dsh-ig-field">
                <span className="dsh-ig-label">{t('qualityOptions')}</span>
                <input className="dsh-ig-input" value={row.qualityOptionsText} onChange={event => { update({ qualityOptionsText: event.target.value }) }} disabled={!settingsWritable} />
              </label>
              <label className="dsh-ig-field">
                <span className="dsh-ig-label">{t('generateExtra')}</span>
                <textarea className="dsh-ig-input dsh-ig-textarea" value={row.generateExtraText} onChange={event => { update({ generateExtraText: event.target.value }) }} placeholder={'{"watermark":false}'} rows={2} disabled={!settingsWritable} />
                <span className="dsh-ig-hint">{t('generateExtraHint')}</span>
              </label>
            </>
          ) : null}
          {provider === 'openai-compat' && (editFormat === 'jsonImageUrlArray' || editFormat === 'qwenJson' || editFormat === 'siliconflowJson') ? (
            <>
            {editFormat === 'jsonImageUrlArray' ? (
            <label className="dsh-ig-field">
              <span className="dsh-ig-label">{t('editSizeMode')}</span>
              <select className="dsh-ig-input" value={row.editSizeMode} onChange={event => { update({ editSizeMode: event.target.value === 'selected' ? 'selected' : 'auto' }) }} disabled={!settingsWritable}>
                <option value="auto">{t('editSizeAuto')}</option><option value="selected">{t('editSizeSelected')}</option>
              </select>
            </label>
            ) : null}
            <label className="dsh-ig-field">
              <span className="dsh-ig-label">{t('editExtra')}</span>
              <textarea
                className="dsh-ig-input dsh-ig-textarea"
                value={row.editExtraText}
                onChange={event => { update({ editExtraText: event.target.value }) }}
                placeholder={t('editExtraPlaceholder')}
                rows={2}
                disabled={!settingsWritable}
              />
              <span className="dsh-ig-hint">{t('editExtraHint')}</span>
            </label>
            </>
          ) : null}
          <div className="dsh-ig-row-actions">
            <p className={`dsh-ig-status${row.messageIsError ? ' dsh-ig-status-error' : ''}`} role="status">{row.message || testResultText(row.testResult)}</p>
            <span className="dsh-ig-row-buttons">
              <button type="button" className="dsh-ig-btn-secondary" disabled={row.testing || row.saving} onClick={() => { void testConnection(provider, channel) }}>{row.testing ? t('testing') : t('testConnection')}</button>
              {row.keyStatus === 'configured' && !keyReadOnly ? (
                <button type="button" className="dsh-ig-btn-secondary dsh-ig-btn-danger" disabled={row.saving} onClick={() => { void clearProviderKey(provider, channel) }}>{t('clearKey')}</button>
              ) : null}
              <button className="dsh-ig-save" type="submit" disabled={row.saving || row.testing || row.fetchingModels || !settingsWritable}>{row.saving ? t('saving') : t('save')}</button>
            </span>
          </div>
        </form>
      </div>
    )
  }

  const renderComfyUIBody = () => {
    const row = rows.comfyui
    return (
      <div className="dsh-ig-provider-body">
        <form onSubmit={(event) => { event.preventDefault(); void saveProviderRow('comfyui') }}>
          <label className="dsh-ig-field">
            <span className="dsh-ig-label">{t('endpoint')}</span>
            <div className="dsh-ig-input-group">
              <input className="dsh-ig-input" type="url" value={row.baseURL} onChange={event => { updateRow('comfyui', { baseURL: event.target.value }) }} required disabled={!settingsWritable} />
              <button type="button" className="dsh-ig-btn-reset" title={t('resetTitle')} onClick={() => { updateRow('comfyui', { baseURL: DEFAULT_BASE_URLS.comfyui }) }} disabled={!settingsWritable}>{t('reset')}</button>
            </div>
            <span className="dsh-ig-hint">{t('endpointHintComfyUI')}</span>
          </label>
          <div className="dsh-ig-field">
            <span className="dsh-ig-label">{t('workflow')}</span>
            <div className="dsh-ig-file-row">
              <label className="dsh-ig-file-button">
                <input className="dsh-ig-file-input" type="file" accept=".json,application/json" onChange={event => { void importWorkflow(event) }} />
                {t('workflowImport')}
              </label>
              {row.workflows.length === 0 ? <span className="dsh-ig-file-name">{t('workflowMissing')}</span> : null}
            </div>
            {row.workflows.length > 0 ? (
              <ul className="dsh-ig-workflow-list">
                {row.workflows.map((entry, index) => (
                  <li className="dsh-ig-workflow-row" key={String(index)}>
                    <div className="dsh-ig-workflow-main">
                      <label className="dsh-ig-workflow-active" title={t('workflowActiveTitle')}>
                        <input
                          type="radio"
                          name="dsh-ig-active-workflow"
                          aria-label={t('workflowActiveTitle')}
                          checked={entry.name === row.activeWorkflow}
                          onChange={() => { updateRow('comfyui', { activeWorkflow: entry.name }) }}
                        />
                      </label>
                      <input
                        className="dsh-ig-input dsh-ig-workflow-name"
                        value={entry.name}
                        title={entry.name}
                        onChange={event => { renameWorkflow(index, event.target.value) }}
                      />
                      <button type="button" className="dsh-ig-btn-reset" onClick={() => { removeWorkflow(index) }}>{t('workflowRemove')}</button>
                    </div>
                    <input
                      className="dsh-ig-input dsh-ig-workflow-preset"
                      value={entry.presetPrompt ?? ''}
                      placeholder={t('workflowPresetPlaceholder')}
                      title={t('workflowPresetTitle')}
                      onChange={event => { setWorkflowPreset(index, event.target.value) }}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <span className="dsh-ig-hint">{t('workflowHint')}</span>
          </div>
          <label className="dsh-ig-field">
            <span className="dsh-ig-label">{t('timeout')}</span>
            <input className="dsh-ig-input" type="number" min="1" max="3600" step="1" value={row.timeoutSeconds} onChange={event => { updateRow('comfyui', { timeoutSeconds: Number(event.target.value) }) }} required disabled={!settingsWritable} />
            <span className="dsh-ig-hint">{t('timeoutHint')}</span>
          </label>
          <div className="dsh-ig-row-actions">
            <p className={`dsh-ig-status${row.messageIsError ? ' dsh-ig-status-error' : ''}`} role="status">{row.message || testResultText(row.testResult)}</p>
            <span className="dsh-ig-row-buttons">
              <button type="button" className="dsh-ig-btn-secondary" disabled={row.testing} onClick={() => { void testConnection('comfyui') }}>{row.testing ? t('testing') : t('testConnection')}</button>
              <button className="dsh-ig-save" type="submit" disabled={row.saving || !settingsWritable || row.workflows.length === 0}>{row.saving ? t('saving') : t('save')}</button>
            </span>
          </div>
        </form>
      </div>
    )
  }

  /** Subscription rows: account login/logout, fixed model, edit limitation. */
  const renderSubscriptionBody = (provider: SubscriptionProvider) => {
    const row = rows[provider]
    const status = subStatus[provider]
    const busy = subBusy[provider]
    return (
      <div className="dsh-ig-provider-body">
        <form onSubmit={(event) => { event.preventDefault(); void saveProviderRow(provider) }}>
          <div className="dsh-ig-field">
            <span className="dsh-ig-label">{t('subSectionTitle')}</span>
            <p className="dsh-ig-hint">{t('subHint')}</p>
            <p className="dsh-ig-hint" role="note">{t('subProxyHint')}</p>
          </div>
          <div className="dsh-ig-field">
            <span className="dsh-ig-label">{t('subAccountLabel')}</span>
            <p className="dsh-ig-hint">{status.state === 'logged-in'
              ? t('subAccountEmail', { email: status.email ?? '' })
              : status.state === 'logged-out' ? t('subAccountNone') : t('subBadgeUnknown')}</p>
            <span className="dsh-ig-row-buttons">
              {status.state === 'logged-in'
                ? <button type="button" className="dsh-ig-btn-secondary" disabled={busy !== undefined} onClick={() => { void subscriptionLogout(provider) }}>{busy === 'logout' ? t('subLoggingOut') : t('subLogout')}</button>
                : <button type="button" className="dsh-ig-save" disabled={busy !== undefined} onClick={() => { void subscriptionLogin(provider); setSubTick(tick => tick + 1) }}>{busy === 'login' ? t('subLoggingIn') : t('subLogin')}</button>}
            </span>
          </div>
          <label className="dsh-ig-field">
            <span className="dsh-ig-label">{t('subModelLabel')}</span>
            <input className="dsh-ig-input" type="text" value={row.model} readOnly disabled />
            <span className="dsh-ig-hint">{t('subModelHint')}</span>
          </label>
          <div className="dsh-ig-field">
            <span className="dsh-ig-hint">{t('subEditCapability')}</span>
          </div>
          <div className="dsh-ig-row-actions">
            <p className={`dsh-ig-status${row.messageIsError ? ' dsh-ig-status-error' : ''}`} role="status">{row.message || testResultText(row.testResult)}</p>
            <span className="dsh-ig-row-buttons">
              <button type="button" className="dsh-ig-btn-secondary" disabled={row.testing} onClick={() => { void testConnection(provider); setSubTick(tick => tick + 1) }}>{row.testing ? t('testing') : t('testConnection')}</button>
              <button className="dsh-ig-save" type="submit" disabled={row.saving || !settingsWritable}>{row.saving ? t('saving') : t('save')}</button>
            </span>
          </div>
        </form>
      </div>
    )
  }

  // Providers keep their collapse: the plugin page is the settings surface now,
  // and a dozen providers expanded at once would make it far too long. The row
  // carries no card chrome — the header is a plain row and the body sits
  // directly under it on the page.
  const renderProviderRow = (provider: Provider) => {
    const row = rows[provider]
    const badge = badgeOf(provider)
    const label = provider === 'openai-compat' && row.label.trim().length > 0 ? row.label.trim() : providerLabels[provider]
    return (
      <div key={provider} className="dsh-ig-provider-row">
        <div className="dsh-ig-provider-head-row">
          <button type="button" className="dsh-ig-provider-head" aria-expanded={row.expanded} onClick={() => { updateRow(provider, { expanded: !row.expanded }) }}>
            <span className="dsh-ig-provider-name">{label}</span>
            <span className={badge.className} title={badge.text}><span className="dsh-ig-badge-dot" aria-hidden="true" />{badge.text}</span>
            <span className={`dsh-ig-provider-chevron ${row.expanded ? 'dsh-ig-provider-chevron-open' : ''}`} aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4"/></svg>
            </span>
          </button>
          {provider === 'openai-compat' ? <button type="button" className="dsh-ig-btn-secondary dsh-ig-channel-add" title={t('addCompatChannel')} aria-label={t('addCompatChannel')} onClick={addCompatChannel} disabled={!settingsWritable}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
          </button> : null}
        </div>
        {row.expanded ? (provider === 'comfyui' ? renderComfyUIBody() : isSubscriptionProvider(provider) ? renderSubscriptionBody(provider) : renderCloudBody(provider)) : null}
      </div>
    )
  }

  const renderCompatChannelRow = (channel: OpenAICompatChannel) => {
    const target = compatChannelRowKey(channel.id)
    const row = rows[target]!
    const badge = badgeOf('openai-compat', channel)
    return (
      <div key={target} className="dsh-ig-provider-row dsh-ig-compat-channel-row">
        <div className="dsh-ig-provider-head-row">
          <button type="button" className="dsh-ig-provider-head" aria-expanded={row.expanded} onClick={() => { updateRow(target, { expanded: !row.expanded }) }}>
            <span className="dsh-ig-provider-name">{channel.label}</span>
            <span className={badge.className} title={badge.text}><span className="dsh-ig-badge-dot" aria-hidden="true" />{badge.text}</span>
            <span className={`dsh-ig-provider-chevron ${row.expanded ? 'dsh-ig-provider-chevron-open' : ''}`} aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4"/></svg>
            </span>
          </button>
          <button type="button" className="dsh-ig-btn-secondary dsh-ig-btn-danger" disabled={row.saving || !settingsWritable} onClick={() => { void removeCompatChannel(channel) }}>{t('removeChannel')}</button>
        </div>
        {row.expanded ? renderCloudBody('openai-compat', channel) : null}
      </div>
    )
  }

  return (
    <li className="dsh-ig-card">
      <div className="dsh-ig-head">
        <span className="dsh-ig-head-text">
          <span className="dsh-ig-title">{t('title')}</span>
          <span className="dsh-ig-desc">{t('description')}</span>
        </span>
      </div>
      <div className="dsh-ig-body">
          {settingsMessage !== undefined ? <p className="dsh-ig-status dsh-ig-status-readonly" role="note">{settingsMessage}</p> : null}
          <div className="dsh-ig-field">
            <span className="dsh-ig-label">{t('defaultProvider')}</span>
            <div className="dsh-ig-radios" role="radiogroup" aria-label={t('defaultProvider')}>
              {IMAGE_PROVIDERS.map(provider => (
                <label key={provider} className={`dsh-ig-radio${defaultProvider === provider ? ' dsh-ig-radio-checked' : ''}`}>
                  <input
                    type="radio"
                    name="dsh-ig-default-provider"
                    checked={defaultProvider === provider}
                    onChange={() => { selectDefaultProvider(provider) }}
                    disabled={!settingsWritable}
                  />
                  {providerLabels[provider]}
                </label>
              ))}
            </div>
            <span className="dsh-ig-hint">{t('defaultProviderHint')}</span>
            {providerMessage.length > 0 ? <span className={`dsh-ig-status${providerMessageIsError ? ' dsh-ig-status-error' : ''}`} role="status">{providerMessage}</span> : null}
          </div>
          <label className="dsh-ig-field">
            <span className="dsh-ig-label">{t('cloudTimeout')}</span>
            <input
              className="dsh-ig-input"
              type="number" min="5" max="3600" step="1"
              value={cloudTimeoutSeconds}
              onChange={event => { setCloudTimeoutSeconds(Number(event.target.value)) }}
              onBlur={() => { commitCloudTimeout() }}
              onKeyDown={event => { if (event.key === 'Enter') commitCloudTimeout() }}
              required disabled={!settingsWritable}
            />
            <span className="dsh-ig-hint">{t('cloudTimeoutHint')}</span>
            {cloudTimeoutMessage.length > 0 ? <span className="dsh-ig-status dsh-ig-status-error" role="status">{cloudTimeoutMessage}</span> : null}
          </label>
          <div className="dsh-ig-providers">
            {IMAGE_PROVIDERS.flatMap(provider => [
              renderProviderRow(provider),
              ...(provider === 'openai-compat' ? compatChannels.map(channel => renderCompatChannelRow(channel)) : []),
            ])}
          </div>
          <div className="dsh-ig-section">
            <span className="dsh-ig-section-title">{t('workspaceSection')}</span>
            <div className="dsh-ig-field">
              <label className="dsh-ig-check-row">
                <input type="checkbox" checked={saveToWorkspace} onChange={event => { toggleSaveToWorkspace(event.target.checked) }} disabled={!settingsWritable} />
                <span className="dsh-ig-label">{t('saveToWorkspace')}</span>
              </label>
              <span className="dsh-ig-hint">{t('saveToWorkspaceHint')}</span>
            </div>
            {saveToWorkspace ? (
              <label className="dsh-ig-field">
                <span className="dsh-ig-label">{t('folder')}</span>
                <input
                  className="dsh-ig-input"
                  value={workspaceFolder}
                  onChange={event => { setWorkspaceFolder(event.target.value) }}
                  onBlur={() => { commitWorkspaceFolder() }}
                  onKeyDown={event => { if (event.key === 'Enter') commitWorkspaceFolder() }}
                  placeholder="dsh-image-gen"
                  disabled={!settingsWritable}
                />
                <span className="dsh-ig-hint">{t('folderHint')}</span>
              </label>
            ) : null}
            {workspaceMessage.length > 0 ? <p className={`dsh-ig-status${workspaceMessageIsError ? ' dsh-ig-status-error' : ''}`} role="status">{workspaceMessage}</p> : null}
          </div>
          <div className="dsh-ig-section">
            <span className="dsh-ig-section-title">{t('uiSection')}</span>
            <div className="dsh-ig-field">
              <label className="dsh-ig-check-row">
                <input
                  type="checkbox"
                  checked={showPill}
                  onChange={event => { toggleShowPill(event.target.checked) }}
                  disabled={!settingsWritable}
                />
                <span className="dsh-ig-label">{t('showPill')}</span>
              </label>
              <span className="dsh-ig-hint">{t('showPillHint')}</span>
              {uiMessage.length > 0 ? <p className={`dsh-ig-status${uiMessageIsError ? ' dsh-ig-status-error' : ''}`} role="status">{uiMessage}</p> : null}
            </div>
          </div>
        </div>
    </li>
  )
}

/** Keep the legacy Tool row for old DSH and hand modern results to the independent Chat node. */
function modelOf(provider: Provider, value: ImageSettings | undefined): string {
  const stored = provider === 'comfyui'
    ? activeComfyUIWorkflow(value ?? {})?.name
    : isSubscriptionProvider(provider)
      ? DEFAULT_MODELS[provider]
      : value?.[CLOUD_MODEL_FIELDS[provider as CloudImageProvider]]
  return typeof stored === 'string' && stored.length > 0 ? stored : DEFAULT_MODELS[provider]
}

function baseURLOf(provider: Provider, value: ImageSettings | undefined): string {
  const stored = provider === 'comfyui'
    ? value?.comfyuiBaseURL
    : isSubscriptionProvider(provider)
      ? ''
      : value?.[CLOUD_URL_FIELDS[provider as CloudImageProvider]]
  return typeof stored === 'string' && stored.length > 0 ? stored : DEFAULT_BASE_URLS[provider]
}
