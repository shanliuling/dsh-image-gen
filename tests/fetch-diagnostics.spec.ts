import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeTransportFailure, guardedFetch } from '../src/fetch-diagnostics.js'
import { editSeedreamImage } from '../src/seedream.js'
import { generateOpenAICompatibleImage } from '../src/openai-compatible.js'
import { generateGoogleImage } from '../src/google.js'
import { generateDashScopeImage } from '../src/dashscope.js'

afterEach(() => { vi.unstubAllGlobals() })
const signal = new AbortController().signal

/** Shape undici produces for a socket-level failure: TypeError with the real reason on `cause`. */
function socketFailure(message = 'other side closed'): TypeError {
  const cause = Object.assign(new Error(message), { code: 'UND_ERR_SOCKET' })
  return new TypeError('fetch failed', { cause })
}

describe('describeTransportFailure', () => {
  it('renders the error plus its cause chain with codes', () => {
    expect(describeTransportFailure(socketFailure())).toBe('TypeError: fetch failed <- Error [UND_ERR_SOCKET]: other side closed')
  })

  it('prefers the signal reason once the caller aborted', () => {
    const controller = new AbortController()
    controller.abort(new Error('upstream budget expired'))
    expect(describeTransportFailure(socketFailure(), controller.signal)).toBe('aborted (Error: upstream budget expired)')
  })

  it('keeps non-Error abort reasons as text', () => {
    const controller = new AbortController()
    controller.abort('user closed the panel')
    expect(describeTransportFailure(socketFailure(), controller.signal)).toBe('aborted (user closed the panel)')
  })

  it('names the default AbortError for plain cancels', () => {
    const controller = new AbortController()
    controller.abort()
    expect(describeTransportFailure(controller.signal.reason, controller.signal)).toBe('aborted (AbortError: This operation was aborted)')
  })

  it('caps the cause-chain walk at three levels', () => {
    const deepest = new Error('level 4')
    const third = new Error('level 3', { cause: deepest })
    const second = new Error('level 2', { cause: third })
    const first = new Error('level 1', { cause: second })
    expect(describeTransportFailure(first)).toBe('Error: level 1 <- Error: level 2 <- Error: level 3')
  })

  it('falls back for non-error throwables', () => {
    expect(describeTransportFailure(undefined)).toBe('unknown transport error')
    expect(describeTransportFailure(42)).toBe('42')
  })
})

