import { afterEach, describe, expect, it, vi } from 'vitest'
import { editDashScopeImage } from '../src/dashscope.js'

const signal = new AbortController().signal
const endpoint = 'https://dashscope.aliyuncs.com/api/v1'

afterEach(() => { vi.unstubAllGlobals() })

describe('editDashScopeImage', () => {
  it('uses Qwen multimodal generation with image then text content', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://result.example/edit.png' }] } }] } }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(editDashScopeImage({
      apiKey: 'dash-key', endpoint, model: 'qwen-image-3.0', prompt: 'add sunglasses',
      sourceImages: [
        { data: new Uint8Array(Buffer.from('source 1')), mediaType: 'image/png' },
        { data: new Uint8Array(Buffer.from('source 2')), mediaType: 'image/jpeg' },
      ],
      size: '1024*1024', maxBytes: 1024, signal,
    })).resolves.toEqual({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('qwen-image-3.0')
    expect(body.input.messages[0].content[0].image).toMatch(/^data:image\/png;base64,/)
    expect(body.input.messages[0].content[1].image).toMatch(/^data:image\/jpeg;base64,/)
    expect(body.input.messages[0].content[2]).toEqual({ text: 'add sunglasses' })
    expect(body.parameters).toMatchObject({ prompt_extend: true, size: '1024*1024' })
  })

  it('rejects non-Qwen DashScope models instead of pretending they support editing', async () => {
    await expect(editDashScopeImage({
      apiKey: 'dash-key', endpoint, model: 'wanx2.1-t2i-turbo', prompt: 'edit',
      sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }], maxBytes: 1024, signal,
    })).rejects.toThrow('Configure a qwen-image model.')
  })
})
