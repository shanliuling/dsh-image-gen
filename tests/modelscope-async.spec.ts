import { afterEach, describe, expect, it, vi } from 'vitest'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from '../src/openai-compatible.js'

afterEach(() => { vi.unstubAllGlobals() })
const signal = new AbortController().signal
/** Fast polling for tests: one millisecond between polls, 5 s total budget. */
const fastPoll = { pollIntervalMs: 1, pollBudgetMs: 5000 }
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...'png bytes']).toString('base64')

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const BASE = 'https://api-inference.modelscope.cn/v1'

describe('ModelScope async image tasks (#140)', () => {
  it('submits an async generation, polls the task, and downloads the first output image', async () => {
    let polls = 0
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const request = String(url)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (request === `${BASE}/images/generations`) {
        expect(init?.method).toBe('POST')
        expect(headers.authorization).toBe('Bearer key')
        expect(headers['X-ModelScope-Async-Mode']).toBe('true')
        expect(JSON.parse(String(init?.body))).toEqual({ model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', size: '1024x1024' })
        return json({ task_id: 'task-1' })
      }
      if (request === `${BASE}/tasks/task-1`) {
        expect(init?.method).toBe('GET')
        expect(headers.authorization).toBe('Bearer key')
        // The task type header is mandatory: without it ModelScope answers "task not found".
        expect(headers['X-ModelScope-Task-Type']).toBe('image_generation')
        polls += 1
        return polls === 1 ? json({ task_status: 'PENDING' }) : json({ task_status: 'SUCCEED', output_images: ['https://cdn.modelscope.example/out.png'] })
      }
      if (request === 'https://cdn.modelscope.example/out.png') {
        return new Response(Buffer.from('png bytes'), { headers: { 'content-type': 'image/png' } })
      }
      throw new Error(`unexpected fetch ${request}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', size: '1024x1024', asyncImages: true, maxBytes: 1024, signal, ...fastPoll,
    })
    expect(result).toEqual({ data: new Uint8Array(Buffer.from('png bytes')), mediaType: 'image/png' })
    expect(polls).toBe(2)
  })

  it('omits the quality field ModelScope does not define and merges extraBody last', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url) === `${BASE}/images/generations`) return json({ task_id: 'task-1' })
      return json({ task_status: 'SUCCEED', output_images: [`data:image/png;base64,${png}`] })
    })
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', size: '1024x1024', quality: 'high',
      extraBody: { negative_prompt: 'blurry' }, asyncImages: true, maxBytes: 1024, signal, ...fastPoll,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', size: '1024x1024', negative_prompt: 'blurry' })
  })

  it('rejects a FAILED task with the redacted upstream message', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url) === `${BASE}/images/generations`) return json({ task_id: 'task-1' })
      return json({ task_status: 'FAILED', message: 'quota exceeded for key sk-secret' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const error = await generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'sk-secret', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', asyncImages: true, maxBytes: 1024, signal, ...fastPoll,
    }).catch((cause: unknown) => cause as Error)
    expect(error.message).toMatch(/task task-1 failed/)
    expect(error.message).not.toContain('sk-secret')
  })

  it('rejects a SUCCEED task without output_images', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url) === `${BASE}/images/generations`) return json({ task_id: 'task-1' })
      return json({ task_status: 'SUCCEED', output_images: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', asyncImages: true, maxBytes: 1024, signal, ...fastPoll,
    })).rejects.toThrow(/succeeded but returned no output_images/)
  })

  it('rejects a submission without task_id', async () => {
    const fetchMock = vi.fn(async () => json({ task_status: 'SUCCEED' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', asyncImages: true, maxBytes: 1024, signal, ...fastPoll,
    })).rejects.toThrow(/returned no task_id/)
  })

  it('fails fast on a poll error status instead of waiting for the budget', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url) === `${BASE}/images/generations`) return json({ task_id: 'task-1' })
      return json({ message: 'task not found' }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', asyncImages: true, maxBytes: 1024, signal, ...fastPoll,
    })).rejects.toThrow(/poll failed \(404\)/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after the polling budget with the last known status', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async (url: unknown) => {
        if (String(url) === `${BASE}/images/generations`) return json({ task_id: 'task-1' })
        return json({ task_status: 'RUNNING' })
      })
      vi.stubGlobal('fetch', fetchMock)
      const pending = generateOpenAICompatibleImage({
        provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
        model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', asyncImages: true, maxBytes: 1024, signal,
        pollIntervalMs: 1000, pollBudgetMs: 3000,
      })
      const assertion = expect(pending).rejects.toThrow(/did not finish within 3 seconds \(last status: RUNNING/)
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1_001)
      await assertion
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('propagates cancellation from the polling sleep without further requests', async () => {
    const controller = new AbortController()
    let polls = 0
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url) === `${BASE}/images/generations`) return json({ task_id: 'task-1' })
      polls += 1
      return json({ task_status: 'RUNNING' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const pending = generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', asyncImages: true, maxBytes: 1024,
      signal: controller.signal, pollIntervalMs: 60_000, pollBudgetMs: 600_000,
    })
    // Wait for the first poll to settle, then cancel during the sleep.
    await vi.waitFor(() => expect(polls).toBe(1))
    controller.abort(new Error('user cancelled'))
    await expect(pending).rejects.toThrow('user cancelled')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('hard-stops an in-flight result download at the poll budget', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const request = String(url)
        if (request === `${BASE}/images/generations`) return json({ task_id: 'task-1' })
        if (request === `${BASE}/tasks/task-1`) return json({ task_status: 'SUCCEED', output_images: ['https://cdn.modelscope.example/stuck.png'] })
        // The result download hangs until the watchdog aborts it.
        const downloadSignal = init?.signal
        return new Promise<Response>((_, reject) => {
          downloadSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      const pending = generateOpenAICompatibleImage({
        provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
        model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', asyncImages: true, maxBytes: 1024, signal,
        pollIntervalMs: 1000, pollBudgetMs: 2000,
      })
      const assertion = expect(pending).rejects.toThrow(/did not finish within 2 seconds \(last status: SUCCEED/)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(3_000)
      await assertion
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('edits through the same async flow with image_url data URLs', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const request = String(url)
      if (request === `${BASE}/images/generations`) {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers['X-ModelScope-Async-Mode']).toBe('true')
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'MiniMax/MiniMax-H3-Image',
          prompt: 'add sunglasses',
          image_url: ['data:image/png;base64,' + Buffer.from('source').toString('base64')],
        })
        return json({ task_id: 'task-1' })
      }
      if (request === `${BASE}/tasks/task-1`) {
        return json({ task_status: 'SUCCEED', output_images: [`data:image/png;base64,${png}`] })
      }
      throw new Error(`unexpected fetch ${request}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await editOpenAICompatibleImage({
      apiKey: 'key', baseURL: BASE, model: 'MiniMax/MiniMax-H3-Image',
      prompt: 'add sunglasses', editFormat: 'modelscopeAsync',
      sourceImages: [{ data: new Uint8Array(Buffer.from('source')), mediaType: 'image/png' }],
      maxBytes: 1024, signal, ...fastPoll,
    })
    expect(result.mediaType).toBe('image/png')
    // Edits never reach the multipart /images/edits endpoint in this format.
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/images/generations') || String(url).includes('/tasks/'))).toBe(true)
  })

  it('rejects size/quality extras in the ModelScope edit format', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(editOpenAICompatibleImage({
      apiKey: 'key', baseURL: BASE, model: 'MiniMax/MiniMax-H3-Image',
      prompt: 'add sunglasses', editFormat: 'modelscopeAsync', editExtra: { size: '1024x1024' },
      sourceImages: [{ data: new Uint8Array(Buffer.from('source')), mediaType: 'image/png' }],
      maxBytes: 1024, signal,
    })).rejects.toThrow(/不发送 size、image_size 或 quality/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the default channel on the synchronous request shape without the format', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ b64_json: png }] }))
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1',
      model: 'image-model', prompt: 'a cat', maxBytes: 1024, signal,
    })
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers['X-ModelScope-Async-Mode']).toBeUndefined()
    expect(headers['X-ModelScope-Task-Type']).toBeUndefined()
    expect(fetchMock.mock.calls).toHaveLength(1)
  })

  it('auto-polls a task envelope that answers a plain sync generation request (#140)', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const request = String(url)
      if (request === `${BASE}/images/generations`) {
        // No async header was sent, yet the endpoint answers with a task envelope.
        expect(((init?.headers ?? {}) as Record<string, string>)['X-ModelScope-Async-Mode']).toBeUndefined()
        return json({ task_status: 'SUCCEED', task_id: 'task-9', request_id: 'req-1' })
      }
      if (request === `${BASE}/tasks/task-9`) {
        const headers = (init?.headers ?? {}) as Record<string, string>
        expect(headers.authorization).toBe('Bearer key')
        expect(headers['X-ModelScope-Task-Type']).toBe('image_generation')
        return json({ task_status: 'SUCCEED', output_images: [`data:image/png;base64,${png}`] })
      }
      throw new Error(`unexpected fetch ${request}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', size: '1024x1024', maxBytes: 1024, signal, ...fastPoll,
    })
    expect(result.mediaType).toBe('image/png')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('auto-polls a task envelope that answers a siliconflowJson edit request (#140)', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const request = String(url)
      if (request === `${BASE}/images/generations`) {
        expect(JSON.parse(String(init?.body)).image).toBe('data:image/png;base64,' + Buffer.from('source').toString('base64'))
        return json({ task_status: 'SUCCEED', task_id: 'task-10', request_id: 'req-2' })
      }
      if (request === `${BASE}/tasks/task-10`) return json({ task_status: 'SUCCEED', output_images: [`data:image/png;base64,${png}`] })
      throw new Error(`unexpected fetch ${request}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await editOpenAICompatibleImage({
      apiKey: 'key', baseURL: BASE, model: 'Qwen/Qwen-Image-Edit',
      prompt: 'add sunglasses', editFormat: 'siliconflowJson',
      sourceImages: [{ data: new Uint8Array(Buffer.from('source')), mediaType: 'image/png' }],
      maxBytes: 1024, signal, ...fastPoll,
    })
    expect(result.mediaType).toBe('image/png')
    // Edits never reach the multipart /images/edits endpoint in this fallback.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith('/images/edits'))).toBe(true)
  })

  it('keeps the original error when a no-image response is not a ModelScope envelope (#140)', async () => {
    const fetchMock = vi.fn(async () => json({ task_id: 'task-11' }))
    vi.stubGlobal('fetch', fetchMock)
    // `task_id` without `task_status` belongs to some other async protocol;
    // the fallback must not touch it and no poll may be attempted.
    await expect(generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: BASE,
      model: 'MiniMax/MiniMax-H3-Image', prompt: 'a cat', maxBytes: 1024, signal,
    })).rejects.toThrow(/returned no image/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the original error for a relay that answers unrelated JSON without images (#140)', async () => {
    const fetchMock = vi.fn(async () => json({ foo: 'bar' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAICompatibleImage({
      provider: 'openai-compat', apiKey: 'key', baseURL: 'https://relay.example/v1',
      model: 'image-model', prompt: 'a cat', maxBytes: 1024, signal,
    })).rejects.toThrow(/returned no image/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
