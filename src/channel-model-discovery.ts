/**
 * Live model discovery for configured OpenAI-compatible relay channels.
 *
 * A channel row lists the model ids the user typed. The relay may serve more,
 * and what it serves changes without the patch file changing. The settings card
 * already answers that question: `action: 'models'` in test-route.ts pulls the
 * relay catalog and keeps the image-capable ids. But that answer only ever
 * reached the card. The workbench picker read the static list, so a model the
 * relay served and the user never typed was unreachable.
 *
 * This module runs the same pull for the workbench ids. It reuses the card's
 * parser and filters instead of growing a second opinion about what an image
 * model is called.
 *
 * The load-bearing rule is that discovery NEVER blocks a render:
 *
 *   * {@link withCachedChannelModels} is synchronous and only reads the cache.
 *     It is what `describeStudio` calls, so a settings page or provider pill
 *     paints at the same speed as before this feature existed.
 *   * {@link primeChannelModels} is the only network path. It fills the cache
 *     and is started fire-and-forget; the next render sees the result.
 *
 * A cold cache therefore renders the typed ids alone for one paint and then
 * widens. Merge order keeps the user's intent leading: typed ids first, in their
 * order, discovered ids appended.
 *
 * @module dsh-image-gen/channel-model-discovery
 */
import type { Context } from '@deepseek-ai/cordis'
import { withOpenAICompatChannel, type Config } from './config.js'
import { resolveApiKey } from './credentials.js'
import {
  DEFAULT_OPENAI_COMPAT_CHANNEL_ID,
  resolveOpenAICompatChannels,
  type OpenAICompatChannel,
} from './shared.js'
import { fetchOpenAIImageModels } from './test-route.js'

/** How long one relay catalog answers from cache, success or failure. */
export const CHANNEL_MODEL_DISCOVERY_TTL_MS = 5 * 60_000

/** One relay probe gets this long before the background refresh gives up. */
export const CHANNEL_MODEL_DISCOVERY_TIMEOUT_MS = 4_000

interface CacheEntry {
  expiresAt: number
  models: readonly string[]
}

const cache = new Map<string, CacheEntry>()

/** A relay is identified by where it is plus which credential answers it. */
function cacheKeyFor(baseURL: string, keyRef: string): string {
  return `${baseURL}\u0000${keyRef}`
}

/** Drop cached catalogs; with a base URL, only that relay's. Used by tests. */
export function forgetDiscoveredChannelModels(baseURL?: string): void {
  if (baseURL === undefined) {
    cache.clear()
    return
  }
  const prefix = `${baseURL}\u0000`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/** In-flight probes, so a burst of renders dials each relay once. */
const inflight = new Map<string, Promise<readonly string[]>>()

/**
 * Probe one relay and cache the image ids it serves.
 *
 * Failures are cached too, for the same TTL: informing a relay that it is
 * offline on every render is worse than showing the typed ids alone. A blank
 * base URL - the untouched legacy row - is not probed and not cached, so filling
 * the address in later takes effect immediately.
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
    // "No key stored" is a local fact, not a relay answer: deciding it here
    // without caching means the user filling the key in starts discovery on the
    // next render instead of staring at an empty list for one TTL.
    const apiKey = await resolveApiKey(ctx, 'openai-compat', channel.keyRef).catch(() => undefined)
    if (apiKey === undefined) return []
    let models: readonly string[] = []
    try {
      const result = await fetchOpenAIImageModels(
        'openai-compat',
        withOpenAICompatChannel(config, channel.id),
        apiKey,
        AbortSignal.timeout(CHANNEL_MODEL_DISCOVERY_TIMEOUT_MS),
      )
      if (result.ok) models = result.models
    } catch {
      // A dead host, a torn-down socket or a non-JSON body all mean the same
      // thing to a picker: nothing to add right now. The failure is cached so a
      // broken relay is not re-dialled on every render.
      models = []
    }
    cache.set(key, { expiresAt: now + CHANNEL_MODEL_DISCOVERY_TTL_MS, models })
    return models
  })().finally(() => { inflight.delete(key) })
  inflight.set(key, probe)
  return probe
}

/** Configured first - that is user intent - then ids only the relay knows. */
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
 * Synchronously widen the channel model lists with whatever is already cached.
 *
 * This is the render path: no await, no abort signal, no network. A cold cache
 * returns `config` itself, so the untouched case allocates nothing and the rows
 * show exactly the typed ids until {@link primeChannelModels} lands a catalog.
 *
 * Only `models` lists are rewritten. The active channel, the default model and
 * every vendor field pass through, because discovery decorates the picker - it
 * does not re-decide the user's selection.
 */
export function withCachedChannelModels(
  config: Config,
  now: number = Date.now(),
): { config: Config; pending: OpenAICompatChannel[] } {
  const channels = resolveOpenAICompatChannels(config)
  const pending: OpenAICompatChannel[] = []
  const widened = new Map<string, string[]>()
  for (const channel of channels) {
    if (channel.baseURL.trim().length === 0) continue
    const entry = cache.get(cacheKeyFor(channel.baseURL.trim(), channel.keyRef))
    if (entry === undefined || entry.expiresAt <= now) {
      pending.push(channel)
      continue
    }
    if (entry.models.length > 0) widened.set(channel.id, mergedModels(channel.models ?? [], entry.models))
  }
  if (widened.size === 0) return { config, pending }
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
