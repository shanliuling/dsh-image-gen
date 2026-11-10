import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionBlob } from '../src/subscription/blob.js'
import { SubscriptionManager } from '../src/subscription/manager.js'
import { antigravityGenerateImage, antigravityResolveProject, compareVersions, getAntigravityVersion, initAntigravityVersion, MIN_ANTIGRAVITY_VERSION, setAntigravityVersionForTest } from '../src/subscription/vendors/antigravity.js'

const blob: SubscriptionBlob = {
  accessToken: 'google-access-secret', refreshToken: 'google-refresh-secret',
  expiresAt: Date.now() + 3_600_000, accountId: 'private-account-id',
  email: 'private@example.com', label: 'Google',
}
const daily = 'https://daily-cloudcode-pa.googleapis.com'
const prod = 'https://cloudcode-pa.googleapis.com'
const unsupported = {
  allowedTiers: [{ id: 'standard-tier', isDefault: true }],
  ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'Client migration required' }],
}
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
})
const image = () => new Response('data: ' + JSON.stringify({
  response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'c3R1Yg==' } }] } }] },
}) + '\n', { headers: { 'content-type': 'text/event-stream' } })
const manager = () => new SubscriptionManager({
  credentials: { resolve: async () => ({ value: JSON.stringify(blob) }) },
} as never)

