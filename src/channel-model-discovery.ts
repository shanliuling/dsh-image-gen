/**
 * Live model discovery for the image workbench.
 *
 * The workbench offered whatever model ids the configuration named: one per
 * official cloud row, and a list per OpenAI-compatible relay channel. That is a
 * guess. A relay's catalog changes without the patch file changing, and an
 * official row names only its default, so a model the vendor serves and the
 * operator never typed is unreachable - invisible in the picker, and rejected by
 * assertAllowed if it were somehow sent.
 *
 * This module asks the endpoints what they actually serve. It is the workbench
 * sibling of the settings card's pull button (`action: 'models'` in
 * test-route.ts) and reuses that code path rather than growing a second opinion
 * about what an image model is called.
 *
 * The load-bearing rule is that discovery NEVER blocks a render:
 *
 *   * {@link withCachedChannelModels} is synchronous and only reads the cache.
 *     It is what `describeStudio` calls, so a settings page or provider pill
 *     paints at the same speed as before this feature existed.
 *   * {@link primeChannelModels} and {@link discoverOfficialModels} are the only
 *     network paths. They fill the cache and are started fire-and-forget; the
 *     next render sees the result.
 *
 * A cold cache therefore renders the configured ids alone for one paint and then
 * widens. Ordering keeps intent leading: configured ids first, in their order,
 * discovered ids appended.
 *
 * @module dsh-image-gen/channel-model-discovery
 */
import type { Context } from '@deepseek-ai/cordis'
import { withOpenAICompatChannel, type Config } from './config.js'
import { resolveApiKey } from './credentials.js'
import {
  cloudCredentialRef,
  DEFAULT_OPENAI_COMPAT_CHANNEL_ID,
  resolveOpenAICompatChannel,
  resolveOpenAICompatChannels,
  studioModelOptionsForMode,
  type CloudImageProvider,
  type OpenAICompatChannel,
  type StudioProviderProfile,
} from './shared.js'
import {
  fetchDashScopeImageModels,
  fetchGoogleImageModels,
  fetchOpenAIImageModels,
  probeTarget,
} from './test-route.js'

/** How long one endpoint's catalog answers from cache, success or failure. */
export const CHANNEL_MODEL_DISCOVERY_TTL_MS = 5 * 60_000

/** One probe gets this long before the background refresh gives up. */
export const CHANNEL_MODEL_DISCOVERY_TIMEOUT_MS = 4_000

interface CacheEntry {
  expiresAt: number
  models: readonly string[]
}

const cache = new Map<string, CacheEntry>()

/** In-flight probes, so a burst of renders dials each endpoint once. */
const inflight = new Map<string, Promise<readonly string[]>>()

/** An endpoint is identified by where it lives plus which credential answers it. */
function cacheKeyFor(baseURL: string, keyRef: string): string {
  return `${baseURL}\u0000${keyRef}`
}

