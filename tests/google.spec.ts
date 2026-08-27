import { afterEach, describe, expect, it, vi } from 'vitest'
import { editGoogleImage, generateGoogleImage } from '../src/google.js'

const signal = new AbortController().signal
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions'
const image = Buffer.from('image bytes').toString('base64')

afterEach(() => { vi.unstubAllGlobals() })

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('generateGoogleImage', () => {
  it('requests JPEG with the selected output controls', async () => {
    const fetchMock = vi.fn(async () => response({ output_image: { data: image, mime_type: 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateGoogleImage({
      apiKey: 'gemini-key', endpoint, model: 'gemini-3.1-flash-image', prompt: 'a bright cat', aspectRatio: '16:9', imageSize: '2K', maxBytes: 1024, signal,
    })).resolves.toEqual({ data: new Uint8Array(Buffer.from('image bytes')), mediaType: 'image/jpeg' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(endpoint)
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-goog-api-key': 'gemini-key' })
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gemini-3.1-flash-image',
      input: 'a bright cat',
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '2K' },
    })
  })
  it('sends resolved reference bytes for image editing', async () => {
    const fetchMock = vi.fn(async () => response({ output_image: { data: image, mime_type: 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editGoogleImage({
      apiKey: 'gemini-key',
      endpoint,
      model: 'gemini-3.1-flash-image',
      prompt: 'add black sunglasses',
      sourceImages: [
        { data: new Uint8Array(Buffer.from('source image 1')), mediaType: 'image/png' },
        { data: new Uint8Array(Buffer.from('source image 2')), mediaType: 'image/jpeg' },
      ],
      aspectRatio: '1:1',
      imageSize: '1K',
      maxBytes: 1024,
      signal,
    })).resolves.toMatchObject({ mediaType: 'image/jpeg' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gemini-3.1-flash-image',
      input: [
        { type: 'text', text: 'add black sunglasses' },
        { type: 'image', mime_type: 'image/png', data: Buffer.from('source image 1').toString('base64') },
        { type: 'image', mime_type: 'image/jpeg', data: Buffer.from('source image 2').toString('base64') },
      ],
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' },
    })
  })

  it('reads image data from a steps response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'image', data: image, mime_type: 'image/jpeg' }] }],
    })))
    await expect(generateGoogleImage({
      apiKey: 'key', endpoint, model: 'model', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal,
    })).resolves.toMatchObject({ mediaType: 'image/jpeg' })
  })

  it('includes an upstream error body in the diagnostic', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'bad key' } }, { status: 403 })))
    await expect(generateGoogleImage({
      apiKey: 'key', endpoint, model: 'model', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal,
    })).rejects.toThrow('Google image generation failed (403): {"error":{"message":"bad key"}}')
  })

  it('reports the real successful response when it contains no image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ status: 'completed', output_text: 'blocked by policy' })))
    await expect(generateGoogleImage({
      apiKey: 'key', endpoint, model: 'model', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal,
    })).rejects.toThrow('Google image generation returned no image: {"status":"completed","output_text":"blocked by policy"}')
  })
})