describe('Antigravity discovery and failure diagnostics', () => {
  beforeEach(() => { setAntigravityVersionForTest('3.4.5') })
  afterEach(() => { vi.unstubAllGlobals(); setAntigravityVersionForTest(undefined) })

  it.each([
    ['win32', 'x64', 'WINDOWS_AMD64'],
    ['darwin', 'x64', 'DARWIN_AMD64'],
    ['darwin', 'arm64', 'DARWIN_ARM64'],
    ['linux', 'x64', 'LINUX_AMD64'],
    ['linux', 'arm64', 'LINUX_ARM64'],
    ['win32', 'arm64', 'PLATFORM_UNSPECIFIED'],
  ])('sends the Google platform enum for %s/%s in both metadata locations', async (platform, arch, expected) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      const metadata = JSON.parse(new Headers(init.headers).get('Client-Metadata')!)
      expect(body.metadata).toEqual(metadata)
      expect(body.metadata.platform).toBe(expected)
      return json({ cloudaicompanionProject: 'actual-project' })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      Object.defineProperty(process, 'platform', { value: platform })
      Object.defineProperty(process, 'arch', { value: arch })
      expect(await antigravityResolveProject(blob)).toBe('actual-project')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      Object.defineProperty(process, 'arch', originalArch)
    }
  })

  it('re-discovers a missing project on the next generation instead of caching the fallback as an account project', async () => {
    let hasProject = false
    const fetchMock = vi.fn(async (url: string) => url.includes(':loadCodeAssist')
      ? json(hasProject ? { cloudaicompanionProject: { id: 'actual-project' } } : unsupported)
      : image())
    vi.stubGlobal('fetch', fetchMock)
    const subject = manager()
    await subject.generate({ vendor: 'antigravity', prompt: 'a blue cup' })
    const firstLoads = fetchMock.mock.calls.filter(([url]) => url.includes(':loadCodeAssist')).length
    hasProject = true
    await subject.generate({ vendor: 'antigravity', prompt: 'a red cup' })
    expect(fetchMock.mock.calls.filter(([url]) => url.includes(':loadCodeAssist')).length).toBeGreaterThan(firstLoads)
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(JSON.parse(String(calls.filter(([url]) => url.includes(':streamGenerateContent')).at(-1)![1].body)).project).toBe('actual-project')
  })

  it('keeps caching a real account project and uses valid platform metadata on generation', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes(':loadCodeAssist')) return json({ cloudaicompanionProject: 'actual-project' })
      const platform = JSON.parse(new Headers(init.headers).get('Client-Metadata')!).platform
      expect(['WINDOWS_AMD64', 'DARWIN_AMD64', 'DARWIN_ARM64', 'LINUX_AMD64', 'LINUX_ARM64', 'PLATFORM_UNSPECIFIED']).toContain(platform)
      return image()
    })
    vi.stubGlobal('fetch', fetchMock)
    const subject = manager()
    await subject.generate({ vendor: 'antigravity', prompt: 'a blue cup' })
    await subject.generate({ vendor: 'antigravity', prompt: 'a red cup' })
    expect(fetchMock.mock.calls.filter(([url]) => url.includes(':loadCodeAssist'))).toHaveLength(1)
  })

  it('tries the ordinary daily generation endpoint before the production fallback', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(':loadCodeAssist')) return json({ cloudaicompanionProject: 'actual-project' })
      return url.startsWith(daily + '/') ? image() : json({ error: { message: 'upstream unavailable' } }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(manager().generate({ vendor: 'antigravity', prompt: 'a blue cup' })).resolves.toEqual([{ b64_json: 'c3R1Yg==' }])
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith(prod + '/') && url.includes(':streamGenerateContent'))).toBe(false)
  })

  it('uses ordinary daily discovery when the existing discovery endpoints fail', async () => {
    const fetchMock = vi.fn(async (url: string) => url.startsWith(daily + '/')
      ? json({ cloudaicompanionProject: 'daily-account-project' })
      : json({ error: { message: 'discovery unavailable' } }, 500))
    vi.stubGlobal('fetch', fetchMock)
    expect(await antigravityResolveProject(blob)).toBe('daily-account-project')
  })

  it('preserves discovery eligibility and all failed endpoints instead of exposing only the final 429', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(':loadCodeAssist')) return json(unsupported)
      const status = url.startsWith(prod + '/') ? 429 : 500
      return json({ error: { status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL', message: 'upstream rejected request' } }, status)
    })
    vi.stubGlobal('fetch', fetchMock)
    const error = await manager().generate({ vendor: 'antigravity', prompt: 'a blue cup' }).catch(value => value as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('UNSUPPORTED_CLIENT')
    expect(error.message).toContain('兼容项目')
    expect(error.message).toContain('HTTP 500')
    expect(error.message).toContain('HTTP 429')
    expect(error.message).toContain('daily-cloudcode-pa.googleapis.com')
    expect(error.message).toContain('cloudcode-pa.googleapis.com')
  })

  it('redacts credentials and account identity from propagated upstream diagnostics', async () => {
    const privateDetail = [blob.accessToken, blob.refreshToken, blob.accountId, blob.email].join(' ')
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: privateDetail } }, 400)))
    const error = await manager().generate({ vendor: 'antigravity', prompt: 'a blue cup' }).catch(value => value as Error)
    for (const secret of [blob.accessToken, blob.refreshToken, blob.accountId, blob.email]) expect(error.message).not.toContain(secret)
    expect(error.message).toContain('[redacted]')
    expect(error.message).toContain('loadCodeAssist')
  })

  it('does not turn an unsupported Code Assist tier into a blanket image-generation ban or invoke onboarding', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(':loadCodeAssist')) return json(unsupported)
      expect(url).toContain(':streamGenerateContent')
      return image()
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(manager().generate({ vendor: 'antigravity', prompt: 'a blue cup' })).resolves.toEqual([{ b64_json: 'c3R1Yg==' }])
    expect(fetchMock.mock.calls.some(([url]) => url.includes(':onboardUser'))).toBe(false)
  })

  it('propagates cancellation during discovery without continuing through the fallback endpoints', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort(new Error('cancelled by caller'))
      init.signal!.throwIfAborted()
      return json({ cloudaicompanionProject: 'actual-project' })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(manager().generate({ vendor: 'antigravity', prompt: 'a blue cup', signal: controller.signal })).rejects.toThrow('cancelled by caller')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries unsupported-client discovery with only the User-Agent changed and caches the actual project', async () => {
    const discoveryCalls: Array<{ url: string; init: RequestInit }> = []
    const generationProjects: string[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes(':loadCodeAssist')) {
        discoveryCalls.push({ url, init })
        return new Headers(init.headers).get('User-Agent')!.includes('Antigravity/')
          ? json({ cloudaicompanionProject: { id: 'recovered-account-project' } })
          : json(unsupported)
      }
      generationProjects.push(JSON.parse(String(init.body)).project)
      return image()
    })
    vi.stubGlobal('fetch', fetchMock)
    const subject = manager()
    await expect(subject.generate({ vendor: 'antigravity', prompt: 'a blue cup' })).resolves.toEqual([{ b64_json: 'c3R1Yg==' }])
    expect(discoveryCalls).toHaveLength(5)
    const original = discoveryCalls[0]!
    const retry = discoveryCalls[4]!
    expect(retry.url).toBe(original.url)
    expect(retry.init.method).toBe(original.init.method)
    expect(retry.init.body).toBe(original.init.body)
    const originalHeaders = new Headers(original.init.headers)
    const retryHeaders = new Headers(retry.init.headers)
    expect(originalHeaders.get('User-Agent')).toBe('google-api-nodejs-client/9.15.1')
    expect(retryHeaders.get('User-Agent')).toContain('Antigravity/3.4.5')
    originalHeaders.delete('User-Agent')
    retryHeaders.delete('User-Agent')
    expect([...retryHeaders]).toEqual([...originalHeaders])
    await subject.generate({ vendor: 'antigravity', prompt: 'a red cup' })
    expect(discoveryCalls).toHaveLength(5)
    expect(generationProjects).toEqual(['recovered-account-project', 'recovered-account-project'])
    expect(fetchMock.mock.calls.some(([url]) => url.includes(':onboardUser'))).toBe(false)
  })

  it('preserves the original discovery endpoint priority when a later SDK endpoint has an account project', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('User-Agent')).toBe('google-api-nodejs-client/9.15.1')
      return fetchMock.mock.calls.length === 1 ? json(unsupported) : json({ cloudaicompanionProject: 'existing-account-project' })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await antigravityResolveProject(blob)).toBe('existing-account-project')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry discovery for an unrelated missing-project response', async () => {
    const fetchMock = vi.fn(async () => json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }))
    vi.stubGlobal('fetch', fetchMock)
    await antigravityResolveProject(blob)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('retains the working image fallback when Antigravity-identity discovery is also unavailable', async () => {
    const identities: string[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes(':loadCodeAssist')) {
        const ua = new Headers(init.headers).get('User-Agent')!
        identities.push(ua)
        return ua.includes('Antigravity/') ? json({ error: { message: 'discovery unavailable' } }, 403) : json(unsupported)
      }
      return image()
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(manager().generate({ vendor: 'antigravity', prompt: 'a blue cup' })).resolves.toEqual([{ b64_json: 'c3R1Yg==' }])
    expect(identities.filter(ua => ua === 'google-api-nodejs-client/9.15.1')).toHaveLength(4)
    expect(identities.filter(ua => ua.includes('Antigravity/'))).toHaveLength(4)
  })

  it('labels identity-retry errors separately and keeps them redacted', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes(':loadCodeAssist')) {
        return new Headers(init.headers).get('User-Agent')!.includes('Antigravity/')
          ? json({ error: { message: `${blob.accessToken} ${blob.refreshToken} ${blob.email}` } }, 403)
          : json(unsupported)
      }
      return json({ error: { message: 'generation unavailable' } }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    const error = await manager().generate({ vendor: 'antigravity', prompt: 'a blue cup' }).catch(value => value as Error)
    expect(error.message).toContain('[Antigravity/3.4.5]')
    expect(error.message).toContain('HTTP 403')
    expect(error.message).toContain('HTTP 500')
    expect(error.message).toContain('[redacted]')
    for (const secret of [blob.accessToken, blob.refreshToken, blob.email]) expect(error.message).not.toContain(secret)
  })

  it('propagates cancellation during the identity retry without trying further endpoints or generating', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain(':loadCodeAssist')
      if (new Headers(init.headers).get('User-Agent')!.includes('Antigravity/')) {
        controller.abort(new Error('cancelled during identity retry'))
        init.signal!.throwIfAborted()
      }
      return json(unsupported)
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(manager().generate({ vendor: 'antigravity', prompt: 'a blue cup', signal: controller.signal }))
      .rejects.toThrow('cancelled during identity retry')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('loads the current Antigravity version before retrying discovery', async () => {
    setAntigravityVersionForTest(undefined)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes(':loadCodeAssist')) {
        expect(url).toContain('antigravity-auto-updater-')
        return new Response('3.1.2')
      }
      const ua = new Headers(init!.headers).get('User-Agent')!
      if (ua.includes('Antigravity/')) {
        expect(ua).toContain('Antigravity/3.1.2')
        return json({ cloudaicompanionProject: 'current-client-project' })
      }
      return json(unsupported)
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await antigravityResolveProject(blob)).toBe('current-client-project')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('propagates cancellation during version discovery before any identity retry', async () => {
    setAntigravityVersionForTest(undefined)
    const controller = new AbortController()
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes(':loadCodeAssist')) return json(unsupported)
      expect(url).toContain('antigravity-auto-updater-')
      controller.abort(new Error('cancelled during version discovery'))
      init.signal!.throwIfAborted()
      return new Response('3.1.2')
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(antigravityResolveProject(blob, controller.signal)).rejects.toThrow('cancelled during version discovery')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('never sends a client version below the floor the backend still serves (#123)', async () => {
    expect(compareVersions('2.0.6', MIN_ANTIGRAVITY_VERSION)).toBeLessThan(0)
    expect(compareVersions('3.10.0', '3.9.9')).toBeGreaterThan(0)
    setAntigravityVersionForTest(undefined)
    expect(getAntigravityVersion()).toBe(MIN_ANTIGRAVITY_VERSION)
    // A stale version from the updater is ignored; the changelog's newer one is used.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.includes('auto-updater') ? 'Auto updater is running. Fixed Version: 2.0.6' : 'Antigravity 3.2.1 release notes')))
    await initAntigravityVersion()
    expect(getAntigravityVersion()).toBe('3.2.1')
    // Both stale: the floor, never 2.0.6.
    setAntigravityVersionForTest(undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Fixed Version: 2.0.6')))
    await initAntigravityVersion()
    expect(getAntigravityVersion()).toBe(MIN_ANTIGRAVITY_VERSION)
    // A cached stale version cannot pull the header down either.
    setAntigravityVersionForTest('2.0.6')
    expect(getAntigravityVersion()).toBe(MIN_ANTIGRAVITY_VERSION)
  })

  it('reports the text an endpoint returned instead of an image', async () => {
    const notice = 'This version of Antigravity is no longer supported. Please download and install the latest version.'
    const sse = `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: notice }] } }] } })}\n\n`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })))
    const error = await antigravityGenerateImage({ blob, projectId: 'p', prompt: 'a sailboat' } as never).catch((cause: unknown) => cause as Error)
    expect(error.message).toContain('returned text instead of an image: This version of Antigravity is no longer supported')
  })
})