describe('guardedFetch transport diagnostics (#79)', () => {
  it('rethrows generation transport failures with phase, elapsed seconds, and the cause chain', async () => {
    const fetchMock = vi.fn(async () => { throw socketFailure() })
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'seedream', apiKey: 'key', baseURL: 'https://ark.example/api/v3', model: 'seedream', prompt: 'a cat', maxBytes: 1024, signal }))
      .rejects.toThrow(/^seedream image request failed after \d+(\.\d+)?s: TypeError: fetch failed <- Error \[UND_ERR_SOCKET\]: other side closed$/)
  })

  it('keeps the original error reachable on cause', async () => {
    const original = socketFailure()
    vi.stubGlobal('fetch', vi.fn(async () => { throw original }))
    const rejection: Error = await generateOpenAICompatibleImage({ provider: 'openai', apiKey: 'key', baseURL: 'https://api.openai.com/v1', model: 'gpt-image-2', prompt: 'a cat', maxBytes: 1024, signal })
      .then(() => { throw new Error('expected a rejection') }, error => error)
    expect(rejection.cause).toBe(original)
  })

  it('reports download transport failures as a separate phase', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://image.example/result' }] }), { headers: { 'content-type': 'application/json' } }))
      .mockRejectedValueOnce(socketFailure('socket hung up'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({ provider: 'seedream', apiKey: 'key', baseURL: 'https://ark.example/api/v3', model: 'seedream', prompt: 'a cat', maxBytes: 1024, signal }))
      .rejects.toThrow(/^seedream image download failed after \d+(\.\d+)?s: TypeError: fetch failed <- Error \[UND_ERR_SOCKET\]: socket hung up$/)
  })

  it('labels edit transport failures with the editing phase', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw socketFailure() }))
    await expect(editSeedreamImage({ apiKey: 'key', baseURL: 'https://ark.example/api/v3', model: 'seedream', prompt: 'add a hat', sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' }], maxBytes: 1024, signal }))
      .rejects.toThrow(/^seedream image editing failed after \d+(\.\d+)?s: /)
  })

  it('reports the abort reason when the caller signal cancelled the request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('upstream budget expired'))
    vi.stubGlobal('fetch', vi.fn(async () => { throw controller.signal.reason }))
    await expect(guardedFetch('seedream image request', controller.signal, () => fetch('https://ark.example/api/v3/images/generations')))
      .rejects.toThrow(/^seedream image request failed after \d+(\.\d+)?s: aborted \(Error: upstream budget expired\)$/)
  })

  it('redacts key-shaped values leaking through cause messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw socketFailure('connect failed for token sk-abcdefghijklmnop1234') }))
    await expect(guardedFetch('openai image request', signal, () => fetch('https://api.openai.com/v1/images/generations')))
      .rejects.toThrow(/\[REDACTED\]/)
  })

  it('leaves successful fetches untouched', async () => {
    const response = new Response('{}', { headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(guardedFetch('openai image request', signal, () => fetch('https://api.openai.com/v1/images/generations'))).resolves.toBe(response)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

const opaqueKey = 'fixture-5f811fea-d938-46d7-9a47-07148cc510db'
const compatibleInput = { provider: 'seedream' as const, apiKey: opaqueKey, baseURL: 'https://ark.example/api/v3', model: 'seedream', prompt: 'a cat', maxBytes: 1024, signal }
const editInput = { ...compatibleInput, sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' as const }] }
const requestCases = [
  { label: 'seedream image request', run: () => generateOpenAICompatibleImage(compatibleInput) },
  { label: 'seedream image editing', run: () => editSeedreamImage(editInput) },
  { label: 'Google image generation request', run: () => generateGoogleImage({ apiKey: opaqueKey, endpoint: 'https://google.example/interactions', model: 'gemini-image', prompt: 'a cat', aspectRatio: '1:1', imageSize: '2K', maxBytes: 1024, signal }) },
  { label: 'DashScope image generation', run: () => generateDashScopeImage({ apiKey: opaqueKey, endpoint: 'https://dashscope.example/api/v1', model: 'qwen-image', prompt: 'a cat', maxBytes: 1024, signal }) },
]

/** A response that delivers a partial chunk, then loses its connection after headers. */
function brokenBody(contentType: string, error: unknown = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
    pull(controller) { controller.error(error) },
  }), { headers: { 'content-type': contentType } })
}

describe('complete provider transport diagnostics (#79 regressions)', () => {
  it.each(requestCases)('reports $label response-body disconnects', async ({ label, run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => brokenBody('application/json')))
    const error: Error = await run().then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).toContain(`${label} failed after `)
    expect(error.message).toContain('TypeError: terminated <- Error [UND_ERR_SOCKET]: other side closed')
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it.each(requestCases)('redacts the actual opaque key in $label fetch errors', async ({ run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw socketFailure(`fixture rejected credential ${opaqueKey}`) }))
    const error: Error = await run().then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).not.toContain(opaqueKey)
    expect(error.message).toContain('[REDACTED]')
  })

  it.each(requestCases)('redacts the actual opaque key in $label body errors', async ({ run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => brokenBody('application/json', socketFailure(`fixture rejected credential ${opaqueKey}`))))
    const error: Error = await run().then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).not.toContain(opaqueKey)
    expect(error.message).toContain('[REDACTED]')
  })

  it.each([
    { name: 'compatible generation', run: () => generateOpenAICompatibleImage(compatibleInput), response: { data: [{ url: 'https://image.example/result' }] }, label: 'seedream image download' },
    { name: 'Seedream editing', run: () => editSeedreamImage(editInput), response: { data: [{ url: 'https://image.example/result' }] }, label: 'seedream image download' },
    { name: 'DashScope generation', run: requestCases[3]!.run, response: { output: { choices: [{ message: { content: [{ image: 'https://image.example/result' }] } }] } }, label: 'DashScope image download' },
  ])('reports $name image-body disconnects with phase and key redaction', async ({ run, response, label }) => {
    const failure = socketFailure(`fixture rejected credential ${opaqueKey}`)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response)))
      .mockResolvedValueOnce(brokenBody('image/png', failure)))
    const error: Error = await run().then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).toContain(`${label} failed after `)
    expect(error.message).toContain('UND_ERR_SOCKET')
    expect(error.message).not.toContain(opaqueKey)
    expect(error.cause).toBe(failure)
  })

  it.each([
    { reason: { kind: 'user' }, text: 'aborted (user)' },
    { reason: { kind: 'parent' }, text: 'aborted (parent)' },
    { reason: { kind: 'disposed' }, text: 'aborted (disposed)' },
    { reason: { kind: 'hook', reason: 'execution window expired' }, text: 'aborted (hook: execution window expired)' },
  ])('preserves the host cancellation reason $reason.kind', ({ reason, text }) => {
    const controller = new AbortController()
    controller.abort(reason)
    expect(describeTransportFailure(reason, controller.signal)).toBe(text)
  })

  it('reports structured cancellation during body consumption and redacts its reason', async () => {
    const controller = new AbortController()
    const reason = { kind: 'hook', reason: `fixture rejected credential ${opaqueKey}` }
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort(reason)
      return brokenBody('application/json', reason)
    }))
    const error: Error = await generateOpenAICompatibleImage({ ...compatibleInput, signal: controller.signal })
      .then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).toContain('aborted (hook: fixture rejected credential [REDACTED])')
    expect(error.message).not.toContain(opaqueKey)
    expect(error.cause).toBe(reason)
  })

  it('bounds cyclic structured cancellation reasons', async () => {
    const reason: { kind: string; reason?: unknown } = { kind: 'hook' }
    reason.reason = reason
    const controller = new AbortController()
    controller.abort(reason)
    vi.stubGlobal('fetch', vi.fn(async () => { throw reason }))
    const error: Error = await generateOpenAICompatibleImage({ ...compatibleInput, signal: controller.signal })
      .then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).toContain('aborted (hook:')
    expect(error.message.length).toBeLessThan(700)
  })

  it('preserves the existing response size-limit error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5000))))
    await expect(generateOpenAICompatibleImage({ ...compatibleInput, maxBytes: 1 }))
      .rejects.toThrow(/^Image response exceeded the 4098 byte limit$/)
  })

  it('preserves invalid-JSON errors instead of labeling them transport failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid json')))
    await expect(generateOpenAICompatibleImage(compatibleInput)).rejects.toThrow(/^seedream image request returned invalid JSON$/)
    await expect(requestCases[3]!.run()).rejects.toBeInstanceOf(SyntaxError)
  })
})
