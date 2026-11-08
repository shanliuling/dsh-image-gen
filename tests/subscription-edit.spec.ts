import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionManager, SUBSCRIPTION_MAX_REFERENCE_IMAGES, type SubscriptionVendor } from '../src/subscription/manager.js'
import { DEFAULT_SUBSCRIPTION_MODELS } from '../src/shared.js'
import { antigravityEnvelope, antigravityImageBody } from '../src/subscription/vendors/antigravity.js'

/**
 * Wire-protocol tests for subscription image editing. These pin the contract
 * the vendor endpoints expect: endpoint selection by the presence of
 * reference images, reference-image encoding per channel, and the shared
 * 5-image guard. Network calls are stubbed; only the real request shape is
 * asserted.
 */

/** Valid non-expired OAuth blob the manager can use without refresh. */
function freshBlob(): { accessToken: string; refreshToken: string; expiresAt: number; accountId: string; email: string } {
  return {
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'account-123',
    email: 'user@example.com',
  }
}

function harness() {
  const resolve = vi.fn(async () => ({ value: JSON.stringify(freshBlob()) }))
  const ctx = { credentials: { resolve } } as never
  const manager = new SubscriptionManager(ctx)
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    data: [{ b64_json: Buffer.from('stub').toString('base64') }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return { manager, fetchMock }
}

describe('subscription manager edit wire protocol', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it.each(['codex', 'grok'] as const)('redacts %s subscription credentials echoed in upstream errors', async vendor => {
    const { manager, fetchMock } = harness()
    const secrets = freshBlob()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: [secrets.accessToken, secrets.refreshToken, secrets.accountId, secrets.email].join(' ') },
    }), { status: 401, headers: { 'content-type': 'application/json' } }))

    const error = await manager.generate({ vendor, prompt: 'a portrait' }).then(
      () => { throw new Error('expected generation to fail') },
      (value: unknown) => value as Error,
    )

    expect(error.message).toContain(`${vendor} HTTP 401`)
    for (const secret of [secrets.accessToken, secrets.refreshToken, secrets.accountId, secrets.email]) {
      expect(error.message).not.toContain(secret)
    }
  })

  it('targets the codex edits endpoint and encodes references as image_url data URLs', async () => {
    const { manager, fetchMock } = harness()
    const reference = { data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' }

    await manager.generate({ vendor: 'codex', prompt: 'make it blue', referenceImages: [reference] })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/edits')
    const body = JSON.parse(String(init.body)) as { model: string; prompt: string; images: Array<{ image_url: string }> }
    expect(body.prompt).toBe('make it blue')
    expect(body.model).toBe('gpt-image-2.5-flare')
    expect(body.images).toHaveLength(1)
    expect(body.images[0]!.image_url).toBe(`data:image/png;base64,${Buffer.from(reference.data).toString('base64')}`)
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer access-token-value')
    expect(headers['chatgpt-account-id']).toBe('account-123')
  })

  it('targets the grok edits endpoint with the documented single image field', async () => {
    const { manager, fetchMock } = harness()
    const reference = { data: new Uint8Array([9, 9]), mediaType: 'image/jpeg' }

    await manager.generate({ vendor: 'grok', prompt: 'make it blue', referenceImages: [reference] })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.x.ai/v1/images/edits')
    const body = JSON.parse(String(init.body)) as { model: string; image: { type: string; url: string }; images?: unknown }
    expect(body.model).toBe('grok-imagine-image-2.0')
    expect(body.images).toBeUndefined()
    expect(body.image).toEqual({ type: 'image_url', url: `data:image/jpeg;base64,${Buffer.from(reference.data).toString('base64')}` })
  })

  it('uses the documented images array for a multi-reference grok edit', async () => {
    const { manager, fetchMock } = harness()
    const refs = [1, 2].map(value => ({ data: new Uint8Array([value]), mediaType: 'image/png' }))
    await manager.generate({ vendor: 'grok', prompt: 'combine them', referenceImages: refs, size: '16:9' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { images: Array<{ type: string; url: string }>; image?: unknown; aspect_ratio: string }
    expect(body.image).toBeUndefined()
    expect(body.aspect_ratio).toBe('16:9')
    expect(body.images).toEqual(refs.map(ref => ({ type: 'image_url', url: `data:image/png;base64,${Buffer.from(ref.data).toString('base64')}` })))
  })

  it('keeps the generations endpoint when no reference images are supplied', async () => {
    const { manager, fetchMock } = harness()

    await manager.generate({ vendor: 'codex', prompt: 'a portrait' })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    await manager.generate({ vendor: 'grok', prompt: 'a portrait' })
    const [grokUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(grokUrl).toBe('https://api.x.ai/v1/images/generations')
  })

  it('rejects more reference images than every channel accepts', async () => {
    const { manager, fetchMock } = harness()
    const references = Array.from({ length: SUBSCRIPTION_MAX_REFERENCE_IMAGES + 1 }, () => ({
      data: new Uint8Array([1]), mediaType: 'image/png',
    }))

    await expect(manager.generate({ vendor: 'codex', prompt: 'too many', referenceImages: references }))
      .rejects.toThrow('订阅生图最多支持')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves no images field on the generation body when editing is absent', async () => {
    const { manager, fetchMock } = harness()

    await manager.generate({ vendor: 'grok', prompt: 'a portrait' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.images).toBeUndefined()
    expect(body.prompt).toBe('a portrait')
  })

  it('uses the Codex size and quality fields on the private generations route', async () => {
    const { manager, fetchMock } = harness()
    await manager.generate({ vendor: 'codex', prompt: 'a portrait', size: '864x1536', quality: 'high' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    expect(JSON.parse(String(init.body))).toMatchObject({ size: '864x1536', quality: 'high' })
  })

  it('asks the Codex route for a GIF on the 2.6 model, and keeps stills on the probed model', async () => {
    const { manager, fetchMock } = harness()
    await manager.generate({ vendor: 'codex', prompt: 'a bouncing ball', gif: { frameCount: 6, frameDurationMs: 150 } })
    const gifBody = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(gifBody).toMatchObject({ model: 'gpt-image-2.6-flare', output_format: 'gif', frame_count: 6, frame_duration_ms: 150 })
    await manager.generate({ vendor: 'codex', prompt: 'animate it', gif: {}, referenceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }] })
    const [editUrl, editInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(editUrl).toBe('https://chatgpt.com/backend-api/codex/images/edits')
    const editBody = JSON.parse(String(editInit.body)) as Record<string, unknown>
    expect(editBody).toMatchObject({ model: 'gpt-image-2.6-flare', output_format: 'gif' })
    expect(editBody).not.toHaveProperty('frame_count')
    await manager.generate({ vendor: 'codex', prompt: 'a portrait' })
    const stillBody = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(stillBody.model).toBe('gpt-image-2.5-flare')
    expect(stillBody).not.toHaveProperty('output_format')
    await expect(manager.generate({ vendor: 'grok', prompt: 'a ball', gif: {} })).rejects.toThrow('不支持 GIF')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('preserves the effective quality reported by the Codex response when present', async () => {
    const { manager, fetchMock } = harness()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      quality: 'medium', data: [{ b64_json: Buffer.from('stub').toString('base64') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await manager.generate({ vendor: 'codex', prompt: 'a portrait', quality: 'high' })
    expect(result[0]?.reportedQuality).toBe('medium')
  })

  it.each([
    ['1536x864', '16:9', '横向宽屏'],
    ['864x1536', '9:16', '竖向'],
    ['1024x1024', '1:1', '正方形'],
    ['1536x1024', '3:2', '横向宽屏'],
  ])('reinforces Codex size %s in the generation and edit prompt', async (size, ratio, orientation) => {
    const { manager, fetchMock } = harness()
    for (const referenceImages of [[], [{ data: new Uint8Array([1]), mediaType: 'image/png' }]]) {
      await manager.generate({ vendor: 'codex', prompt: '小男孩跳舞', size, referenceImages })
    }
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        size,
        prompt: `小男孩跳舞\n\n输出图片的画布宽高比必须为${ratio}，${orientation}构图，完整画面铺满${orientation}画布。`,
      })
    }
  })

  it.each([undefined, 'auto', '', '0x1536', 'invalid'])('keeps the Codex prompt unchanged without explicit valid dimensions (%s)', async (size) => {
    const { manager, fetchMock } = harness()
    await manager.generate({ vendor: 'codex', prompt: 'a portrait', ...(size !== undefined ? { size } : {}) })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).prompt).toBe('a portrait')
  })

  it('uses the xAI aspect_ratio and resolution fields for Grok subscription', async () => {
    const { manager, fetchMock } = harness()
    await manager.generate({ vendor: 'grok', prompt: 'a portrait', size: '9:16', quality: '2k' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.x.ai/v1/images/generations')
    expect(JSON.parse(String(init.body))).toMatchObject({ aspect_ratio: '9:16', resolution: '2k' })
  })

  it('maps an explicit Grok subscription tool size onto an aspect ratio', async () => {
    const { manager, fetchMock } = harness()
    await manager.generate({ vendor: 'grok', prompt: 'a portrait', size: '864x1536' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ aspect_ratio: '9:16' })
  })

  it('uses Gemini imageConfig for Google subscription ratio and HD', () => {
    const body = antigravityImageBody({ prompt: 'a portrait', aspectRatio: '9:16', hd: true })
    expect(body.generationConfig).toMatchObject({ imageConfig: { aspectRatio: '9:16', imageSize: '4K' } })
  })

  it('uses Gemini 3.1 Flash Image for the Google subscription profile and wire request', () => {
    expect(DEFAULT_SUBSCRIPTION_MODELS['google-sub']).toBe('gemini-3.1-flash-image')
    expect(antigravityEnvelope('account-project', antigravityImageBody({ prompt: 'a portrait' }))).toMatchObject({
      project: 'account-project',
      model: 'gemini-3.1-flash-image',
    })
  })
})
