import { afterEach, describe, expect, it, vi } from 'vitest'
import { editNvidiaImage, generateNvidiaImage } from '../src/nvidia.js'

const signal = new AbortController().signal
const endpoint = 'https://ai.api.nvidia.com/v1'
const model = 'black-forest-labs/flux-3-image-klein'
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function okArtifact(bytes: Buffer): unknown {
  return { artifacts: [{ base64: bytes.toString('base64'), finishReason: 'SUCCESS' }] }
}

describe('generateNvidiaImage', () => {
  it('posts the ImageRequest schema to the genai endpoint and decodes the JPEG artifact', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okArtifact(jpegBytes)))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateNvidiaImage({
      apiKey: 'nvapi-test', endpoint, model, prompt: 'a coffee shop interior', size: '1024x1024', maxBytes: 1024 * 1024, signal,
    })

    expect(result.mediaType).toBe('image/jpeg')
    expect(result.data).toEqual(new Uint8Array(jpegBytes))

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein')
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer nvapi-test',
    })
    expect(JSON.parse(init.body as string)).toEqual({ prompt: 'a coffee shop interior', width: 1024, height: 1024 })
  })

  it('rejects sizes outside the schema limits before any request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okArtifact(jpegBytes)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateNvidiaImage({
      apiKey: 'nvapi-test', endpoint, model, prompt: 'x', size: '1600x1600', maxBytes: 1024 * 1024, signal,
    })).rejects.toThrow('outside 512-1568 or not a multiple of 16')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces CONTENT_FILTERED as a user-facing error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ artifacts: [{ base64: jpegBytes.toString('base64'), finishReason: 'CONTENT_FILTERED' }] })))
    await expect(generateNvidiaImage({
      apiKey: 'nvapi-test', endpoint, model, prompt: 'x', maxBytes: 1024 * 1024, signal,
    })).rejects.toThrow('CONTENT_FILTERED')
  })

  it('reports HTTP errors with the redacted body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'bad nvapi key' }, { status: 401 })))
    await expect(generateNvidiaImage({
      apiKey: 'nvapi-test', endpoint, model, prompt: 'x', maxBytes: 1024 * 1024, signal,
    })).rejects.toThrow('(401)')
  })
})

describe('editNvidiaImage', () => {
  it('sends reference images as data URLs in the image array', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(okArtifact(jpegBytes)))
    vi.stubGlobal('fetch', fetchMock)
    const source = { data: new Uint8Array(jpegBytes), mediaType: 'image/jpeg' as const }

    await editNvidiaImage({
      apiKey: 'nvapi-test', endpoint, model, prompt: 'make the sail blue', size: '1024x1024', sourceImages: [source], maxBytes: 1024 * 1024, signal,
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'make the sail blue',
      width: 1024,
      height: 1024,
      image: [`data:image/jpeg;base64,${jpegBytes.toString('base64')}`],
    })
  })

  it('rejects more than ten reference images', async () => {
    const sources = Array.from({ length: 11 }, () => ({ data: new Uint8Array(jpegBytes), mediaType: 'image/jpeg' as const }))
    await expect(editNvidiaImage({
      apiKey: 'nvapi-test', endpoint, model, prompt: 'x', sourceImages: sources, maxBytes: 1024 * 1024, signal,
    })).rejects.toThrow('at most 10 reference images')
  })
})
