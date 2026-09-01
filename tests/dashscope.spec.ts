import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateDashScopeImage } from '../src/dashscope.js'

const signal = new AbortController().signal
const endpoint = 'https://dashscope.aliyuncs.com/api/v1'
const imagePngBytes = Buffer.from('fake-dashscope-png-bytes')

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

function imageResponse(bytes: Uint8Array, contentType = 'image/png'): Response {
  return new Response(bytes as never, {
    status: 200,
    headers: { 'content-type': contentType },
  })
}

describe('generateDashScopeImage', () => {
  it('uses the synchronous Qwen Image multimodal endpoint without async headers', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('/services/aigc/multimodal-generation/generation')) {
        return jsonResponse({
          output: {
            choices: [{ message: { content: [{ image: 'https://dashscope-result.oss.aliyuncs.com/qwen.png' }] } }],
          },
        })
      }
      if (urlStr === 'https://dashscope-result.oss.aliyuncs.com/qwen.png') {
        return imageResponse(imagePngBytes, 'image/png')
      }
      throw new Error(`Unexpected URL: ${urlStr}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const result = await generateDashScopeImage({
      apiKey: 'sk-dashscope-test',
      endpoint,
      model: 'qwen-image-3.0',
      prompt: 'cyberpunk city',
      size: '1024x1024',
      maxBytes: 1024 * 1024,
      signal,
    })

    expect(result.mediaType).toBe('image/png')
    expect(result.data).toEqual(new Uint8Array(imagePngBytes))

    const [submitUrl, submitInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(submitUrl).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(submitInit.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer sk-dashscope-test',
    })
    expect(submitInit.headers).not.toHaveProperty('X-DashScope-Async')
    expect(JSON.parse(submitInit.body as string)).toEqual({
      model: 'qwen-image-3.0',
      input: { messages: [{ role: 'user', content: [{ text: 'cyberpunk city' }] }] },
      parameters: { size: '1024*1024' },
    })
  })

  it('rejects non-Qwen DashScope image models before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateDashScopeImage({
      apiKey: 'sk-dashscope-test',
      endpoint,
      model: 'wanx2.1-t2i-turbo',
      prompt: 'test',
      maxBytes: 1024 * 1024,
      signal,
    })).rejects.toThrow('Unsupported DashScope image model wanx2.1-t2i-turbo. Configure a qwen-image model.')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws upstream error on submit failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Invalid API key', { status: 401 })))

    await expect(generateDashScopeImage({
      apiKey: 'invalid-key',
      endpoint,
      model: 'qwen-image-3.0',
      prompt: 'test',
      maxBytes: 1024 * 1024,
      signal,
    })).rejects.toThrow('DashScope image generation failed (401): Invalid API key')
  })

  it('throws when the synchronous response contains no image URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ output: { choices: [{ message: { content: [{ text: 'done' }] } }] } })))

    await expect(generateDashScopeImage({
      apiKey: 'sk-dashscope-test',
      endpoint,
      model: 'qwen-image-3.0',
      prompt: 'test',
      maxBytes: 1024 * 1024,
      signal,
    })).rejects.toThrow('DashScope image generation returned no image URL')
  })
})
