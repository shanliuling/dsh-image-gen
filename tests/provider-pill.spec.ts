import { describe, expect, it } from 'vitest'
import { DEFAULT_MODELS } from '../src/shared.js'
import { pillModelOf, pillModelOptionsOf, pillVisible } from '../src/client/provider-pill.js'

describe('composer provider pill visibility (opt-in)', () => {
  it('stays hidden by default and only appears when explicitly enabled', () => {
    expect(pillVisible(undefined)).toBe(false)
    expect(pillVisible({})).toBe(false)
    expect(pillVisible({ showProviderPill: false })).toBe(false)
    expect(pillVisible({ showProviderPill: true })).toBe(true)
  })
})

describe('composer provider pill model choices', () => {
  it('keeps providers without a model list on the single-row provider flow', () => {
    expect(pillModelOptionsOf('google', { googleModel: 'gemini-3.1-flash-image' })).toEqual([])
    expect(pillModelOptionsOf('openai', { openaiModel: 'gpt-image-2' })).toEqual([])
    expect(pillModelOptionsOf('dashscope', { dashscopeModel: 'qwen-image-3.0' })).toEqual([])
  })

  it('normalizes configured model choices without moving an existing default', () => {
    expect(pillModelOptionsOf('openai-compat', {
      openaiCompatModel: 'gpt-image-1.5',
      openaiCompatModels: ['gpt-image-2', ' gpt-image-1.5 ', 'gpt-image-2', ''],
    })).toEqual(['gpt-image-2', 'gpt-image-1.5'])
  })

  it('keeps a legacy default selectable when the saved list omits it', () => {
    expect(pillModelOptionsOf('openai-compat', {
      openaiCompatModel: 'gpt-image-1.5',
      openaiCompatModels: ['gpt-image-2'],
    })).toEqual(['gpt-image-1.5', 'gpt-image-2'])
  })
})

describe('composer provider pill model resolution', () => {
  it('falls back to each provider default when no model is stored', () => {
    expect(pillModelOf('google', undefined)).toBe(DEFAULT_MODELS.google)
    expect(pillModelOf('openai', {})).toBe(DEFAULT_MODELS.openai)
    expect(pillModelOf('seedream', { seedreamModel: '' })).toBe(DEFAULT_MODELS.seedream)
    expect(pillModelOf('dashscope', { dashscopeModel: '' })).toBe(DEFAULT_MODELS.dashscope)
  })

  it('reads the stored model of each cloud provider', () => {
    expect(pillModelOf('google', { googleModel: 'gemini-2.5-flash-image' })).toBe('gemini-2.5-flash-image')
    expect(pillModelOf('openai', { openaiModel: 'gpt-image-1' })).toBe('gpt-image-1')
    expect(pillModelOf('openai-compat', { openaiCompatModel: 'flux-pro-1.1' })).toBe('flux-pro-1.1')
    expect(pillModelOf('seedream', { seedreamModel: 'doubao-seedream-4-0' })).toBe('doubao-seedream-4-0')
    expect(pillModelOf('dashscope', { dashscopeModel: 'wan2.5-t2i' })).toBe('wan2.5-t2i')
  })

  it('shows no model for an unconfigured compat relay instead of inventing one', () => {
    expect(pillModelOf('openai-compat', {})).toBe('')
    expect(pillModelOf('openai-compat', { openaiCompatModel: '' })).toBe('')
  })

  it('shows the active ComfyUI workflow name, or empty before any import', () => {
    expect(pillModelOf('comfyui', {})).toBe('')
    expect(pillModelOf('comfyui', {
      comfyuiWorkflows: [
        { name: 'flux-dev', json: '{}' },
        { name: 'sd-xl', json: '{}' },
      ],
      comfyuiActiveWorkflow: 'sd-xl',
    })).toBe('sd-xl')
    // Active name missing from the list falls back to the first entry.
    expect(pillModelOf('comfyui', {
      comfyuiWorkflows: [{ name: 'flux-dev', json: '{}' }],
      comfyuiActiveWorkflow: 'gone',
    })).toBe('flux-dev')
    // Legacy single-workflow storage still resolves.
    expect(pillModelOf('comfyui', {
      comfyuiWorkflowJson: '{}',
      comfyuiWorkflowName: 'legacy flow',
    })).toBe('legacy flow')
  })
})