/** Drop cached catalogs; with a base URL, only that endpoint's. Used by tests. */
export function forgetDiscoveredChannelModels(baseURL?: string): void {
  if (baseURL === undefined) {
    cache.clear()
    inflight.clear()
    return
  }
  const prefix = `${baseURL}\u0000`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/** What a cached probe can answer right now, or undefined when it has nothing. */
function cachedModels(baseURL: string, keyRef: string, now: number): readonly string[] | undefined {
  const entry = cache.get(cacheKeyFor(baseURL, keyRef))
  return entry !== undefined && entry.expiresAt > now ? entry.models : undefined
}

/** The same lookup addressed by an already-composed cache key. */
function cachedByKey(key: string, now: number): readonly string[] | undefined {
  const entry = cache.get(key)
  return entry !== undefined && entry.expiresAt > now ? entry.models : undefined
}

/** Cache key for one relay channel; absent while the row names no address. */
function relayCacheKey(channel: OpenAICompatChannel): string | undefined {
  const baseURL = channel.baseURL.trim()
  return baseURL.length === 0 ? undefined : cacheKeyFor(baseURL, channel.keyRef)
}

/**
 * Ask the relay behind one channel which image models it serves, and cache the
 * answer.
 *
 * Failures are cached for the same TTL as successes: telling a relay it is
 * offline on every render is worse than showing the configured ids alone. A
 * blank base URL - the untouched legacy row - is neither probed nor cached, so
 * filling the address in later takes effect on the next render.
 */
export function primeChannelModels(
  ctx: Context,
  config: Config,
  channel: OpenAICompatChannel,
  now: number = Date.now(),
): Promise<readonly string[]> {
  const baseURL = channel.baseURL.trim()
  if (baseURL.length === 0) return Promise.resolve([])
  const key = cacheKeyFor(baseURL, channel.keyRef)
  const cached = cache.get(key)
  if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.models)
  const running = inflight.get(key)
  if (running !== undefined) return running
  const probe = (async (): Promise<readonly string[]> => {
    // "No key stored" is a local fact, not an endpoint answer: deciding it
    // without caching means a freshly entered key starts discovery on the next
    // render instead of leaving the picker empty for a whole TTL.
    const apiKey = await resolveApiKey(ctx, 'openai-compat', channel.keyRef).catch(() => undefined)
    if (apiKey === undefined) return []
    let pulled: string[] | undefined
    try {
      const result = await fetchOpenAIImageModels(
        'openai-compat',
        withOpenAICompatChannel(config, channel.id),
        apiKey,
        AbortSignal.timeout(CHANNEL_MODEL_DISCOVERY_TIMEOUT_MS),
      )
      pulled = result.ok ? result.models : undefined
    } catch {
      pulled = undefined
    }
    remember(key, pulled, now)
    return agedModels(key) ?? []
  })().finally(() => { inflight.delete(key) })
  inflight.set(key, probe)
  return probe
}

/** Official cloud rows that publish an image model list at their own endpoint. */
const DISCOVERABLE_OFFICIAL = ['google', 'openai', 'seedream', 'dashscope', 'xai', 'zhipu'] as const

type DiscoverableOfficial = typeof DISCOVERABLE_OFFICIAL[number]

function isDiscoverableOfficial(provider: CloudImageProvider): provider is DiscoverableOfficial {
  return (DISCOVERABLE_OFFICIAL as readonly string[]).includes(provider)
}

/** Cache key for one official row: the provider tags the URL so hosts never collide. */
function officialKey(provider: CloudImageProvider, endpoint: string): string {
  return cacheKeyFor(`${provider}\u0001${endpoint}`, cloudCredentialRef(provider) ?? provider)
}

/**
 * Probe one official cloud row for the image models the vendor serves, and cache
 * the answer.
 *
 * Every row answers on its own endpoint and payload shape: Google paginates
 * `list models` 1000 at a time, DashScope tags capabilities `IG`, Ark names the
 * Seedream/SeedEdit families, the rest share OpenAI `/models`. So this
 * dispatches to the same `fetch*ImageModels` the settings card's pull button
 * uses - a second parser here would eventually disagree with the card about a
 * model id, and the picker would offer something generation rejects.
 *
 * Returns [] for every failure and for any provider without a catalog: ComfyUI
 * lists workflows and the subscription rows list nothing.
 */
