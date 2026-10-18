import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:http'

import {
  fetchDashScopeImageModels,
  fetchGoogleImageModels,
  fetchOpenAIImageModels,
  filterImageModelIds,
  filterOpenAIImageModelIds,
  filterRelayImageModelIds,
  filterSeedreamImageModelIds,
  filterZhipuImageModelIds,
  parseDashScopeImageModelIds,
  parseGoogleModelIds,
  parseOpenAIModelIds,
  probeProviderConnection,
  probeTarget,
  serveTestConnection,
  type ProbeResult,
  type TestRouteDeps,
} from '../src/test-route.js'

describe('probe targets', () => {
  it('probes the sibling models list for Google with its header scheme', () => {
    const target = probeTarget('google', { googleEndpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions' }, 'gem-key')
    expect(target.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(target.headers).toEqual({ 'x-goog-api-key': 'gem-key' })
  })

  it('falls back to the official Google models URL without a configured endpoint', () => {
    const target = probeTarget('google', {}, undefined)
    expect(target.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
  })

  it.each(['https://relay.example/proxy/v1beta', 'https://relay.example/proxy/v1beta/models/gemini:generateContent'])('pulls models from a native Google base at %s', googleEndpoint => {
    expect(probeTarget('google', { googleEndpoint, googleNative: true }, 'gem-key').url).toBe('https://relay.example/proxy/v1beta/models')
  })

  it('joins OpenAI relays and official endpoints on /models with Bearer auth', () => {
    expect(probeTarget('openai', {}, 'sk-openai')).toEqual({
      url: 'https://api.openai.com/v1/models',
      headers: { authorization: 'Bearer sk-openai' },
    })
    expect(probeTarget('openai', { openaiBaseURL: 'https://relay.example.com/v1/' }, 'sk-relay')).toEqual({
      url: 'https://relay.example.com/v1/models',
      headers: { authorization: 'Bearer sk-relay' },
    })
  })

  it('probes the dedicated compat row against its relay address only', () => {
    expect(probeTarget('openai-compat', { openaiCompatBaseURL: 'https://relay.example.com/v1' }, 'sk-relay')).toEqual({
      url: 'https://relay.example.com/v1/models',
      headers: { authorization: 'Bearer sk-relay' },
    })
    // Never falls back to api.openai.com: a relay key would look "invalid" there.
    expect(() => probeTarget('openai-compat', {}, 'sk-relay')).toThrow('not configured')
  })

  it('probes the Ark models endpoint for Seedream and the DashScope models endpoint', () => {
    expect(probeTarget('seedream', {}, 'ark-key').url).toBe('https://ark.cn-beijing.volces.com/api/v3/models')
    expect(probeTarget('dashscope', {}, 'dash-key').url).toBe('https://dashscope.aliyuncs.com/api/v1/models')
    expect(probeTarget('dashscope', { dashscopeEndpoint: 'https://dashscope.example.com/api/v1' }, 'dash-key').url)
      .toBe('https://dashscope.example.com/api/v1/models')
  })

  it('probes the xAI and Zhipu models endpoints with Bearer auth', () => {
    expect(probeTarget('xai', {}, 'xai-key')).toEqual({
      url: 'https://api.x.ai/v1/models',
      headers: { authorization: 'Bearer xai-key' },
    })
    expect(probeTarget('zhipu', {}, 'zhipu-key')).toEqual({
      url: 'https://open.bigmodel.cn/api/paas/v4/models',
      headers: { authorization: 'Bearer zhipu-key' },
    })
    expect(probeTarget('xai', { xaiBaseURL: 'https://proxy.example.com/v1' }, 'xai-key').url)
      .toBe('https://proxy.example.com/v1/models')
  })

  it('probes the ComfyUI health endpoint without credentials', () => {
    expect(probeTarget('comfyui', {})).toEqual({ url: 'http://127.0.0.1:8188/system_stats', headers: {} })
    expect(probeTarget('comfyui', { comfyuiBaseURL: 'http://192.168.1.5:8188/' })).toEqual({
      url: 'http://192.168.1.5:8188/system_stats',
      headers: {},
    })
  })
})

describe('probe classification', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('reports missing keys before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeProviderConnection('openai', {}, undefined)).resolves.toEqual({ ok: false, reason: 'missing-key' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails the compat probe with a clear error when the relay address is empty', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeProviderConnection('openai-compat', {}, 'sk-relay')).resolves.toMatchObject({
      ok: false,
      reason: 'error',
      message: 'Base URL is not configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats any 2xx as connected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })))
    await expect(probeProviderConnection('openai', {}, 'sk-key')).resolves.toEqual({ ok: true })
  })

  it('maps 401 and 403 to the unauthorized reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })))
    await expect(probeProviderConnection('google', {}, 'bad-key')).resolves.toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('redacts the API key from error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid token "sk-abcdef1234567890"', { status: 500 })))
    const result = await probeProviderConnection('openai', {}, 'sk-abcdef1234567890') as { ok: false; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('HTTP 500')
    expect(result.message).not.toContain('sk-abcdef1234567890')
  })
})

describe('test connection route', () => {
  let server: Server
  let serverUrl: string
  let probeCalls: Array<{ provider: string; key: string | undefined }>

  const deps = (options: { key?: string }): TestRouteDeps => ({
    resolveKey: async provider => {
      probeCalls.push({ provider, key: options.key })
      return options.key
    },
    config: () => ({}),
  })

  /** Stub provider probes while the test's own requests to the local server keep working. */
  function stubProbeFetch(handler: () => Promise<Response>): ReturnType<typeof vi.fn> {
    const realFetch = globalThis.fetch
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === serverUrl) return realFetch(input as RequestInfo, init)
      return handler()
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  beforeEach(() => {
    probeCalls = []
  })

  async function startServer(options: { key?: string }): Promise<void> {
    server = createServer((req, res) => {
      void serveTestConnection(req, res, deps(options)).catch(() => { res.statusCode = 500; res.end() })
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  }

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllGlobals()
  })

  it('probes the requested provider with its stored key', async () => {
    const fetchMock = stubProbeFetch(async () => new Response('ok', { status: 200 }))
    await startServer({ key: 'sk-live' })
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    })
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(probeCalls).toEqual([{ provider: 'openai', key: 'sk-live' }])
    const probedUrl = fetchMock.mock.calls.map(([input]) => String(input)).find(url => url !== serverUrl)
    expect(probedUrl).toBe('https://api.openai.com/v1/models')
  })

  it('reports a missing key without probing the network', async () => {
    const fetchMock = stubProbeFetch(async () => new Response('ok', { status: 200 }))
    await startServer({ key: undefined })
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'seedream' }),
    })
    await expect(response.json()).resolves.toEqual({ ok: false, reason: 'missing-key' })
    expect(fetchMock.mock.calls.filter(([input]) => String(input) !== serverUrl)).toHaveLength(0)
  })

  it('probes ComfyUI without resolving any credential', async () => {
    const fetchMock = stubProbeFetch(async () => new Response('{"system":{}}', { status: 200 }))
    await startServer({})
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'comfyui' }),
    })
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(probeCalls).toEqual([])
    const probedUrl = fetchMock.mock.calls.map(([input]) => String(input)).find(url => url !== serverUrl)
    expect(probedUrl).toBe('http://127.0.0.1:8188/system_stats')
  })

  it('surfaces probe failures as a structured error, never a 5xx', async () => {
    stubProbeFetch(async () => { throw new Error('fetch failed: ECONNREFUSED') })
    await startServer({ key: 'sk-live' })
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'dashscope' }),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as ProbeResult
    expect(payload).toMatchObject({ ok: false, reason: 'error' })
    if (!payload.ok && payload.message !== undefined) expect(payload.message).toContain('ECONNREFUSED')
  })

  it('rejects unknown providers, wrong methods, and cross-origin calls', async () => {
    stubProbeFetch(async () => new Response('ok', { status: 200 }))
    await startServer({ key: 'sk-live' })
    const invalidProvider = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'midjourney' }),
    })
    expect(invalidProvider.status).toBe(400)

    const wrongMethod = await fetch(serverUrl, { method: 'GET' })
    expect(wrongMethod.status).toBe(405)

    const crossOrigin = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
      body: JSON.stringify({ provider: 'openai' }),
    })
    expect(crossOrigin.status).toBe(403)
  })
})

