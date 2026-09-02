import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEFAULT_GOOGLE_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_SEEDREAM_MODEL, DEFAULT_DASHSCOPE_MODEL } from '../src/config.js'
import { studioProfile } from '../src/studio.js'
import { parseStudioGenerateRequest, serveStudio } from '../src/studio-route.js'
import {
  fetchAttachmentBlob,
  clearAttachmentCache,
  evictAttachmentCache,
  getCacheMetrics,
  MAX_CACHE_COUNT,
} from '../src/client/image-cache.js'
import { formatRelativeTime, downloadBlobUrl } from '../src/client/browser-image-utils.js'
import { conversationRegenerateRequest } from '../src/client/conversation-regenerate.js'
import {
  appendConversationImageRevision,
  loadConversationImageRevisionChain,
  selectConversationImageRevision,
} from '../src/client/conversation-image-revisions.js'

describe('image workbench provider capabilities', () => {
  it('exposes only parameters implemented by each cloud adapter', () => {
    const google = studioProfile({}, 'google', true)
    expect(google).toMatchObject({ model: DEFAULT_GOOGLE_MODEL, defaultRatio: '1:1', defaultQuality: '1K', configured: true })
    expect(google.ratioOptions.map(option => option.value)).toContain('16:9')
    expect(google.qualityOptions.map(option => option.value)).toEqual(['1K', '2K', '4K'])

    const openai = studioProfile({}, 'openai', false)
    expect(openai).toMatchObject({ model: DEFAULT_OPENAI_MODEL, configured: false })
    expect(openai.ratioOptions.map(option => option.value)).toEqual(['1:1', '3:2', '2:3'])
    expect(openai.qualityOptions).toEqual([{ value: 'standard', label: '标准（推荐）' }])

    const seedream = studioProfile({}, 'seedream', true)
    expect(seedream).toMatchObject({ model: DEFAULT_SEEDREAM_MODEL, defaultRatio: 'auto', defaultQuality: '2K', configured: true })
    expect(seedream.qualityOptions.map(o => o.value)).toEqual(['1K', '2K', '4K'])

    const dashscope = studioProfile({}, 'dashscope', true)
    expect(dashscope).toMatchObject({ model: DEFAULT_DASHSCOPE_MODEL, defaultRatio: '1:1', defaultQuality: 'standard', configured: true })
    expect(dashscope.ratioOptions.map(o => o.value)).toEqual(['1:1', '3:2', '2:3', '16:9', '9:16'])
  })

  it('does not expose ComfyUI through the first workbench release', () => {
    expect(() => studioProfile({}, 'comfyui' as never, true)).toThrow()
  })
})

describe('image workbench request validation', () => {
  const base = {
    mode: 'generate' as const,
    provider: 'google' as const,
    model: DEFAULT_GOOGLE_MODEL,
    prompt: '  a warm editorial portrait  ',
    ratio: '2:3',
    quality: '2K',
  }

  it('normalizes a cloud generation request', () => {
    expect(parseStudioGenerateRequest(base)).toEqual({ ...base, prompt: 'a warm editorial portrait' })
  })

  it('requires a valid reference for image editing', () => {
    expect(() => parseStudioGenerateRequest({ ...base, mode: 'edit' })).toThrow('参考图')
    expect(parseStudioGenerateRequest({
      ...base,
      mode: 'edit',
      reference: {
        attachment: {
          attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 8, width: 32, height: 32,
        },
      },
    })).toMatchObject({ mode: 'edit', reference: { attachment: { attachmentId: 'sha256:image' } } })
  })

  it('supports multiple references for image editing and enforces 5 images max', () => {
    const ref = {
      attachment: {
        attachmentId: 'sha256:image', mediaType: 'image/png' as const, bytes: 8, width: 32, height: 32,
      },
    }
    const result = parseStudioGenerateRequest({
      ...base,
      mode: 'edit',
      references: [ref, ref],
    })
    expect(result.references).toHaveLength(2)
    expect(() => parseStudioGenerateRequest({
      ...base,
      mode: 'edit',
      references: [ref, ref, ref, ref, ref, ref],
    })).toThrow('5')
  })

  it('rejects ComfyUI and oversized prompts at the browser boundary', () => {
    expect(() => parseStudioGenerateRequest({ ...base, provider: 'comfyui' as never })).toThrow('Provider')
    expect(() => parseStudioGenerateRequest({ ...base, prompt: 'x'.repeat(2_001) })).toThrow('2000')
  })

  it('preserves valid workspaceRoot when provided', () => {
    const result = parseStudioGenerateRequest({
      ...base,
      workspaceRoot: 'D:\\z\\standalone',
    })
    expect(result.workspaceRoot).toBe('D:\\z\\standalone')
  })
})

