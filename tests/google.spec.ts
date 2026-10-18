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
  it('keeps native gateway prefixes and query parameters when a per-call model changes', async () => {
    const fetchMock = vi.fn(async () => response({ candidates: [{ content: { parts: [{ inlineData: { data: image, mimeType: 'image/png' } }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await generateGoogleImage({ apiKey: 'key', endpoint: 'https://relay.example/proxy/v1beta/models/old:generateContent/?route=image', native: true, model: 'gemini-new', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://relay.example/proxy/v1beta/models/gemini-new:generateContent?route=image')
  })

  it.each([
    { data: Buffer.alloc(1025).toString('base64'), mimeType: 'image/png', message: 'exceeded the 1024 byte image limit' },
    { data: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml', message: 'unsupported media type' },
  ])('applies the existing image limits and MIME checks to native output: $message', async imageData => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ candidates: [{ content: { parts: [{ inlineData: imageData }] } }] })))
    await expect(generateGoogleImage({ apiKey: 'key', endpoint, native: true, model: 'gemini', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal })).rejects.toThrow(imageData.message)
  })

  it.each([
    'https://relay.example/v1beta',
    'https://relay.example/v1beta/',
    'https://relay.example/v1beta/interactions',
    'https://relay.example/v1beta/models',
    'https://relay.example/v1beta/models/old-model:generateContent',
  ])('supports the native protocol at %s', async nativeEndpoint => {
    const fetchMock = vi.fn(async () => response({ candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { data: image, mimeType: 'image/png' } }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateGoogleImage({
      apiKey: 'key', endpoint: nativeEndpoint, native: true, model: 'models/gemini-3-pro-image', prompt: 'cat', aspectRatio: '16:9', imageSize: '2K', maxBytes: 1024, signal,
    })).resolves.toMatchObject({ mediaType: 'image/png' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://relay.example/v1beta/models/gemini-3-pro-image:generateContent')
    expect(init.signal).toBe(signal)
    expect(init.redirect).toBe('error')
    expect(JSON.parse(String(init.body))).toEqual({ contents: [{ role: 'user', parts: [{ text: 'cat' }] }], generationConfig: {
      candidateCount: 1, responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    } })
  })

  it('sends ordered native reference images before the edit prompt', async () => {
    const fetchMock = vi.fn(async () => response({ candidates: [{ content: { parts: [{ inlineData: { data: image, mimeType: 'image/png' } }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(editGoogleImage({ apiKey: 'key', endpoint, native: true, model: 'gemini-3-pro-image', prompt: 'edit image 2',
      sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }, { data: new Uint8Array([2]), mediaType: 'image/jpeg' }],
      aspectRatio: '1:1', imageSize: '4K', maxBytes: 1024, signal,
    })).resolves.toMatchObject({ mediaType: 'image/png' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body)).contents[0].parts).toEqual([
      { inlineData: { data: 'AQ==', mimeType: 'image/png' } },
      { inlineData: { data: 'Ag==', mimeType: 'image/jpeg' } },
      { text: 'edit image 2' },
    ])
  })

  it('skips native thought images and recognizes snake-case relay output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ candidates: [{ content: { parts: [
      { thought: true, inlineData: { data: 'dGhvdWdodA==', mimeType: 'image/jpeg' } },
      { inline_data: { data: image, mime_type: 'image/png' } },
    ] } }] })))
    await expect(generateGoogleImage({ apiKey: 'key', endpoint, native: true, model: 'gemini', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal }))
      .resolves.toEqual({ data: new Uint8Array(Buffer.from('image bytes')), mediaType: 'image/png' })
  })

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
  it.each([undefined, 'image/jpeg', 'application/octet-stream'])('uses PNG bytes ahead of declared type %s', async (mimeType) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    vi.stubGlobal('fetch', vi.fn(async () => response({
      output_image: { data: png.toString('base64'), mime_type: mimeType },
    })))
    await expect(generateGoogleImage({
      apiKey: 'key', endpoint, model: 'model', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal,
    })).resolves.toEqual({ data: new Uint8Array(png), mediaType: 'image/png' })
  })

  it.each([undefined, null])('preserves the JPEG fallback for absent declared type %s', async (mimeType) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ output_image: { data: image, mime_type: mimeType } })))
    await expect(generateGoogleImage({
      apiKey: 'key', endpoint, model: 'model', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal,
    })).resolves.toMatchObject({ mediaType: 'image/jpeg' })
  })

  it('rejects an explicitly unsupported format when the bytes cannot be recognized', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    vi.stubGlobal('fetch', vi.fn(async () => response({ output_image: { data: svg, mime_type: 'image/svg+xml' } })))
    await expect(generateGoogleImage({
      apiKey: 'key', endpoint, model: 'model', prompt: 'cat', aspectRatio: '1:1', imageSize: '1K', maxBytes: 1024, signal,
    })).rejects.toThrow('Google image generation returned unsupported media type "image/svg+xml"')
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
        { type: 'text', text: '图 1 (Image 1):' },
        { type: 'image', mime_type: 'image/png', data: Buffer.from('source image 1').toString('base64') },
        { type: 'text', text: '图 2 (Image 2):' },
        { type: 'image', mime_type: 'image/jpeg', data: Buffer.from('source image 2').toString('base64') },
        { type: 'text', text: 'add black sunglasses' },
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