describe('google model pull', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('extracts bare ids and filters image-capable models from a list response', () => {
    const ids = parseGoogleModelIds({
      models: [
        { name: 'models/gemini-3.1-flash-image' },
        { name: 'models/imagen-4.0-generate-001' },
        { name: 'models/gemini-2.5-pro' },
        { name: 'models/gemini-2.5-flash' },
        { name: 'models/text-embedding-004' },
        { name: '' },
      ],
    })
    expect(ids).toEqual([
      'gemini-3.1-flash-image',
      'imagen-4.0-generate-001',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'text-embedding-004',
    ])
    expect(filterImageModelIds(ids)).toEqual(['gemini-3.1-flash-image', 'imagen-4.0-generate-001'])
  })

  it('tolerates malformed payloads and non-model responses', () => {
    expect(parseGoogleModelIds(null)).toEqual([])
    expect(parseGoogleModelIds({})).toEqual([])
    expect(parseGoogleModelIds({ models: 'nope' })).toEqual([])
    expect(parseGoogleModelIds({ models: [{ name: 42 }, null, { name: 'models/gemini-3.1-flash-image' }] }))
      .toEqual(['gemini-3.1-flash-image'])
    expect(filterImageModelIds([])).toEqual([])
  })

  it('requests a full page with the stored key and returns the filtered ids', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('pageSize')).toBe('1000')
      return new Response(JSON.stringify({
        models: [
          { name: 'models/gemini-3.1-flash-image' },
          { name: 'models/imagen-4.0-generate-001' },
          { name: 'models/gemini-2.5-flash' },
        ],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchGoogleImageModels({}, 'gem-key')
    expect(result).toEqual({ ok: true, models: ['gemini-3.1-flash-image', 'imagen-4.0-generate-001'] })
    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('generativelanguage.googleapis.com/v1beta/models')
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('gem-key')
  })

  it('classifies missing keys and auth failures like the probe does', async () => {
    await expect(fetchGoogleImageModels({}, undefined)).resolves.toEqual({ ok: false, reason: 'missing-key' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })))
    await expect(fetchGoogleImageModels({}, 'bad-key')).resolves.toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('returns an empty success when nothing image-capable is listed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"models":[{"name":"models/gemini-2.5-pro"}]}', { status: 200 })))
    await expect(fetchGoogleImageModels({}, 'gem-key')).resolves.toEqual({ ok: true, models: [] })
  })

  it('rejects model pulls for ComfyUI, which has no model catalog', async () => {
    const server = createServer((req, res) => {
      void serveTestConnection(req, res, {
        resolveKey: async () => 'sk-live',
        config: () => ({}),
      }).catch(() => { res.statusCode = 500; res.end() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'comfyui', action: 'models' }),
      })
      expect(response.status).toBe(400)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('serves the Seedream model list through the route', async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input)
      if (target.includes('ark.cn-beijing.volces.com')) {
        return new Response(JSON.stringify({
          data: [{ id: 'doubao-seedream-4-5-251128' }, { id: 'doubao-seededit-3-0-i2i-250628' }, { id: 'doubao-seed-2-1-pro-260628' }],
        }), { status: 200 })
      }
      return realFetch(input as RequestInfo, init)
    }))
    const server = createServer((req, res) => {
      void serveTestConnection(req, res, {
        resolveKey: async () => 'ark-key',
        config: () => ({}),
      }).catch(() => { res.statusCode = 500; res.end() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'seedream', action: 'models' }),
      })
      await expect(response.json()).resolves.toEqual({
        ok: true,
        models: ['doubao-seedream-4-5-251128', 'doubao-seededit-3-0-i2i-250628'],
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('serves the filtered model list through the route', async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input)
      if (target.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          models: [{ name: 'models/gemini-3.1-flash-image' }, { name: 'models/gemini-2.5-pro' }],
        }), { status: 200 })
      }
      return realFetch(input as RequestInfo, init)
    }))
    const server = createServer((req, res) => {
      void serveTestConnection(req, res, {
        resolveKey: async () => 'gem-key',
        config: () => ({}),
      }).catch(() => { res.statusCode = 500; res.end() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', action: 'models' }),
      })
      await expect(response.json()).resolves.toEqual({ ok: true, models: ['gemini-3.1-flash-image'] })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('openai model pull', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('extracts ids from an OpenAI-style payload and drops malformed entries', () => {
    const ids = parseOpenAIModelIds({
      data: [
        { id: 'gpt-image-2' },
        { id: 'dall-e-3' },
        { id: 'gpt-4o' },
        { id: '' },
        { id: 42 },
        null,
        {},
      ],
    })
    expect(ids).toEqual(['gpt-image-2', 'dall-e-3', 'gpt-4o'])
    expect(parseOpenAIModelIds(null)).toEqual([])
    expect(parseOpenAIModelIds({})).toEqual([])
    expect(parseOpenAIModelIds({ data: 'nope' })).toEqual([])
  })

  it('narrows the official catalog down to gpt-image and DALL·E families', () => {
    expect(filterOpenAIImageModelIds(['gpt-image-2', 'dall-e-3', 'gpt-4o', 'text-embedding-3-small'])).toEqual(['gpt-image-2', 'dall-e-3'])
  })

  it('keeps common relay image models with the broad filter', () => {
    const ids = ['gpt-image-2', 'dall-e-3', 'gpt-4o', 'flux-pro-1.1', 'seedream-4.0', 'sd3.5', 'sdxl', 'cogview-4', 'qwen-image', 'wan2.2-t2i', 'deepseek-chat']
    expect(filterRelayImageModelIds(ids)).toEqual(['gpt-image-2', 'dall-e-3', 'flux-pro-1.1', 'seedream-4.0', 'sd3.5', 'sdxl', 'cogview-4', 'qwen-image', 'wan2.2-t2i'])
  })

  it('pulls official models with the stored key and applies the narrow filter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-image-2' }, { id: 'gpt-4o' }, { id: 'dall-e-3' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchOpenAIImageModels('openai', {}, 'sk-official')
    expect(result).toEqual({ ok: true, models: ['gpt-image-2', 'dall-e-3'] })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/models')
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-official')
  })

  it('pulls relay models from the compat row with the broad filter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'flux-pro-1.1' }, { id: 'deepseek-chat' }, { id: 'qwen-image' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchOpenAIImageModels('openai-compat', { openaiCompatBaseURL: 'https://relay.example.com/v1/' }, 'sk-relay')
    expect(result).toEqual({ ok: true, models: ['flux-pro-1.1', 'qwen-image'] })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://relay.example.com/v1/models')
  })

  it('classifies missing keys, unconfigured relay addresses, and auth failures', async () => {
    await expect(fetchOpenAIImageModels('openai-compat', { openaiCompatBaseURL: 'https://relay.example.com/v1' }, undefined))
      .resolves.toEqual({ ok: false, reason: 'missing-key' })
    await expect(fetchOpenAIImageModels('openai-compat', {}, 'sk-relay'))
      .resolves.toEqual({ ok: false, reason: 'error', message: 'Base URL is not configured' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })))
    await expect(fetchOpenAIImageModels('openai', {}, 'bad-key')).resolves.toEqual({ ok: false, reason: 'unauthorized' })
  })
})