describe('conversation and gallery image regeneration', () => {
  it('reuses provider output settings while allowing the prompt to change', () => {
    expect(conversationRegenerateRequest({
      provider: 'google', model: DEFAULT_GOOGLE_MODEL, output: '2:3, 2K',
    }, '  softer evening light  ')).toEqual({
      mode: 'generate', provider: 'google', model: DEFAULT_GOOGLE_MODEL,
      prompt: 'softer evening light', ratio: '2:3', quality: '2K',
    })
    expect(conversationRegenerateRequest({
      provider: 'openai', model: DEFAULT_OPENAI_MODEL, output: '1536x1024',
    }, 'another version')).toMatchObject({ ratio: '3:2', quality: 'standard' })
    expect(conversationRegenerateRequest({
      provider: 'dashscope', model: DEFAULT_DASHSCOPE_MODEL, output: '928*1664',
    }, 'another version')).toMatchObject({ ratio: '9:16', quality: 'standard' })
  })

  it('supports gallery items with undefined output and explicit ratio/quality', () => {
    const request = conversationRegenerateRequest(
      { provider: 'google', model: DEFAULT_GOOGLE_MODEL },
      'new prompt',
      { ratio: '16:9', quality: '4K' },
    )
    expect(request).toEqual({
      mode: 'generate',
      provider: 'google',
      model: DEFAULT_GOOGLE_MODEL,
      prompt: 'new prompt',
      ratio: '16:9',
      quality: '4K',
    })
  })

  it('rejects providers not supported by the API workbench', () => {
    expect(() => conversationRegenerateRequest({
      provider: 'comfyui', model: 'workflow', output: 'API workflow',
    }, 'another version')).toThrow('Provider')
  })

  it('persists revisions and the selected in-place version', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    const originId = 'sha256:origin'
    const revision = {
      attachment: {
        attachmentId: 'sha256:revision' as any,
        mediaType: 'image/png' as const,
        bytes: 8,
        width: 32,
        height: 32,
      },
      prompt: 'a revised image',
      provider: 'google' as const,
      model: DEFAULT_GOOGLE_MODEL,
      output: '1:1, 1K',
      createdAt: 123,
      ratio: '1:1',
      quality: '1K',
    }

    expect(appendConversationImageRevision(originId, revision)).toMatchObject({ currentIndex: 1 })
    expect(loadConversationImageRevisionChain(originId).revisions).toEqual([revision])
    expect(selectConversationImageRevision(originId, 0).currentIndex).toBe(0)
    expect(loadConversationImageRevisionChain(originId).currentIndex).toBe(0)
    vi.unstubAllGlobals()
  })
})

