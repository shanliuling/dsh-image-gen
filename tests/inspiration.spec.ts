import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_INSPIRATION_CATALOG, findInspirationCase, parseInspirationSnapshot, publicInspirationCatalog } from '../src/inspiration.js'
import { createInspirationRoute } from '../src/inspiration-route.js'
import { resolveActiveCatalog } from '../src/client/inspiration-view.js'

describe('inspiration snapshot contract', () => {
  it('ships a valid, public catalog without image paths', () => {
    const catalog = publicInspirationCatalog(BUNDLED_INSPIRATION_CATALOG)
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.sources[0]?.cases.length).toBeGreaterThan(500)
    expect(catalog.sources[0]?.cases[0]).not.toHaveProperty('imagePath')
  })

  it('rejects unsafe image paths while retaining valid source data', () => {
    const catalog = parseInspirationSnapshot({
      repository: 'https://example.com/source',
      categories: ['Art'], styles: ['Poster'], scenes: ['Creative'],
      cases: [
        { id: 'safe', title: 'Safe', image: '/images/safe.png', prompt: 'A safe prompt', category: 'Art', styles: ['Poster'], scenes: ['Creative'] },
        { id: 'unsafe', title: 'Unsafe', image: 'https://internal.example/private.png', prompt: 'Bad path', category: 'Art' },
      ],
    }, 'a'.repeat(40))
    expect(catalog.sources[0]?.cases.map(item => item.id)).toEqual(['safe'])
    expect(findInspirationCase(catalog, 'awesome-gpt-image-2', 'safe')?.imagePath).toBe('/images/safe.png')
  })
})

describe('inspiration HTTP route', () => {
  let server: Server | undefined
  let tmpHome: string | undefined
  const savedUserProfile = process.env.USERPROFILE
  const savedHome = process.env.HOME

  afterEach(async () => {
    vi.restoreAllMocks()
    // 恢复环境变量，清理临时缓存目录
    process.env.USERPROFILE = savedUserProfile
    process.env.HOME = savedHome
    if (tmpHome !== undefined) {
      try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
      tmpHome = undefined
    }
    if (server === undefined) return
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  })

  async function start(fetchMock?: typeof fetch): Promise<string> {
    // 每个测试用独立临时目录，避免磁盘缓存干扰断言
    tmpHome = mkdtempSync(join(tmpdir(), 'dsh-ig-test-'))
    process.env.USERPROFILE = tmpHome
    process.env.HOME = tmpHome
    const route = createInspirationRoute(fetchMock === undefined ? {} : { fetch: fetchMock })
    server = createServer((req, res) => { void route(req, res) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return `http://127.0.0.1:${String(address.port)}`
  }

  it('serves catalog metadata and refuses unknown source IDs without proxying', async () => {
    const upstream = vi.fn<typeof fetch>()
    const url = await start(upstream)
    const catalog = await fetch(`${url}/catalog`, { headers: { origin: url } })
    expect(catalog.status).toBe(200)
    expect((await catalog.json() as { sources: unknown[] }).sources).toHaveLength(1)
    const blocked = await fetch(`${url}/image/not-an-allowed-source/1`, { headers: { origin: url } })
    expect(blocked.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('resolves a known case server-side and proxies only an allowed image response', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    }))
    const url = await start(upstream)
    const item = BUNDLED_INSPIRATION_CATALOG.sources[0]!.cases[0]!
    const response = await fetch(`${url}/image/awesome-gpt-image-2/${item.id}`, { headers: { origin: url } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(upstream).toHaveBeenCalledWith('https://cdn.jsdelivr.net/gh/freestylefly/awesome-gpt-image-2@c7d293963b21c60bf338003915438cc5c39dd3ca/data/images/case544.jpg', expect.objectContaining({ redirect: 'error' }))
  })

  it('falls back through all three sources when earlier mirrors are unavailable', async () => {
    const upstream = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const url = await start(upstream)
    const response = await fetch(`${url}/image/awesome-gpt-image-2/544`, { headers: { origin: url } })
    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(3)
    expect(upstream.mock.calls[2]?.[0]).toBe('https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/c7d293963b21c60bf338003915438cc5c39dd3ca/data/images/case544.jpg')
  })

  it('accepts a schema-valid manual refresh and publishes its immutable version', async () => {
    const version = 'b'.repeat(40)
    const upstream = vi.fn<typeof fetch>(async input => {
      const url = String(input)
      if (url.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: version, commit: { author: { date: '2026-09-03T00:00:00.000Z' } } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        repository: 'https://github.com/freestylefly/awesome-gpt-image-2', categories: ['Art'], styles: ['Poster'], scenes: ['Creative'],
        cases: [{ id: '900', title: 'Fresh case', image: '/images/case900.jpg', prompt: 'A newly refreshed prompt', category: 'Art', styles: ['Poster'], scenes: ['Creative'] }],
      }), { status: 200 })
    })
    const url = await start(upstream)
    const response = await fetch(`${url}/refresh`, { method: 'POST', headers: { origin: url } })
    expect(response.status).toBe(200)
    const catalog = await response.json() as { sources: Array<{ version: string; integritySha256?: string; updatedAt?: string; cases: unknown[] }> }
    expect(catalog.sources[0]).toMatchObject({ version, updatedAt: '2026-09-03T00:00:00.000Z', cases: [{ id: '900' }] })
    expect(catalog.sources[0]?.integritySha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('serves from async disk cache on repeated requests without hitting upstream', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([10, 20, 30]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
    }))
    const url = await start(upstream)
    const item = BUNDLED_INSPIRATION_CATALOG.sources[0]!.cases[0]!
    // 第一次请求：拉取并写入磁盘
    const first = await fetch(`${url}/image/awesome-gpt-image-2/${item.id}`, { headers: { origin: url } })
    expect(first.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
    // 等待写盘完成
    await new Promise(r => setTimeout(r, 80))
    // 第二次请求：命中磁盘缓存，不再调用 upstream
    const second = await fetch(`${url}/image/awesome-gpt-image-2/${item.id}`, { headers: { origin: url } })
    expect(second.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized images exceeding MAX_IMAGE_BYTES via streaming', async () => {
    // 构造超过 12MB 的响应流
    const hugeChunk = new Uint8Array(13 * 1024 * 1024)
    const upstream = vi.fn<typeof fetch>(async () => new Response(hugeChunk, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }))
    const url = await start(upstream)
    const item = BUNDLED_INSPIRATION_CATALOG.sources[0]!.cases[0]!
    const response = await fetch(`${url}/image/awesome-gpt-image-2/${item.id}`, { headers: { origin: url } })
    expect(response.status).toBe(502)
  })

  it('clears disk cache and removes image files on POST /cache/clear', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
    }))
    const url = await start(upstream)
    const item = BUNDLED_INSPIRATION_CATALOG.sources[0]!.cases[0]!
    await fetch(`${url}/image/awesome-gpt-image-2/${item.id}`, { headers: { origin: url } })
    await new Promise(r => setTimeout(r, 80))

    const cacheDir = join(tmpHome!, '.dsh', 'cache', 'dsh-image-gen', 'inspiration')
    const filesBefore = readdirSync(cacheDir).filter(name => /\.(jpg|png|webp)$/i.test(name))
    expect(filesBefore.length).toBeGreaterThan(0)

    const clearRes = await fetch(`${url}/cache/clear`, { method: 'POST', headers: { origin: url } })
    expect(clearRes.status).toBe(200)
    expect(await clearRes.json()).toEqual({ ok: true })

    const filesAfter = readdirSync(cacheDir).filter(name => /\.(jpg|png|webp)$/i.test(name))
    expect(filesAfter).toHaveLength(0)
  })
})

