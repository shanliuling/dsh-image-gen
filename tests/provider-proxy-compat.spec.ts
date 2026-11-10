import { afterEach, describe, expect, it, vi } from 'vitest'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from '../src/openai-compatible.js'
import { editSeedreamImage } from '../src/seedream.js'
import { editDashScopeImage, generateDashScopeImage } from '../src/dashscope.js'

const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))
afterEach(() => vi.unstubAllGlobals())

describe('provider downloads use the host fetch configuration', () => {
  it.each(['198.18.1.151', '127.0.0.1'])('delegates DNS and proxy handling to the host for %s', async address => {
    dns.lookup.mockReset().mockResolvedValue([{ address, family: 4 }])
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])
    const imageUrl = 'https://cdn.example/generated.jpg'
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => options?.method === 'POST'
      ? Response.json({ data: [{ url: imageUrl }] })
      : new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetch)
    const common = { apiKey: 'test-key', baseURL: 'https://provider.example/v1', model: 'image-model', prompt: 'fixture', maxBytes: 1024, signal: AbortSignal.timeout(1000) }
    await expect(generateOpenAICompatibleImage({ ...common, provider: 'openai-compat' })).resolves.toMatchObject({ data: bytes, mediaType: 'image/jpeg' })
    await expect(editSeedreamImage({ ...common, sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }] })).resolves.toMatchObject({ data: bytes, mediaType: 'image/jpeg' })
    fetch.mockImplementation(async (_url: unknown, options?: RequestInit) => options?.method === 'POST'
      ? Response.json({ output: { choices: [{ message: { content: [{ image: imageUrl }] } }] } })
      : new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }))
    await expect(generateDashScopeImage({ ...common, endpoint: common.baseURL, model: 'qwen-image' })).resolves.toMatchObject({ data: bytes, mediaType: 'image/jpeg' })
    const downloads = fetch.mock.calls.filter(([url]) => url === imageUrl)
    expect(downloads).toHaveLength(3)
    for (const [, options] of downloads) {
      expect(options).not.toHaveProperty('dispatcher')
      expect(options).not.toHaveProperty('agent')
    }
    expect(dns.lookup).not.toHaveBeenCalled()
  })

  it.each([false, true])('rejects fake/private DNS only with strict opt-in (enabled=%s)', async enabled => {
    dns.lookup.mockReset().mockResolvedValue([{ address: '198.18.1.151', family: 4 }])
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])
    const imageUrl = 'https://cdn.example/generated.jpg'
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => options?.method === 'POST'
      ? Response.json({ data: [{ url: imageUrl }], output: { choices: [{ message: { content: [{ image: imageUrl }] } }] } })
      : new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetch)
    const common = { apiKey: 'test-key', baseURL: 'https://provider.example/v1', model: 'image-model', prompt: 'fixture', maxBytes: 1024, signal: AbortSignal.timeout(1000), strictImageDownloads: enabled }
    const sourceImages = [{ data: new Uint8Array([1]), mediaType: 'image/png' as const }]
    const calls = [
      () => generateOpenAICompatibleImage({ ...common, provider: 'openai-compat' }),
      () => editOpenAICompatibleImage({ ...common, sourceImages }),
      () => editSeedreamImage({ ...common, sourceImages }),
      () => generateDashScopeImage({ ...common, endpoint: common.baseURL, model: 'qwen-image' }),
      () => editDashScopeImage({ ...common, endpoint: common.baseURL, model: 'qwen-image', sourceImages }),
    ]
    for (const call of calls) {
      if (enabled) await expect(call()).rejects.toThrow(/not a public address/)
      else await expect(call()).resolves.toMatchObject({ data: bytes, mediaType: 'image/jpeg' })
    }
    expect(fetch.mock.calls.filter(([url]) => url === imageUrl)).toHaveLength(enabled ? 0 : 5)
    if (enabled) expect(dns.lookup).toHaveBeenCalled()
    else expect(dns.lookup).not.toHaveBeenCalled()
  })
})