describe('real HTTP server cancellation with Fetch Abort', () => {
  let server: Server
  let serverUrl: string
  let serverAbortFired: boolean
  let serverPromiseResolve: () => void

  beforeEach(async () => {
    serverAbortFired = false
    new Promise<void>((resolve) => {
      serverPromiseResolve = resolve
    })

    server = createServer(async (req, res) => {
      await serveStudio(req, res, {
        describe: async () => ({ providers: [], activeProvider: 'google' }),
        generate: async (_input, signal) => {
          signal.addEventListener('abort', () => {
            serverAbortFired = true
            serverPromiseResolve()
          })
          // Wait indefinitely until aborted by client disconnect
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
          throw new Error('should not reach here')
        },
        maxBodyBytes: 1024 * 1024,
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo
        serverUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('triggers upstream abort signal when browser fetch is aborted after body upload', async () => {
    const clientController = new AbortController()
    const payload = JSON.stringify({
      mode: 'generate',
      provider: 'google',
      model: DEFAULT_GOOGLE_MODEL,
      prompt: 'a tranquil lake at dawn',
      ratio: '1:1',
      quality: '1K',
    })

    const fetchPromise = fetch(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: serverUrl,
      },
      body: payload,
      signal: clientController.signal,
    })

    // Give server time to parse the body and enter the generate() call
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Client actively aborts the ongoing request
    clientController.abort()

    await expect(fetchPromise).rejects.toThrow()

    // Wait for the server-side abort handler to complete
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(serverAbortFired).toBe(true)
  })
})

describe('image-cache bounded LRU & lifecycle', () => {
  beforeEach(() => {
    clearAttachmentCache()
  })

  afterEach(() => {
    clearAttachmentCache()
    vi.unstubAllGlobals()
  })

  it('deduplicates concurrent fetches for the same attachment', async () => {
    const mockBlob = new Blob(['bytes'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => new Response(mockBlob, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const ref = { attachmentId: 'sha256:same' as any, mediaType: 'image/png' as const, bytes: 5 }
    const [b1, b2] = await Promise.all([fetchAttachmentBlob(ref), fetchAttachmentBlob(ref)])

    expect(b1).toBe(b2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes LRU order when an entry is accessed again', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++
      return new Response(new Blob([`blob-${callCount}`]), { status: 200 })
    }))

    // Fill up to MAX_CACHE_COUNT
    for (let i = 1; i <= MAX_CACHE_COUNT; i++) {
      await fetchAttachmentBlob({ attachmentId: `sha256:${i}` as any, mediaType: 'image/png' as const, bytes: 10 })
    }
    expect(getCacheMetrics().count).toBe(MAX_CACHE_COUNT)

    // Touch item 1 again so it moves to MRU
    await fetchAttachmentBlob({ attachmentId: 'sha256:1' as any, mediaType: 'image/png' as const, bytes: 10 })

    // Now insert item 31, which should evict item 2 (the new oldest), NOT item 1
    await fetchAttachmentBlob({ attachmentId: 'sha256:31' as any, mediaType: 'image/png' as const, bytes: 10 })

    expect(getCacheMetrics().count).toBe(MAX_CACHE_COUNT)

    // Verify item 1 is still in cache (no new fetch)
    const currentFetches = callCount
    await fetchAttachmentBlob({ attachmentId: 'sha256:1' as any, mediaType: 'image/png' as const, bytes: 10 })
    expect(callCount).toBe(currentFetches)
  })

  it('evicts cached items when byte limit is exceeded', async () => {
    // 50MB blobs
    const bigBlobBytes = 50 * 1024 * 1024
    vi.stubGlobal('fetch', vi.fn(async () => {
      const fakeBlob = { size: bigBlobBytes, type: 'image/png' } as unknown as Blob
      return { ok: true, blob: async () => fakeBlob } as Response
    }))

    // 1st item: 50MB
    await fetchAttachmentBlob({ attachmentId: 'sha256:big1' as any, mediaType: 'image/png' as const, bytes: bigBlobBytes })
    // 2nd item: 50MB (total 100MB, <= 128MB)
    await fetchAttachmentBlob({ attachmentId: 'sha256:big2' as any, mediaType: 'image/png' as const, bytes: bigBlobBytes })
    expect(getCacheMetrics().count).toBe(2)
    expect(getCacheMetrics().bytes).toBe(100 * 1024 * 1024)

    // 3rd item: 50MB (total 150MB > 128MB, must evict big1)
    await fetchAttachmentBlob({ attachmentId: 'sha256:big3' as any, mediaType: 'image/png' as const, bytes: bigBlobBytes })
    expect(getCacheMetrics().count).toBe(2)
    expect(getCacheMetrics().bytes).toBe(100 * 1024 * 1024)
  })

  it('removes failed requests immediately from cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))

    const ref = { attachmentId: 'sha256:fail' as any, mediaType: 'image/png' as const, bytes: 0 }
    await expect(fetchAttachmentBlob(ref)).rejects.toThrow()
    expect(getCacheMetrics().count).toBe(0)
  })

  it('evicts targeted item when deleted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['hello']), { status: 200 })))
    const ref = { attachmentId: 'sha256:del' as any, mediaType: 'image/png' as const, bytes: 5 }
    await fetchAttachmentBlob(ref)
    expect(getCacheMetrics().count).toBe(1)

    evictAttachmentCache('sha256:del')
    expect(getCacheMetrics().count).toBe(0)
  })
})

describe('browser-image-utils', () => {
  it('formats relative time accurately for zh and en', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 10_000, 'zh')).toBe('刚刚')
    expect(formatRelativeTime(now - 10_000, 'en')).toBe('Just now')

    expect(formatRelativeTime(now - 5 * 60_000, 'zh')).toBe('5 分钟前')
    expect(formatRelativeTime(now - 5 * 60_000, 'en')).toBe('5m ago')

    expect(formatRelativeTime(now - 3 * 3600_000, 'zh')).toBe('3 小时前')
    expect(formatRelativeTime(now - 3 * 3600_000, 'en')).toBe('3h ago')

    expect(formatRelativeTime(now - 2 * 86400_000, 'zh')).toBe('2 天前')
    expect(formatRelativeTime(now - 2 * 86400_000, 'en')).toBe('2d ago')
  })

  it('safely downloads blob URL by mounting and unmounting anchor', () => {
    let clickCalled = false
    let appended = false
    let removed = false
    const mockAnchor = {
      href: '',
      download: '',
      click: () => { clickCalled = true },
    }
    const mockDocument = {
      createElement: (tag: string) => (tag === 'a' ? mockAnchor : {}),
      body: {
        appendChild: (node: any) => { if (node === mockAnchor) appended = true },
        removeChild: (node: any) => { if (node === mockAnchor) removed = true },
      },
    }
    vi.stubGlobal('document', mockDocument)

    downloadBlobUrl('blob:http://test/123', 'sample.png')

    expect(mockAnchor.href).toBe('blob:http://test/123')
    expect(mockAnchor.download).toBe('sample.png')
    expect(appended).toBe(true)
    expect(clickCalled).toBe(true)
    expect(removed).toBe(true)

    vi.unstubAllGlobals()
  })
})
