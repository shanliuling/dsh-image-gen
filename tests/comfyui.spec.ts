import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateComfyUIImage } from '../src/comfyui.js'
import { prepareComfyUIWorkflow, validateComfyUIWorkflowJson } from '../src/comfyui-workflow.js'

const WORKFLOW = JSON.stringify({
  6: {
    class_type: 'CLIPTextEncode',
    inputs: { text: '{{prompt}}', seed: '{{seed}}' },
  },
})

function options(overrides: Partial<Parameters<typeof generateComfyUIImage>[0]> = {}): Parameters<typeof generateComfyUIImage>[0] {
  return {
    baseURL: 'http://127.0.0.1:8188',
    workflowJson: WORKFLOW,
    prompt: 'rainy neon street',
    timeoutMs: 5_000,
    maxBytes: 1024,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('ComfyUI workflow preparation', () => {
  it('injects prompt text and a numeric seed without mutating the imported JSON', () => {
    const prepared = prepareComfyUIWorkflow(WORKFLOW, 'a red panda', 42)
    expect(prepared).toEqual({
      6: {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'a red panda', seed: 42 },
      },
    })
    expect(WORKFLOW).toContain('{{prompt}}')
  })

  it('rejects UI or API workflows that do not expose the prompt placeholder', () => {
    expect(() => validateComfyUIWorkflowJson(JSON.stringify({ 1: { inputs: { text: 'fixed' } } })))
      .toThrow('must contain {{prompt}}')
    expect(() => validateComfyUIWorkflowJson(JSON.stringify({ nodes: [{ widgets_values: ['{{prompt}}'] }] })))
      .toThrow('must contain {{prompt}}')
  })
})

describe('ComfyUI image generation', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('submits, polls, downloads, and returns the first final output image', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: {
            preview: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
            save: { images: [{ filename: 'final.png', subfolder: 'images', type: 'output' }] },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateComfyUIImage(options())

    expect(result).toEqual({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })
    const submitted = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as { prompt: { 6: { inputs: { text: string } } } }
    expect(submitted.prompt[6].inputs.text).toBe('rainy neon street')
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('http://127.0.0.1:8188/history/job-1')
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/view?filename=final.png&subfolder=images&type=output')
  })

  it('reports workflow validation errors returned by ComfyUI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'bad node' }), { status: 400 })))
    await expect(generateComfyUIImage(options())).rejects.toThrow('ComfyUI rejected the workflow (400)')
  })

  it('reports when the configured ComfyUI server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(generateComfyUIImage(options())).rejects.toThrow('Could not connect to ComfyUI at http://127.0.0.1:8188')
  })

  it('surfaces a failed ComfyUI job instead of waiting until timeout', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-failed' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-failed': { status: { status_str: 'error', completed: true, messages: ['node execution failed'] } },
      }), { status: 200 })))
    await expect(generateComfyUIImage(options())).rejects.toThrow('ComfyUI workflow failed')
  })

  it('reports a completed job that has no image output', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-empty' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'job-empty': { status: { status_str: 'success', completed: true }, outputs: {} },
      }), { status: 200 })))
    await expect(generateComfyUIImage(options())).rejects.toThrow('completed without an output image')
  })

  it('honours cancellation before making a request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateComfyUIImage(options({ signal: controller.signal }))).rejects.toThrow('cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces one timeout across submission, polling, and download', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job-slow' }), { status: 200 }))
      .mockImplementation(async () => new Response('{}', { status: 200 })))

    const pending = generateComfyUIImage(options({ timeoutMs: 1_000 }))
    const assertion = expect(pending).rejects.toThrow('timed out after 1000 ms')
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
  })
})