describe('seedream, xai, and zhipu model pulls', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('narrows the Ark catalog down to Seedream and SeedEdit families', () => {
    expect(filterSeedreamImageModelIds([
      'doubao-seedream-4-5-251128',
      'doubao-seededit-3-0-i2i-250628',
      'doubao-seed-2-1-pro-260628',
      'doubao-embedding-vision-250615',
    ])).toEqual(['doubao-seedream-4-5-251128', 'doubao-seededit-3-0-i2i-250628'])
  })

  it('narrows the Zhipu catalog down to GLM-Image and CogView families', () => {
    expect(filterZhipuImageModelIds([
      'glm-image',
      'cogview-4',
      'glm-4.6',
      'embedding-3',
    ])).toEqual(['glm-image', 'cogview-4'])
  })

  it('accepts the xAI-style {models:[{id}]} payload shape', () => {
    expect(parseOpenAIModelIds({
      models: [{ id: 'grok-imagine-image' }, { id: 'grok-imagine-image-2.0' }, { id: '' }],
    })).toEqual(['grok-imagine-image', 'grok-imagine-image-2.0'])
  })

  it('pulls the Ark model list and applies the Seedream filter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'doubao-seedream-4-5-251128' }, { id: 'doubao-seed-2-1-pro-260628' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchOpenAIImageModels('seedream', {}, 'ark-key')
    expect(result).toEqual({ ok: true, models: ['doubao-seedream-4-5-251128'] })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://ark.cn-beijing.volces.com/api/v3/models')
  })

  it('pulls the dedicated xAI image-generation model list without filtering', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [{ id: 'grok-imagine-image' }, { id: 'grok-imagine-image-2.0' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchOpenAIImageModels('xai', {}, 'xai-key')
    expect(result).toEqual({ ok: true, models: ['grok-imagine-image', 'grok-imagine-image-2.0'] })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.x.ai/v1/image-generation-models')
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer xai-key')
  })

  it('pulls the Zhipu model list with the GLM-Image filter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'glm-image' }, { id: 'glm-4.6' }, { id: 'cogview-4' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchOpenAIImageModels('zhipu', {}, 'zhipu-key')
    expect(result).toEqual({ ok: true, models: ['glm-image', 'cogview-4'] })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://open.bigmodel.cn/api/paas/v4/models')
  })
})

