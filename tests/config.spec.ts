import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_DASHSCOPE_ENDPOINT,
  DEFAULT_DASHSCOPE_MODEL,
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_COMFYUI_TIMEOUT_MS,
  DEFAULT_COMFYUI_WORKFLOW_LABEL,
  DEFAULT_GOOGLE_ENDPOINT,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_SEEDREAM_BASE_URL,
  DEFAULT_SEEDREAM_MODEL,
  resolveProvider,
} from '../src/config.js'

describe('resolveProvider', () => {
  it('resolves the Google defaults', () => {
    expect(resolveProvider({})).toEqual({ provider: 'google', apiKeyEnv: 'GEMINI_API_KEY', endpoint: DEFAULT_GOOGLE_ENDPOINT, model: DEFAULT_GOOGLE_MODEL, aspectRatio: '1:1', imageSize: '1K' })
  })

  it('resolves editable OpenAI-compatible profiles independently', () => {
    expect(resolveProvider({ provider: 'openai' })).toEqual({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', baseURL: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL, imageSize: '1024x1024' })
    expect(resolveProvider({ provider: 'seedream' })).toEqual({ provider: 'seedream', apiKeyEnv: 'ARK_API_KEY', baseURL: DEFAULT_SEEDREAM_BASE_URL, model: DEFAULT_SEEDREAM_MODEL, imageSize: '2K' })
  })

  it('resolves DashScope profile', () => {
    expect(resolveProvider({ provider: 'dashscope' })).toEqual({
      provider: 'dashscope',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      endpoint: DEFAULT_DASHSCOPE_ENDPOINT,
      model: DEFAULT_DASHSCOPE_MODEL,
      imageSize: '1024*1024',
    })
  })

  it('resolves a credential-free ComfyUI profile', () => {
    expect(resolveProvider({ provider: 'comfyui' })).toEqual({
      provider: 'comfyui',
      baseURL: DEFAULT_COMFYUI_BASE_URL,
      workflowJson: '',
      workflowName: DEFAULT_COMFYUI_WORKFLOW_LABEL,
      timeoutMs: DEFAULT_COMFYUI_TIMEOUT_MS,
    })
  })
})

describe('Config Schema validation', () => {
  it('validates provider: dashscope without rejection', () => {
    const validated = Config({ provider: 'dashscope' })
    expect(validated.provider).toBe('dashscope')
    expect(validated.dashscopeModel).toBe(DEFAULT_DASHSCOPE_MODEL)
    expect(validated.dashscopeEndpoint).toBe(DEFAULT_DASHSCOPE_ENDPOINT)
  })

  it('validates provider: comfyui and applies local defaults', () => {
    const validated = Config({ provider: 'comfyui' })
    expect(validated.provider).toBe('comfyui')
    expect(validated.comfyuiBaseURL).toBe(DEFAULT_COMFYUI_BASE_URL)
    expect(validated.comfyuiTimeoutMs).toBe(DEFAULT_COMFYUI_TIMEOUT_MS)
  })
})

