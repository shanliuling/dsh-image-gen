import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  forgetDiscoveredChannelModels,
  primeChannelModels,
  withCachedChannelModels,
} from '../src/channel-model-discovery.js'
import type { Config } from '../src/config.js'

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
})
