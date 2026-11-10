import { afterEach, describe, expect, it, vi } from 'vitest'
import { editSeedreamImage } from '../src/seedream.js'

const signal = new AbortController().signal

afterEach(() => { vi.unstubAllGlobals() })

describe('editSeedreamImage', () => {
  it('uses Ark images/generations with a data-url image array', async () => {
    const output = Buffer.from('edited').toString('base64')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: output }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editSeedreamImage({
      apiKey: 'ark-key', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-260128',
      prompt: 'change the background', sourceImages: [
        { data: new Uint8Array(Buffer.from('source 1')), mediaType: 'image/jpeg' },
        { data: new Uint8Array(Buffer.from('source 2')), mediaType: 'image/png' },
      ],
      size: '2K', maxBytes: 1024, signal,
    })).resolves.toEqual({ data: new Uint8Array(Buffer.from('edited')), mediaType: 'image/png' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    expect(init.headers).toMatchObject({ authorization: 'Bearer ark-key', 'content-type': 'application/json' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      model: 'doubao-seedream-5-0-260128', prompt: 'change the background', size: '2K', response_format: 'b64_json',
    })
    expect(body.image).toHaveLength(2)
    expect(body.image[0]).toMatch(/^data:image\/jpeg;base64,/)
    expect(body.image[1]).toMatch(/^data:image\/png;base64,/)
    expect(body.resolution).toBeUndefined()
  })

  // Ark never returns mime_type and its bytes follow output_format (jpeg by
  // default): the declared mediaType must be sniffed from the bytes, or the
  // host attachment service rejects them with IMAGE_TYPE_MISMATCH (#61).
  it('sniffs the media type from Ark base64 bytes without mime_type', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(jpeg).toString('base64') }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editSeedreamImage({
      apiKey: 'ark-key', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-260128',
      prompt: 'edit', sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }],
      maxBytes: 1024, signal,
    })).resolves.toEqual({ data: jpeg, mediaType: 'image/jpeg' })
  })

  // Empty-string fields must not shadow a usable sibling value (#41 note).
  it('falls back to url when b64_json is an empty string', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: '', url: 'https://ark-cdn.example/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([8, 8]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editSeedreamImage({
      apiKey: 'ark-key', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-260128',
      prompt: 'edit', sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }],
      maxBytes: 1024, signal,
    })).resolves.toEqual({ data: new Uint8Array([8, 8]), mediaType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
