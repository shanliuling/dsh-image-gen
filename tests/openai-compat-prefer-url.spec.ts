/**
 * Regression tests for the url-first mode on OpenAI-compatible relays.
 *
 * Some relays inline 1.5–3MB of base64. On a slow link the body is cut off
 * mid-stream and the request fails with `invalid JSON` even though the image was
 * generated and billed server-side. Asking for a URL shrinks the response to a
 * few hundred bytes; if that URL cannot be downloaded (CDN unreachable) the
 * request is retried without the field so the relay inlines base64 instead.
 *
 * Everything here is stubbed — no network.
 */
import { describe, expect, it, vi } from 'vitest'
import { generateOpenAICompatibleImage } from '../src/openai-compatible.js'
import { withOpenAICompatChannel } from '../src/config.js'
import type { Config } from '../src/config.js'

const signal = AbortSignal.timeout(5000)
const image = Buffer.from('image bytes').toString('base64')

function generationCall(preferUrl?: boolean, extraBody?: Record<string, unknown>) {
  return generateOpenAICompatibleImage({
    provider: 'openai-compat',
    apiKey: 'key',
    baseURL: 'https://relay.example/v1',
    model: 'image-model',
    prompt: 'a cat',
    maxBytes: 60_000,
    signal,
    ...(preferUrl === undefined ? {} : { preferUrl }),
    ...(extraBody === undefined ? {} : { extraBody }),
  })
}

/** The generations body the plugin sent on call `index`. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as Record<string, unknown>
}

describe('preferUrl: request shape', () => {
  it('sends response_format=url when enabled', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/a.png' }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    // Point the download at the same mock so the request resolves.
    fetchMock.mockImplementation(async (url: unknown) => String(url).includes('cdn.example')
      ? new Response(new Uint8Array(Buffer.from('image bytes')), { headers: { 'content-type': 'image/png' } })
      : new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/a.png' }] }), { headers: { 'content-type': 'application/json' } }))
    await generationCall(true)
    expect(bodyOf(fetchMock, 0).response_format).toBe('url')
  })

  it('omits response_format when the option is off or absent', async () => {
    for (const flag of [false, undefined]) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      await generationCall(flag)
      expect(bodyOf(fetchMock, 0)).not.toHaveProperty('response_format')
    }
  })

  it("never overrides a channel's explicit response_format", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await generationCall(true, { response_format: 'b64_json' })
    expect(bodyOf(fetchMock, 0).response_format).toBe('b64_json')
  })
})

describe('preferUrl: fallback', () => {
  it('retries without response_format when the URL cannot be downloaded', async () => {
    let generationCalls = 0
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('cdn.example')) return new Response('gone', { status: 404 })
      generationCalls += 1
      // First call asks for url and returns an unreachable CDN; the retry omits
      // response_format and inlines base64.
      return generationCalls === 1
        ? new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/a.png' }] }), { headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generationCall(true)
    expect(result.data).toEqual(new Uint8Array(Buffer.from('image bytes')))
    expect(generationCalls).toBe(2)
    const bodies = fetchMock.mock.calls.filter(call => !String(call[0]).includes('cdn.example'))
    expect(bodyOf(fetchMock, fetchMock.mock.calls.indexOf(bodies[0]))).toHaveProperty('response_format', 'url')
    expect(bodyOf(fetchMock, fetchMock.mock.calls.indexOf(bodies[1]))).not.toHaveProperty('response_format')
  })

  it('does not retry when the relay rejects the request itself', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"bad model"}', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generationCall(true)).rejects.toThrow(/failed \(400\)/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the rejection body merely looks like a download failure', async () => {
    // `image request failed (status): <body>` embeds the relay's own text, so a
    // naive message match would treat this 500 as a download failure and start a
    // second, separately billed generation.
    const fetchMock = vi.fn(async () => new Response('{"error":"image download failed"}', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generationCall(true)).rejects.toThrow(/failed \(500\)/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the rejection body mentions invalid JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"upstream returned invalid JSON"}', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generationCall(true)).rejects.toThrow(/failed \(502\)/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("makes a single attempt when the channel names the format itself", async () => {
    // extraBody.response_format is the channel's own decision; retrying cannot
    // change the format and would bill a second generation for the same failure.
    let generationCalls = 0
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('cdn.example')) return new Response('gone', { status: 404 })
      generationCalls += 1
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/a.png' }] }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(generationCall(true, { response_format: 'url' })).rejects.toThrow(/download failed/)
    expect(generationCalls).toBe(1)
  })

  it('does not retry a request failure when the option is off', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"boom"}', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generationCall(false)).rejects.toThrow(/failed \(500\)/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('openaiCompatPreferUrl: channel projection is tri-state', () => {
  const channel = (preferUrl?: boolean) => ({ id: 'ch', label: 'CH', baseURL: 'https://relay.example/v1', model: 'm', ...(preferUrl === undefined ? {} : { preferUrl }) })

  it('inherits the global switch when the channel leaves it unset', () => {
    expect(withOpenAICompatChannel({ openaiCompatPreferUrl: true, openaiCompatChannels: [channel()] } as Config, 'ch').openaiCompatPreferUrl).toBe(true)
    expect(withOpenAICompatChannel({ openaiCompatPreferUrl: false, openaiCompatChannels: [channel()] } as Config, 'ch').openaiCompatPreferUrl).toBe(false)
  })

  it('lets a channel opt in while the global switch is off', () => {
    expect(withOpenAICompatChannel({ openaiCompatPreferUrl: false, openaiCompatChannels: [channel(true)] } as Config, 'ch').openaiCompatPreferUrl).toBe(true)
  })

  it('lets a channel opt out while the global switch is on', () => {
    expect(withOpenAICompatChannel({ openaiCompatPreferUrl: true, openaiCompatChannels: [channel(false)] } as Config, 'ch').openaiCompatPreferUrl).toBe(false)
  })
})