describe('dashscope model pull', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('extracts IG-capable models and falls back to name matching without the field', () => {
    expect(parseDashScopeImageModelIds({
      output: {
        models: [
          { model: 'qwen-image-3.0', capabilities: ['IG'] },
          { model: 'wan2.2-t2i', capabilities: ['IG'] },
          { model: 'qwen-plus', capabilities: ['TG'] },
          { model: 'wanx2.1-t2i' },
          { model: '' },
          { model: 42 },
        ],
      },
    })).toEqual(['qwen-image-3.0', 'wan2.2-t2i', 'wanx2.1-t2i'])
    expect(parseDashScopeImageModelIds(null)).toEqual([])
    expect(parseDashScopeImageModelIds({ output: {} })).toEqual([])
    expect(parseDashScopeImageModelIds({ data: [{ id: 'x' }] })).toEqual([])
  })

  it('requests the IG capability filter and parses the native payload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('capabilities')).toBe('IG')
      expect(url.searchParams.get('page_size')).toBe('100')
      return new Response(JSON.stringify({
        output: {
          models: [
            { model: 'qwen-image-3.0', capabilities: ['IG'] },
            { model: 'qwen3-max', capabilities: ['TG'] },
          ],
        },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchDashScopeImageModels({}, 'dash-key')
    expect(result).toEqual({ ok: true, models: ['qwen-image-3.0'] })
    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('https://dashscope.aliyuncs.com/api/v1/models')
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer dash-key')
  })

  it('honours a configured endpoint and classifies missing keys and auth failures', async () => {
    const fetchMock = vi.fn(async () => new Response('{"output":{"models":[]}}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchDashScopeImageModels({ dashscopeEndpoint: 'https://dashscope.example.com/api/v1' }, 'dash-key')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://dashscope.example.com/api/v1/models?capabilities=IG&page_no=1&page_size=100')

    await expect(fetchDashScopeImageModels({}, undefined)).resolves.toEqual({ ok: false, reason: 'missing-key' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })))
    await expect(fetchDashScopeImageModels({}, 'bad-key')).resolves.toEqual({ ok: false, reason: 'unauthorized' })
  })
})
