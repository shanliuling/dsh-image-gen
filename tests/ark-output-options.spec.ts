import { afterEach, describe, expect, it, vi } from 'vitest'
import { arkOutputBody } from '../src/shared.js'
import { generateOpenAICompatibleImage } from '../src/openai-compatible.js'
import { editSeedreamImage } from '../src/seedream.js'

const signal = new AbortController().signal

afterEach(() => { vi.unstubAllGlobals() })

/** A fetch mock that answers any image request with one base64 image. */
function stubImageFetch() {
  const image = Buffer.from('image bytes').toString('base64')
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(init.body as string)
}

const SEEDREAM = { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-260128' }

describe('arkOutputBody', () => {
  it('emits nothing when no options are configured', () => {
    expect(arkOutputBody(undefined)).toEqual({})
  })

  it('always forwards output format and watermark, because both have an Ark default', () => {
    expect(arkOutputBody({ outputFormat: 'png', watermark: false }))
      .toEqual({ output_format: 'png', watermark: false })
  })

  it('forwards the Ark defaults verbatim, so an untouched config changes no request', () => {
    expect(arkOutputBody({ outputFormat: 'jpeg', watermark: true, background: 'opaque' }))
      .toEqual({ output_format: 'jpeg', watermark: true })
  })

  // Ark restricts `background: transparent` to image-to-image with an
  // alpha-bearing reference. Forwarding the inert default would only create a
  // way for text-to-image calls to fail.
  it('sends background only when it asks for transparency', () => {
    expect(arkOutputBody({ background: 'transparent' })).toEqual({ background: 'transparent' })
    expect(arkOutputBody({ background: 'opaque' })).toEqual({})
  })
})

describe('Ark output options reach the request body', () => {
  it('adds them to the Seedream text-to-image call', async () => {
    const fetchMock = stubImageFetch()
    await generateOpenAICompatibleImage({
      provider: 'seedream', apiKey: 'ark-key', ...SEEDREAM,
      prompt: 'a sword', size: '1536x1536', maxBytes: 1024, signal,
      arkOptions: { outputFormat: 'png', watermark: false, background: 'opaque' },
    })
    expect(bodyOf(fetchMock)).toMatchObject({
      model: 'doubao-seedream-5-0-260128',
      size: '1536x1536',
      response_format: 'url',
      output_format: 'png',
      watermark: false,
    })
    expect(bodyOf(fetchMock).background).toBeUndefined()
  })

  it('adds them to the Seedream edit call, including a transparent background', async () => {
    const fetchMock = stubImageFetch()
    await editSeedreamImage({
      apiKey: 'ark-key', ...SEEDREAM, prompt: 'cut it out',
      sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }],
      size: '2K', maxBytes: 1024, signal,
      arkOptions: { outputFormat: 'png', watermark: false, background: 'transparent' },
    })
    expect(bodyOf(fetchMock)).toMatchObject({
      response_format: 'b64_json',
      output_format: 'png',
      watermark: false,
      background: 'transparent',
    })
  })

  it('leaves a non-Seedream provider untouched', async () => {
    const fetchMock = stubImageFetch()
    await generateOpenAICompatibleImage({
      provider: 'openai', apiKey: 'key', baseURL: 'https://api.openai.com/v1', model: 'gpt-image-2',
      prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal,
      arkOptions: { outputFormat: 'png', watermark: false },
    })
    const body = bodyOf(fetchMock)
    expect(body.output_format).toBeUndefined()
    expect(body.watermark).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })

  it('omits the Ark fields entirely when no options are passed', async () => {
    const fetchMock = stubImageFetch()
    await generateOpenAICompatibleImage({
      provider: 'seedream', apiKey: 'ark-key', ...SEEDREAM,
      prompt: 'a sword', size: '2K', maxBytes: 1024, signal,
    })
    const body = bodyOf(fetchMock)
    expect(body.output_format).toBeUndefined()
    expect(body.watermark).toBeUndefined()
    expect(body.background).toBeUndefined()
  })
})

// Ark rejects `transparent` on images/generations outright:
//   400 InvalidParameter "transparent background requires exactly one input image"
// so the generation endpoint must drop the field even when the settings ask for it.
describe('Ark transparent background stays on the edit path', () => {
  it('drops background from a generation request that asks for transparency', async () => {
    const fetchMock = stubImageFetch()
    await generateOpenAICompatibleImage({
      provider: 'seedream', apiKey: 'ark-key', ...SEEDREAM,
      prompt: 'a sword', size: '1024x1024', maxBytes: 1024, signal,
      arkOptions: { outputFormat: 'png', watermark: false, background: 'transparent' },
    })
    const body = bodyOf(fetchMock)
    expect(body.background).toBeUndefined()
    // The other two controls still travel; only background is endpoint-specific.
    expect(body.output_format).toBe('png')
    expect(body.watermark).toBe(false)
  })

  it('omits background when the caller opts out', () => {
    expect(arkOutputBody({ background: 'transparent' }, { background: false })).toEqual({})
    expect(arkOutputBody({ outputFormat: 'png', background: 'transparent' }, { background: false }))
      .toEqual({ output_format: 'png' })
  })
})