export async function discoverOfficialModels(
  ctx: Context,
  config: Config,
  provider: CloudImageProvider,
  signal?: AbortSignal | undefined,
): Promise<string[]> {
  if (!isDiscoverableOfficial(provider)) return []
  const apiKey = await resolveApiKey(ctx, provider).catch(() => undefined)
  if (apiKey === undefined) return []
  let endpoint: string
  try {
    endpoint = probeTarget(provider, config, apiKey).url
  } catch {
    return []
  }
  const key = officialKey(provider, endpoint)
  const known = cachedByKey(key, Date.now())
  if (known !== undefined) return [...known]
  const running = inflight.get(key)
  if (running !== undefined) return [...await running]
  const timeout = AbortSignal.timeout(CHANNEL_MODEL_DISCOVERY_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const probe = (async (): Promise<readonly string[]> => {
    let pulled: string[] | undefined
    try {
      const result = provider === 'google'
        ? await fetchGoogleImageModels(config, apiKey, combined)
        : provider === 'dashscope'
          ? await fetchDashScopeImageModels(config, apiKey, combined)
          : await fetchOpenAIImageModels(provider, config, apiKey, combined)
      // Only a parsed, successful catalog replaces the cache; a transport error
      // or an unparsable body keeps the last good list.
      pulled = result.ok ? result.models : undefined
    } catch {
      pulled = undefined
    }
    remember(key, pulled, Date.now())
    return agedModels(key) ?? []
  })().finally(() => { inflight.delete(key) })
  inflight.set(key, probe)
  return [...await probe]
}

/** Configured first - that is user intent - then ids only the endpoint knows. */
function mergedModels(configured: readonly string[], discovered: readonly string[]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const raw of [...configured, ...discovered]) {
    const id = raw.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged
}

/**
 * Synchronously read the cached relay catalogs, and name the channels whose
 * catalog is cold or stale.
 *
 * This is the render path: no await, no abort signal, no network. An untouched
 * cache returns `config` itself, so the case allocates nothing and every channel
 * shows exactly the configured ids until a prime lands. Official rows are widened
 * separately by {@link withCachedOfficialModels}, one row at a time.
 */
export function withCachedChannelModels(
  config: Config,
  now: number = Date.now(),
): { config: Config; pending: OpenAICompatChannel[] } {
  const channels = resolveOpenAICompatChannels(config)
  const pending: OpenAICompatChannel[] = []
  const widened = new Map<string, string[]>()
  for (const channel of channels) {
    const key = relayCacheKey(channel)
    if (key === undefined) continue
    const known = agedModels(key)
    // Never asked: the row paints its configured idsCol and owes a probe.
    if (known === undefined) {
      pending.push(channel)
      continue
    }
    // Aged out: still merged below so nothing leaves the picker, and queued for a refresh.
    if (!isFresh(key, now)) pending.push(channel)
    if (known.length > 0) widened.set(channel.id, mergedModels(channel.models ?? [], known))
  }
  if (widened.size === 0) return { config, pending }
  // The legacy flat row is not stored in the array - it is rebuilt from the flat
  // fields - so its widening has to land in `openaiCompatModels` to be seen.
  const legacy = widened.get(DEFAULT_OPENAI_COMPAT_CHANNEL_ID)
  return {
    config: {
      ...config,
      ...(legacy === undefined ? {} : { openaiCompatModels: legacy }),
      openaiCompatChannels: (config.openaiCompatChannels ?? []).map(entry => {
        const found = widened.get(entry?.id ?? '')
        return found === undefined ? entry : { ...entry, models: found }
      }),
    },
    pending,
  }
}

/**
 * Widen one official row's `modelOptions` with ids already discovered for it.
 *
 * Kept separate from {@link withCachedChannelModels} because the official rows are
 * built one `studioProfile` at a time: the caller reads the cache once per row
 * while assembling that row's profile, instead of re-mapping the whole config.
 */
export function withCachedOfficialModels(
  provider: CloudImageProvider,
  config: Config,
  modelOptions: readonly string[],
  apiKey: string | undefined,
  now: number = Date.now(),
): { modelOptions: string[]; stale: boolean } {
  if (apiKey === undefined || !isDiscoverableOfficial(provider)) return { modelOptions: [...modelOptions], stale: false }
  let endpoint: string
  try {
    endpoint = probeTarget(provider, config, apiKey).url
  } catch {
    return { modelOptions: [...modelOptions], stale: false }
  }
  const key = officialKey(provider, endpoint)
  const known = agedModels(key)
  // A row that was never asked keeps its configured model and owes a probe. A row
  // whose entry merely aged out still merges the aged ids, so a selected model does
  // not leave the picker while the refresh runs.
  if (known === undefined) return { modelOptions: [...modelOptions], stale: true }
  return { modelOptions: mergedModels(modelOptions, known), stale: !isFresh(key, now) }
}

/** Replace a profile generation options with a widened id list. */
function withModelOptions(profile: StudioProviderProfile, models: readonly string[]): StudioProviderProfile {
  return { ...profile, modelOptions: models.map(value => ({ value, label: value })) }
}

/** Known ids for an already-composed cache key, regardless of age. */
function agedModels(key: string): readonly string[] | undefined {
  return cache.get(key)?.models
}

/**
 * Record a probe outcome.
 *
 * `undefined` means the endpoint never answered usefully, so the last good
 * catalog stays and the entry is pushed one TTL out. That keeps a selected
 * discovered model from vanishing during a transient outage, and retries a
 * broken endpoint in five minutes rather than on every render. An empty
 * array is a real answer and does replace the catalog.
 */
function remember(key: string, models: readonly string[] | undefined, now: number): void {
  cache.set(key, {
    expiresAt: now + CHANNEL_MODEL_DISCOVERY_TTL_MS,
    models: models ?? cache.get(key)?.models ?? [],
  })
}

/** True while the entry is inside its TTL, so no refresh is owed. */
function isFresh(key: string, now: number): boolean {
  const entry = cache.get(key)
  return entry !== undefined && entry.expiresAt > now
}

/** Cache key for one official profile row, computed without needing a stored key. */
function officialLookupKey(provider: CloudImageProvider, config: Config): string | undefined {
  if (!isDiscoverableOfficial(provider)) return undefined
  try {
    return officialKey(provider, probeTarget(provider, config).url)
  } catch {
    return undefined
  }
}

/** The catalog key a profile row answers on, or undefined when the row cannot be probed. */
function profileCacheKey(profile: StudioProviderProfile, config: Config): string | undefined {
  if (profile.provider === 'openai-compat') {
    const channel = resolveOpenAICompatChannel(config, profile.channel)
    const baseURL = channel.baseURL.trim()
    return baseURL.length === 0 ? undefined : cacheKeyFor(baseURL, channel.keyRef)
  }
  return officialLookupKey(profile.provider as CloudImageProvider, config)
}

/**
 * Synchronously widen one assembled profile with the catalog already known for it.
 *
 * This is both the render path and the validation path - no await, no abort signal, no
 * network - so a picker and its generate request agree by construction. `refresh`
 * reports that the caller should start a probe: true when the row was never asked,
 * and true again once its entry aged out, because {@link agedModels} still merges the
 * aged candidates. Serving them while the refresh runs is what keeps a model from
 * vanishing out of the picker mid-session.
 */
export function widenProfileModels(
  profile: StudioProviderProfile,
  config: Config,
  now: number = Date.now(),
): { profile: StudioProviderProfile; refresh: boolean } {
  const key = profileCacheKey(profile, config)
  if (key === undefined) return { profile, refresh: false }
  const known = agedModels(key)
  if (known === undefined) return { profile, refresh: true }
  const current = studioModelOptionsForMode(profile, 'generate').map(option => option.value)
  const widened = mergedModels(current, known)
  if (widened.length === 0) return { profile, refresh: !isFresh(key, now) }
  return { profile: withModelOptions(profile, widened), refresh: !isFresh(key, now) }
}

/** Start the probe a reply asked for; a rendering caller cannot act on a rejection. */
export function refreshProfileModels(ctx: Context, config: Config, profile: StudioProviderProfile): void {
  if (profile.provider === 'openai-compat') {
    const channel = resolveOpenAICompatChannel(config, profile.channel)
    void primeChannelModels(ctx, config, channel).catch(() => undefined)
    return
  }
  const provider = profile.provider as CloudImageProvider
  if (isDiscoverableOfficial(provider)) {
    void discoverOfficialModels(ctx, config, provider).catch(() => undefined)
  }
}
