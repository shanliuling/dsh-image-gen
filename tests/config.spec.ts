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
  selectComfyUIWorkflow,
} from '../src/config.js'
import { mergeComfyUIPrompt, resolveComfyUIWorkflows, uniqueComfyUIWorkflowName } from '../src/shared.js'

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
      workflows: [],
      timeoutMs: DEFAULT_COMFYUI_TIMEOUT_MS,
    })
  })
})

describe('ComfyUI workflow resolution', () => {
  const workflows = [
    { name: 'flux.json', json: '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}}}' },
    { name: 'img2img.json', json: '{"1":{"class_type":"LoadImage","inputs":{"image":"{{image}}"}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}}}' },
  ]

  it('prefers named workflows and resolves the configured active one', () => {
    expect(resolveProvider({ provider: 'comfyui', comfyuiWorkflows: workflows, comfyuiActiveWorkflow: 'img2img.json' })).toMatchObject({
      provider: 'comfyui',
      workflows,
      workflow: workflows[1],
    })
  })

  it('falls back to the first workflow when the active name is missing', () => {
    expect(resolveProvider({ provider: 'comfyui', comfyuiWorkflows: workflows, comfyuiActiveWorkflow: 'missing.json' }))
      .toMatchObject({ workflow: workflows[0] })
  })

  it('falls back to the legacy single-workflow fields', () => {
    expect(resolveProvider({ provider: 'comfyui', comfyuiWorkflowJson: '{"6":{}}', comfyuiWorkflowName: 'legacy.json' })).toMatchObject({
      workflows: [{ name: 'legacy.json', json: '{"6":{}}' }],
      workflow: { name: 'legacy.json', json: '{"6":{}}' },
    })
    expect(resolveProvider({ provider: 'comfyui', comfyuiWorkflowJson: '{"6":{}}' })).toMatchObject({
      workflows: [{ name: DEFAULT_COMFYUI_WORKFLOW_LABEL, json: '{"6":{}}' }],
    })
  })

  it('ignores malformed workflow entries instead of failing the profile', () => {
    const malformed = [
      { name: '', json: 'x' },
      { name: 'ok.json', json: 'y' },
      { json: 'z' },
      'nope',
    ] as never
    expect(resolveProvider({ provider: 'comfyui', comfyuiWorkflows: malformed })).toMatchObject({
      workflows: [{ name: 'ok.json', json: 'y' }],
    })
  })

  it('derives collision-free workflow labels for imports', () => {
    expect(uniqueComfyUIWorkflowName('flux.json', ['other.json'])).toBe('flux.json')
    expect(uniqueComfyUIWorkflowName('flux.json', ['flux.json'])).toBe('flux.json (2)')
    expect(uniqueComfyUIWorkflowName('flux.json', ['flux.json', 'flux.json (2)'])).toBe('flux.json (3)')
    expect(uniqueComfyUIWorkflowName('  ', [])).toBe(DEFAULT_COMFYUI_WORKFLOW_LABEL)
  })
})

describe('mergeComfyUIPrompt', () => {
  it('prepends the preset before the user prompt with one separator', () => {
    expect(mergeComfyUIPrompt('masterpiece, best quality', 'a cat')).toBe('masterpiece, best quality, a cat')
  })

  it('never doubles separators when the preset ends with commas or whitespace', () => {
    expect(mergeComfyUIPrompt('masterpiece, ', 'a cat')).toBe('masterpiece, a cat')
    expect(mergeComfyUIPrompt('masterpiece,', 'a cat')).toBe('masterpiece, a cat')
    expect(mergeComfyUIPrompt('masterpiece ;', 'a cat')).toBe('masterpiece, a cat')
  })

  it('reduces to the non-empty side', () => {
    expect(mergeComfyUIPrompt('', 'a cat')).toBe('a cat')
    expect(mergeComfyUIPrompt(undefined, 'a cat')).toBe('a cat')
    expect(mergeComfyUIPrompt('masterpiece', '')).toBe('masterpiece')
    expect(mergeComfyUIPrompt('  ', '  ')).toBe('')
  })
})

describe('resolveComfyUIWorkflows preset handling', () => {
  it('keeps trimmed presets on named entries and omits blank ones', () => {
    expect(resolveComfyUIWorkflows({ comfyuiWorkflows: [
      { name: 'a.json', json: 'x', presetPrompt: ' masterpiece, ' },
      { name: 'b.json', json: 'y', presetPrompt: '   ' },
    ] })).toEqual([
      { name: 'a.json', json: 'x', presetPrompt: 'masterpiece,' },
      { name: 'b.json', json: 'y' },
    ])
  })
})

describe('selectComfyUIWorkflow', () => {
  const workflows = [
    { name: 'gen.json', json: '{"gen":{}}' },
    { name: 'alt.json', json: '{"alt":{}}' },
  ]

  it('returns the active workflow when no name is requested', () => {
    expect(selectComfyUIWorkflow({ workflows, workflow: workflows[1] })).toBe(workflows[1])
    expect(selectComfyUIWorkflow({ workflows, workflow: workflows[1] }, '  ')).toBe(workflows[1])
  })

  it('resolves a requested workflow by exact name', () => {
    expect(selectComfyUIWorkflow({ workflows, workflow: workflows[0] }, 'alt.json')).toBe(workflows[1])
  })

  it('lists available workflows when the requested name is unknown', () => {
    expect(() => selectComfyUIWorkflow({ workflows, workflow: workflows[0] }, 'nope.json'))
      .toThrow('No ComfyUI workflow named "nope.json" is configured. Available workflows: gen.json, alt.json.')
  })

  it('explains the missing workflow before any ComfyUI request runs', () => {
    expect(() => selectComfyUIWorkflow({ workflows: [], workflow: undefined }))
      .toThrow('requires an imported workflow')
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
    expect(validated.comfyuiWorkflows).toEqual([])
    expect(validated.comfyuiActiveWorkflow).toBe('')
  })

  it('round-trips named workflows through the schema, defaulting blank presets', () => {
    const validated = Config({
      provider: 'comfyui',
      comfyuiWorkflows: [{ name: 'a.json', json: '{}' }, { name: 'b.json', json: '{}', presetPrompt: 'masterpiece' }],
      comfyuiActiveWorkflow: 'a.json',
    })
    expect(validated.comfyuiWorkflows).toEqual([
      { name: 'a.json', json: '{}', presetPrompt: '' },
      { name: 'b.json', json: '{}', presetPrompt: 'masterpiece' },
    ])
    expect(validated.comfyuiActiveWorkflow).toBe('a.json')
  })
})