describe('resolveActiveCatalog cache arbitration', () => {
  const baseCatalog = publicInspirationCatalog(BUNDLED_INSPIRATION_CATALOG)

  it('prefers bundled when version is identical', () => {
    const cached = structuredClone(baseCatalog)
    const result = resolveActiveCatalog(baseCatalog, cached)
    expect(result).toBe(baseCatalog)
  })

  it('picks cached if cached has newer updatedAt timestamp', () => {
    const bundled = {
      ...baseCatalog,
      sources: [{ ...baseCatalog.sources[0]!, version: 'v1', updatedAt: '2026-08-01T00:00:00Z' }],
    }
    const cached = {
      ...baseCatalog,
      sources: [{ ...baseCatalog.sources[0]!, version: 'v2', updatedAt: '2026-09-01T00:00:00Z' }],
    }
    expect(resolveActiveCatalog(bundled, cached)).toBe(cached)
  })

  it('picks bundled if plugin upgrade brings newer updatedAt timestamp', () => {
    const oldCached = {
      ...baseCatalog,
      sources: [{ ...baseCatalog.sources[0]!, version: 'v1', updatedAt: '2026-08-01T00:00:00Z' }],
    }
    const newBundled = {
      ...baseCatalog,
      sources: [{ ...baseCatalog.sources[0]!, version: 'v2', updatedAt: '2026-09-02T00:00:00Z' }],
    }
    expect(resolveActiveCatalog(newBundled, oldCached)).toBe(newBundled)
  })

  it('falls back to the catalog with more cases if timestamps are absent or unparseable', () => {
    const bundled = {
      ...baseCatalog,
      sources: [{ ...baseCatalog.sources[0]!, version: 'v1', updatedAt: undefined, cases: baseCatalog.sources[0]!.cases.slice(0, 10) }],
    }
    const cached = {
      ...baseCatalog,
      sources: [{ ...baseCatalog.sources[0]!, version: 'v2', updatedAt: undefined, cases: baseCatalog.sources[0]!.cases.slice(0, 20) }],
    }
    expect(resolveActiveCatalog(bundled, cached)).toBe(cached)
  })

  it('gracefully handles missing bundled or cached catalog', () => {
    expect(resolveActiveCatalog(undefined, baseCatalog)).toBe(baseCatalog)
    expect(resolveActiveCatalog(baseCatalog, undefined)).toBe(baseCatalog)
    expect(resolveActiveCatalog(undefined, undefined)).toBeUndefined()
  })
})
