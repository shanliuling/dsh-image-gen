import { afterEach, describe, expect, it, vi } from 'vitest'
import { editOpenAICompatibleImage } from '../src/openai-compatible.js'
import { resolveProvider, withProviderOverrides } from '../src/config.js'
import { compatEditFormat } from '../src/watermark.js'
import { studioProfile, generateFromStudio } from '../src/studio.js'
import { studioModelForMode } from '../src/shared.js'

const source = { data: new Uint8Array([137,80,78,71]), mediaType: 'image/png' as const }
function input(model = 'Qwen/Qwen-Image-Edit', count = 1) {
  return { apiKey: 'offline', baseURL: 'https://api.siliconflow.cn/v1', model, prompt: 'blue boat', sourceImages: Array.from({ length: count }, () => source), editFormat: 'siliconflowJson' as never, size: '1024x1024', quality: 'high', maxBytes: 1024, signal: new AbortController().signal }
}
afterEach(() => vi.unstubAllGlobals())
describe('SiliconFlow edits', () => {
  it.each(['api.siliconflow.cn', 'api.siliconflow.com'])('recognizes the exact official %s endpoint', host => {
    expect(compatEditFormat({ openaiCompatBaseURL: `https://${host}/v1`, openaiCompatModel: 'Qwen/Qwen-Image' })).toBe('siliconflowJson')
  })
  it.each(['https://api.siliconflow.cn.evil.test/v1', 'https://evil.test/api.siliconflow.cn/v1', 'https://api.siliconflow.cn/v2', 'http://api.siliconflow.cn/v1', 'https://api.siliconflow.cn/v1?proxy=1', 'https://api.siliconflow.cn:444/v1'])('does not guess the protocol from %s', baseURL => {
    expect(compatEditFormat({ openaiCompatBaseURL: baseURL, openaiCompatModel: 'Qwen/Qwen-Image-Edit' })).toBe('multipart')
  })
  it('posts one data URL string to generations and does not leak generic size or quality', async () => {
    const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => String(url).startsWith('https://cdn.example/') ? new Response(source.data, { headers: { 'content-type': 'image/png' } }) : Response.json({ images: [{ url: 'https://cdn.example/edited.png' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await editOpenAICompatibleImage({ ...input(), editExtra: { num_inference_steps: 20 } })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.siliconflow.cn/v1/images/generations')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ model: 'Qwen/Qwen-Image-Edit', prompt: 'blue boat', image: 'data:image/png;base64,iVBORw==', num_inference_steps: 20 })
  })
  it('maps the 2509 model to three separate string fields in reference order', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await editOpenAICompatibleImage({ ...input('Qwen/Qwen-Image-Edit-2509', 3), sourceImages: [1, 2, 3].map(value => ({ ...source, data: new Uint8Array([...source.data, value]) })) })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect([body.image, body.image2, body.image3]).toEqual(['data:image/png;base64,iVBORwE=', 'data:image/png;base64,iVBORwI=', 'data:image/png;base64,iVBORwM='])
    expect(body.images).toBeUndefined()
  })
  it.each([['Qwen/Qwen-Image-Edit', 2], ['Qwen/Qwen-Image-Edit-2509', 4], ['other-model', 2]] as const)('rejects %s with %s references before any request', async (model, count) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(editOpenAICompatibleImage(input(model, count))).rejects.toThrow('参考图')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('selects the separate edit model without changing generation defaults and respects a call override', () => {
    const config = { provider: 'openai-compat' as const, openaiCompatBaseURL: 'https://api.siliconflow.cn/v1', openaiCompatModel: 'Qwen/Qwen-Image', openaiCompatEditModel: 'Qwen/Qwen-Image-Edit' }
    expect(resolveProvider(config).model).toBe('Qwen/Qwen-Image')
    expect(resolveProvider(withProviderOverrides(config, undefined, undefined, 'edit')).model).toBe('Qwen/Qwen-Image-Edit')
    expect(resolveProvider(withProviderOverrides(config, undefined, 'Qwen/Qwen-Image-Edit-2509', 'edit')).model).toBe('Qwen/Qwen-Image-Edit-2509')
    expect(config.openaiCompatModel).toBe('Qwen/Qwen-Image')
    const profile = studioProfile(config, 'openai-compat', true)
    expect(studioModelForMode(profile, 'generate')).toBe('Qwen/Qwen-Image')
    expect(studioModelForMode(profile, 'edit')).toBe('Qwen/Qwen-Image-Edit')
    expect(studioModelForMode({ ...profile, editModel: undefined }, 'edit')).toBe('Qwen/Qwen-Image')
  })
  it.each([0, 2])('rejects %s references and wrong generation model before spending a request', async count => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(editOpenAICompatibleImage(input('Qwen/Qwen-Image-Edit', count))).rejects.toThrow('参考图')
    await expect(editOpenAICompatibleImage(input('Qwen/Qwen-Image'))).rejects.toThrow('图生图模型')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects unsupported dimensions in edit extras instead of sending an invalid request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(editOpenAICompatibleImage({ ...input(), editExtra: { image_size: '1024x1024' } })).rejects.toThrow('额外字段')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('runs Studio editing with its separate model through the SiliconFlow adapter', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = { credentials: { resolve: async () => ({ value: 'offline' }) }, attachments: { imageLimits: { maxImageBytes: 1024, mediaTypes: ['image/png'] }, validateImage: async () => {}, saveImage: async () => ({ attachmentId: 'sha256:out', mediaType: 'image/png', bytes: 8, width: 1, height: 1 }) } } as never
    const config = { provider: 'openai-compat' as const, openaiCompatBaseURL: 'https://api.siliconflow.cn/v1', openaiCompatModel: 'Qwen/Qwen-Image', openaiCompatEditModel: 'Qwen/Qwen-Image-Edit', saveToWorkspace: false }
    const profile = studioProfile(config, 'openai-compat', true)
    const output = await generateFromStudio(ctx, config, { mode: 'edit', provider: 'openai-compat', model: studioModelForMode(profile, 'edit'), prompt: 'blue boat', ratio: profile.defaultRatio, quality: profile.defaultQuality, generationQuality: 'auto', references: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }] }, new AbortController().signal)
    expect(output.model).toBe('Qwen/Qwen-Image-Edit')
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.siliconflow.cn/v1/images/generations')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).model).toBe('Qwen/Qwen-Image-Edit')
  })
})
