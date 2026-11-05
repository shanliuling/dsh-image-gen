import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateOpenAICompatibleImage } from '../src/openai-compatible.js'
import { editSeedreamImage } from '../src/seedream.js'
import { generateDashScopeImage } from '../src/dashscope.js'

const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))
const servers: Server[] = []
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port
}
beforeEach(() => dns.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]))
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

describe('image download network boundary', () => {
  it.each(['absolute', 'protocol-relative', 'redirect', 'seedream', 'seedream-redirect', 'dashscope', 'dashscope-redirect'])('blocks provider-supplied %s URLs to another local service', async mode => {
    let targetRequests = 0
    const target = await listen((_req, res) => { targetRequests += 1; res.setHeader('content-type', 'image/png'); res.end(Buffer.from([1, 2, 3])) })
    let provider = ''
    provider = await listen(async (req, res) => {
      for await (const _chunk of req) { /* drain the edit request */ }
      if (req.method === 'POST') {
        const url = mode.includes('redirect') ? provider + '/redirect' : mode === 'protocol-relative' ? target.replace('http:', '') + '/private' : target + '/private'
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(mode.startsWith('dashscope') ? { output: { choices: [{ message: { content: [{ image: url }] } }] } } : { data: [{ url }] }))
      } else { res.writeHead(302, { location: target + '/private' }); res.end() }
    })
    const common = { apiKey: 'test-secret', baseURL: provider + '/v1', model: 'test-model', prompt: 'test', maxBytes: 1024, signal: AbortSignal.timeout(5000) }
    const result = mode.startsWith('dashscope') ? generateDashScopeImage({ ...common, endpoint: provider, model: 'qwen-image' }) : mode.startsWith('seedream')
      ? editSeedreamImage({ ...common, sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }] })
      : generateOpenAICompatibleImage({ ...common, provider: 'openai-compat' })
    await expect(result).rejects.toThrow(/private|blocked/i)
    expect(targetRequests).toBe(0)
  })

  it.each(['http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://10.0.0.1/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'http://[fc00::1]/a', 'http://[64:ff9b::7f00:1]/a', 'file:///etc/passwd', 'ftp://public.example/a', 'http://user:pass@public.example/a'])('rejects untrusted target %s before fetching', async url => {
    const { fetchProviderImage } = await import('../src/image-download.js')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(fetchProviderImage(url, { baseURL: 'https://provider.example/v1', signal: AbortSignal.timeout(1000) })).rejects.toThrow(/blocked/i)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a hostname with even one private DNS answer', async () => {
    const { fetchProviderImage } = await import('../src/image-download.js')
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(fetchProviderImage('https://cdn.example/image', { baseURL: 'https://provider.example/v1', signal: AbortSignal.timeout(1000) })).rejects.toThrow(/private/i)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('pins the checked DNS result for a configured localhost provider', async () => {
    const { fetchProviderImage } = await import('../src/image-download.js')
    const origin = await listen((_req, res) => { res.setHeader('content-type', 'image/png'); res.end('local image') })
    dns.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]).mockResolvedValue([{ address: '127.0.0.2', family: 4 }])
    const local = origin.replace('127.0.0.1', 'localhost')
    const response = await fetchProviderImage(local + '/image', { baseURL: local + '/v1', signal: AbortSignal.timeout(5000) })
    expect(await response.text()).toBe('local image')
    expect(dns.lookup).toHaveBeenCalledTimes(1)
  })

  it('rechecks redirected targets and removes authorization on a public cross-origin hop', async () => {
    const { fetchProviderImage } = await import('../src/image-download.js')
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example/image' } })).mockResolvedValueOnce(new Response('image'))
    vi.stubGlobal('fetch', fetch)
    const response = await fetchProviderImage('https://provider.example/image', { baseURL: 'https://provider.example/v1', apiKey: 'secret', signal: AbortSignal.timeout(1000) })
    await response.text()
    expect(fetch.mock.calls[0]?.[1].headers).toEqual({ authorization: 'Bearer secret' })
    expect(fetch.mock.calls[1]?.[1].headers).toBeUndefined()
    expect(dns.lookup).toHaveBeenCalledTimes(2)
  })
})
