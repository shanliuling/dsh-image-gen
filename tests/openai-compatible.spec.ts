import { afterEach, describe, expect, it, vi } from 'vitest'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from '../src/openai-compatible.js'

afterEach(() => { vi.unstubAllGlobals() })
const signal = new AbortController().signal

describe('OpenAI-compatible images', () => {
  it('posts a standard OpenAI image request and accepts base64 output', async () => {
    const image = Buffer.from('image bytes').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array(Buffer.from('image bytes')), mediaType: 'image/png' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://relay.example/v1/images/generations')
  })

  it('uses multipart /images/edits with the source image', async () => {
    const image = Buffer.from('edited image').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editOpenAICompatibleImage({
      apiKey: 'key', baseURL: 'https://api.openai.com/v1', model: 'gpt-image-2', prompt: 'add sunglasses',
      sourceImages: [
        { data: new Uint8Array(Buffer.from('source 1')), mediaType: 'image/png' },
        { data: new Uint8Array(Buffer.from('source 2')), mediaType: 'image/jpeg' },
      ],
      size: '1024x1024', maxBytes: 1024, signal,
    })).resolves.toEqual({ data: new Uint8Array(Buffer.from('edited image')), mediaType: 'image/png' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/images/edits')
    expect(init.headers).toMatchObject({ authorization: 'Bearer key' })
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
    const form = init.body as FormData
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toBe('add sunglasses')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.getAll('image[]')).toHaveLength(2)
    expect(form.getAll('image[]')[0]).toBeInstanceOf(Blob)
  })

  it('keeps the singular multipart image field for one reference', async () => {
    const image = Buffer.from('edited image').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await editOpenAICompatibleImage({
      apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'edit',
      sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }],
      maxBytes: 1024, signal,
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('image')).toBeInstanceOf(Blob)
    expect(form.getAll('image[]')).toHaveLength(0)
  })

  it.each([1, 2])('sends xAI edit with %i reference image(s) as JSON', async count => {
    const encoded = Buffer.from('edited image').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: encoded }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const sourceImages = Array.from({ length: count }, (_, i) => ({ data: new Uint8Array([i + 1]), mediaType: 'image/png' as const }))
    await editOpenAICompatibleImage({
      apiKey: 'key', baseURL: 'https://api.x.ai/v1', model: 'grok-imagine-image-2.0', prompt: 'edit', sourceImages,
      maxBytes: 1024, signal, editFormat: 'xaiJson', extraBody: { aspect_ratio: '9:16', resolution: '2k' },
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.x.ai/v1/images/edits')
    expect(init.headers).toMatchObject({ authorization: 'Bearer key', 'content-type': 'application/json' })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.aspect_ratio).toBe('9:16')
    expect(body.resolution).toBe('2k')
    expect(body.size).toBeUndefined()
    const expected = sourceImages.map(image => ({ type: 'image_url', url: `data:image/png;base64,${Buffer.from(image.data).toString('base64')}` }))
    if (count === 1) {
      expect(body.image).toEqual(expected[0])
      expect(body.images).toBeUndefined()
    } else {
      expect(body.images).toEqual(expected)
      expect(body.image).toBeUndefined()
    }
  })

  it('downloads Ark URL output with its declared media type', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://image.example/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'seedream', apiKey: 'key', baseURL: 'https://ark.example/api/v3', model: 'seedream', prompt: 'a cat', size: '2K', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array([1, 2]), mediaType: 'image/jpeg' })
  })

  it('resolves a relative image URL against the configured base URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: '/v1/images/example-id/content' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([5, 6]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'http://127.0.0.1:30010/v1', model: 'image-model', prompt: 'a cat', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array([5, 6]), mediaType: 'image/png' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:30010/v1/images/example-id/content')
  })

  it('falls back to the origin path when the relay drops /v1', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: '/v1/media/example' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array([7, 8]), mediaType: 'image/png' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://relay.example/v1/media/example')
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://relay.example/media/example')
  })

  it('keeps authorization on same-origin image downloads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://relay.example/assets/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 1024, signal })
    const downloadCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(downloadCall[1]?.headers).toEqual({ authorization: 'Bearer key' })
  })

  it('never sends the provider key to a cross-origin image URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', maxBytes: 1024, signal })
    const downloadCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(downloadCall[1]?.headers).toBeUndefined()
  })

  // Relays can omit mime_type while returning non-PNG bytes (Ark jpeg): the
  // declared mediaType is sniffed from the bytes, not assumed to be PNG (#61).
  it('sniffs jpeg from base64 bytes when the relay omits mime_type', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(jpeg).toString('base64') }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).resolves.toEqual({ data: jpeg, mediaType: 'image/jpeg' })
  })

  it('sniffs the media type from a data-URL image body', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 8])
    const dataUrl = `data:image/png;base64,${Buffer.from(jpeg).toString('base64')}`
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ url: dataUrl }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'image-model', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).resolves.toEqual({ data: jpeg, mediaType: 'image/jpeg' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Same-origin relays that reject Authorization on public image URLs (#37):
  // the authenticated download gets a 401/403, the retry without the header succeeds.
  it('retries a same-origin image download without the auth header after 401', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://relay.example/assets/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([3, 4]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'agnes-image', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array([3, 4]), mediaType: 'image/png' })
    const downloadCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(downloadCall[1]?.headers).toEqual({ authorization: 'Bearer key' })
    const retryCall = fetchMock.mock.calls[2] as unknown as [string, RequestInit]
    expect(retryCall[1]?.headers).toBeUndefined()
  })

  it('retries a same-origin image download without the auth header after 403', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://relay.example/assets/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([5]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'agnes-image', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array([5]), mediaType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // Since #41 the retry is broader: any failed authenticated download retries
  // once without the header (some relays reject it with 400/500, not just 401/403).
  // A still-failing retry surfaces the same error as before.
  it('retries a same-origin 500 download once without the auth header before failing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://relay.example/assets/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'agnes-image', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).rejects.toThrow('image download failed (500)')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const retryCall = fetchMock.mock.calls[2] as unknown as [string, RequestInit]
    expect(retryCall[1]?.headers).toBeUndefined()
  })

  it('retries a same-origin image download without the auth header after 400', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://token.sensenova.cn/assets/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://token.sensenova.cn/v1', model: 'sensenova-u1.5-lite', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array([9]), mediaType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // Some channels (e.g. SenseNova) run edits on their own JSON contract with
  // `images: [{ image_url }]` objects instead of OpenAI's multipart form (#41).
  it('posts a JSON images-array edit body in jsonImageUrlArray mode', async () => {
    const image = Buffer.from('edited image').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editOpenAICompatibleImage({
      apiKey: 'key', baseURL: 'https://token.sensenova.cn/v1', model: 'sensenova-u1.5-lite', prompt: 'add sunglasses',
      sourceImages: [{ data: new Uint8Array(Buffer.from('source 1')), mediaType: 'image/png' }],
      maxBytes: 1024, signal,
      editFormat: 'jsonImageUrlArray',
    })).resolves.toEqual({ data: new Uint8Array(Buffer.from('edited image')), mediaType: 'image/png' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://token.sensenova.cn/v1/images/edits')
    expect(init.headers).toMatchObject({ authorization: 'Bearer key', 'content-type': 'application/json' })
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.model).toBe('sensenova-u1.5-lite')
    expect(body.prompt).toBe('add sunglasses')
    expect(body.n).toBe(1)
    expect(body.size).toBe('auto')
    expect(body.response_format).toBe('url')
    expect(body.images).toEqual([{ image_url: 'data:image/png;base64,' + Buffer.from('source 1').toString('base64') }])
  })

  it('merges editExtra into the JSON edit body last so it can override defaults', async () => {
    const image = Buffer.from('edited image').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await editOpenAICompatibleImage({
      apiKey: 'key', baseURL: 'https://token.sensenova.cn/v1', model: 'sensenova-u1.5-lite', prompt: 'edit',
      sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }],
      maxBytes: 1024, signal,
      editFormat: 'jsonImageUrlArray',
      editExtra: { size: '2048x2048', watermark: false, prompt_extend: true },
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    // The built-in "auto" default is overridden by editExtra...
    expect(body.size).toBe('2048x2048')
    expect(body.watermark).toBe(false)
    expect(body.prompt_extend).toBe(true)
    // ...while untouched defaults survive.
    expect(body.response_format).toBe('url')
  })

  // SenseNova documents "auto" as the only accepted size on the edits
  // endpoint (#41), so the caller's generation size must not be forwarded
  // in this format - not even the tool path's default 1024x1024.
  it('forces size to auto in jsonImageUrlArray mode even when a size is passed', async () => {
    const image = Buffer.from('edited image').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: image }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await editOpenAICompatibleImage({
      apiKey: 'key', baseURL: 'https://token.sensenova.cn/v1', model: 'sensenova-u1.5-lite', prompt: 'edit',
      sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }],
      size: '1024x1024', maxBytes: 1024, signal,
      editFormat: 'jsonImageUrlArray',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.size).toBe('auto')
  })

  // Empty-string fields must not shadow a usable sibling value (#41 note).
  it('falls back to url when b64_json is an empty string', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: '', url: 'https://cdn.example/fallback' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 7]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'model', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).resolves.toEqual({ data: new Uint8Array([7, 7]), mediaType: 'image/png' })
  })

  it('reports no image when both b64_json and url are empty strings', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: '', url: '' }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'model', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).rejects.toThrow('returned no image')
  })

  it('gives up when the same-origin unauthenticated retry also fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://relay.example/assets/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1', model: 'agnes-image', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal })).rejects.toThrow('image download failed (401)')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
