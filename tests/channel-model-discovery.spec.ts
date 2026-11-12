import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import {
  discoverOfficialModels,
  forgetDiscoveredChannelModels,
  primeChannelModels,
  widenProfileModels,
  withCachedChannelModels,
  withCachedOfficialModels,
} from '../src/channel-model-discovery.js'
import type { Config } from '../src/config.js'
import { describeStudio, generateFromStudio } from '../src/studio.js'

const RELAY = 'https://relay.example.com/v1'

function relayConfig(models: string[] = []): Config {
  // Flat fields stay empty: that is the post-migration shape, where the legacy
  // synthetic channel is inert and the array row is the only live relay.
  return {
    provider: 'openai-compat',
    openaiCompatBaseURL: '',
    openaiCompatModels: [],
    openaiCompatChannels: [
      {
        id: 'relay',
        label: 'Relay',
        keyRef: 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY_RELAY',
        baseURL: RELAY,
        model: 'flux-pro-1.1',
        models: [...models],
      },
    ],
  } as Config
}

function catalog(...ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function keyCtx(key: string | undefined): any {
  return {
    credentials: {
      resolve: vi.fn(async () => (key === undefined ? undefined : { value: key })),
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  forgetDiscoveredChannelModels()
})

describe('workbench channel model discovery', () => {
  it('renders only the typed ids while the catalog is cold, and marks the row pending', () => {
    const config = relayConfig(['my-custom-image-model'])
    const result = withCachedChannelModels(config)
    expect(result.config).toBe(config)
    expect(result.pending.map(channel => channel.id)).toEqual(['relay'])
  })

  it('signals a cold catalog and accepts the discovered model after refreshing Studio', async () => {
    const config = relayConfig(['my-custom-image-model'])
    const channel = config.openaiCompatChannels![0]!
    const discoveredModel = 'seedream-4.0'
    let finishCatalog!: (response: Response) => void
    const catalogReply = new Promise<Response>(resolve => { finishCatalog = resolve })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ data: [{ b64_json: png.toString('base64') }] })
      : catalogReply)
    vi.stubGlobal('fetch', fetch)
    const attachment = { attachmentId: 'sha256:studio-fixture', mediaType: 'image/png', bytes: png.length, width: 8, height: 8 }
    const ctx = {
      credentials: {
        resolve: async (ref: string) => ref === credentialRef(channel.keyRef) ? { value: 'relay-fixture-key' } : undefined,
      },
      attachments: {
        imageLimits: { maxImageBytes: 4096, mediaTypes: ['image/png'] },
        saveImage: vi.fn(async () => attachment),
      },
      logger: { warn: vi.fn() },
    } as never
    const cold = await describeStudio(ctx, config)
    const profileOf = (result: typeof cold) => result.providers.find(row => row.channel === channel.id)!
    expect(cold.modelDiscoveryPending).toBe(true)
    expect(profileOf(cold).modelOptions?.map(option => option.value)).not.toContain(discoveredModel)

    finishCatalog(catalog(discoveredModel))
    await primeChannelModels(ctx, config, channel)
    const warm = await describeStudio(ctx, config)
    const profile = profileOf(warm)
    expect(warm.modelDiscoveryPending).toBeUndefined()
    expect(profile.modelOptions?.map(option => option.value)).toContain(discoveredModel)
    const result = await generateFromStudio(ctx, config, {
      mode: 'generate', provider: 'openai-compat', channel: channel.id, model: discoveredModel,
      prompt: 'A rectangle', ratio: profile.defaultRatio, quality: profile.defaultQuality,
    }, new AbortController().signal)
    expect(result.attachment).toEqual(attachment)
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toMatchObject({ model: discoveredModel })
  })

  it('appends discovered image models after the typed ones once primed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog('flux-pro-1.1', 'seedream-4.0', 'deepseek-chat')))
    const config = relayConfig(['my-custom-image-model'])
    await primeChannelModels(keyCtx('sk-relay'), config, config.openaiCompatChannels![0]!)
    const result = withCachedChannelModels(config)
    expect(result.config.openaiCompatChannels?.[0]?.models).toEqual([
      'my-custom-image-model',
      'flux-pro-1.1',
      'seedream-4.0',
    ])
    expect(result.pending).toEqual([])
  })

  it('keeps the typed ids when the relay is unreachable, and does not retry every render', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    vi.stubGlobal('fetch', fetchMock)
    const config = relayConfig(['my-custom-image-model'])
    const channel = config.openaiCompatChannels![0]!
    await primeChannelModels(keyCtx('sk-relay'), config, channel)
    await primeChannelModels(keyCtx('sk-relay'), config, channel)
    // Failure is cached for the TTL, so a re-render does not re-dial a dead relay.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const result = withCachedChannelModels(config)
    expect(result.config.openaiCompatChannels?.[0]?.models).toEqual(['my-custom-image-model'])
    expect(result.pending).toEqual([])
  })

  it('ignores a non-JSON body instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 200 })))
    const config = relayConfig(['my-custom-image-model'])
    await primeChannelModels(keyCtx('sk-relay'), config, config.openaiCompatChannels![0]!)
    expect(withCachedChannelModels(config).config.openaiCompatChannels?.[0]?.models).toEqual(['my-custom-image-model'])
  })

  it('leaves a row with no base URL alone and never probes it', async () => {
    const fetchMock = vi.fn(async () => catalog('flux-pro-1.1'))
    vi.stubGlobal('fetch', fetchMock)
    const config = { provider: 'openai-compat', openaiCompatBaseURL: '', openaiCompatModels: [], openaiCompatChannels: [] } as Config
    const probed = await primeChannelModels(keyCtx('sk-relay'), config, { id: 'default', label: '', keyRef: 'K', baseURL: '', model: '', models: [] })
    expect(probed).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(withCachedChannelModels(config).config).toBe(config)
  })

  it('does not cache the absence of a key, so filling it in starts discovery', async () => {
    const config = relayConfig(['my-custom-image-model'])
    const channel = config.openaiCompatChannels![0]!
    // No key stored yet: nothing to try and nothing to remember.
    await primeChannelModels(keyCtx(undefined), config, channel)
    expect(withCachedChannelModels(config).pending.map(row => row.id)).toEqual(['relay'])

    const fetchMock = vi.fn(async () => catalog('flux-pro-1.1'))
    vi.stubGlobal('fetch', fetchMock)
    // Same channel, key now stored: the very next prime must dial the relay.
    await primeChannelModels(keyCtx('sk-relay'), config, channel)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(withCachedChannelModels(config).config.openaiCompatChannels?.[0]?.models).toEqual([
      'my-custom-image-model',
      'flux-pro-1.1',
    ])
  })

  it('writes nothing back into the persisted config when priming widens it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog('flux-pro-1.1')))
    const config = relayConfig(['my-custom-image-model'])
    const before = JSON.stringify(config)
    await primeChannelModels(keyCtx('sk-relay'), config, config.openaiCompatChannels![0]!)
    const widened = withCachedChannelModels(config).config
    // Discovery decorates the read path; the object the caller owns is untouched.
    expect(JSON.stringify(config)).toBe(before)
    expect(widened).not.toBe(config)
  })

  it('discovers official row models through the vendor catalog filter', async () => {
    const fetchMock = vi.fn(async () => catalog('glm-image', 'cogview-4', 'glm-4-air'))
    vi.stubGlobal('fetch', fetchMock)
    const config = { provider: 'zhipu', zhipuBaseURL: 'https://relay.example.com/v1' } as Config
    const models = await discoverOfficialModels(keyCtx('sk-zhipu'), config, 'zhipu')
    // The zhipu vendor filter keeps only the GLM-Image/CogView families, so the
    // official row widens with exactly what that vendor would accept.
    expect(models).toEqual(['glm-image', 'cogview-4'])
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://relay.example.com/v1/models')
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe('Bearer sk-zhipu')
  })

  it('has no catalog to offer for a provider that does not publish one', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const config = {} as Config
    for (const provider of ['comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'] as const) {
      await expect(discoverOfficialModels(keyCtx('sk-any'), config, provider)).resolves.toEqual([])
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves an official row untouched when that provider has no stored key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const config = { zhipuModel: 'glm-image' } as Config
    const start = withCachedOfficialModels('zhipu', config, ['glm-image'], undefined)
    expect(start.modelOptions).toEqual(['glm-image'])
    expect(start.stale).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(withCachedChannelModels(config).pending).toEqual([])
  })

  it('widens the legacy flat default channel, which is not stored in the array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog('relay-only-image-model')))
    const config = {
      provider: 'openai-compat',
      openaiCompatBaseURL: RELAY,
      openaiCompatKeyRef: 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY',
      openaiCompatModels: ['flux-pro-1.1'],
      openaiCompatChannels: [],
    } as Config
    await primeChannelModels(keyCtx('sk-relay'), config, {
      id: 'default', label: '', keyRef: 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY', baseURL: RELAY,
      model: 'flux-pro-1.1', models: ['flux-pro-1.1'],
    } as any)
    // The flat row is rebuilt from the flat fields, so its catalog lands there.
    expect(withCachedChannelModels(config).config.openaiCompatModels).toEqual([
      'flux-pro-1.1', 'relay-only-image-model',
    ])
  })

  it('keeps the previous catalog when a refresh fails or returns non-JSON', async () => {
    const config = relayConfig([])
    const channel = config.openaiCompatChannels![0]!
    vi.stubGlobal('fetch', vi.fn(async () => catalog('seedream-4.0')))
    await primeChannelModels(keyCtx('sk-relay'), config, channel)
    const past = Date.now() - 6 * 60_000
    // Expire the entry by probing with a clock ahead of its TTL.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await primeChannelModels(keyCtx('sk-relay'), config, channel, past + 11 * 60_000)
    expect(withCachedChannelModels(config).config.openaiCompatChannels?.[0]?.models).toEqual(['seedream-4.0'])
    // An unparsable 200 is not a successful catalog either.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 200 })))
    await primeChannelModels(keyCtx('sk-relay'), config, channel, past + 21 * 60_000)
    expect(withCachedChannelModels(config).config.openaiCompatChannels?.[0]?.models).toEqual(['seedream-4.0'])
  })

  it('lets the validation profile accept a model that discovery offered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog('relay-only-image-model')))
    const config = relayConfig([])
    await primeChannelModels(keyCtx('sk-relay'), config, config.openaiCompatChannels![0]!)
    const profile = { provider: 'openai-compat', channel: 'relay', model: 'flux-pro-1.1' } as any
    const widened = widenProfileModels(profile, config)
    expect(widened.profile.modelOptions.map((o: any) => o.value)).toContain('relay-only-image-model')
  })
})
