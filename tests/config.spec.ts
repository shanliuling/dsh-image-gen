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
  DEFAULT_XAI_BASE_URL,
  DEFAULT_XAI_MODEL,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_MODEL,
  migrateOpenAICompatConfig,
  resolveProvider,
  selectComfyUIWorkflow,
  withProviderOverrides,
} from '../src/config.js'
import { mergeComfyUIPrompt, resolveComfyUIWorkflows, uniqueComfyUIWorkflowName } from '../src/shared.js'

/** DSH 0.1.7 resolves `.volatile()` schema fields to boxes; unwrap for assertions. */
function unwrap<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key,
    field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function'
      ? (field as { get(): unknown }).get()
      : field,
  ])) as T
}

describe('resolveProvider', () => {
  it('resolves the Google defaults', () => {
    expect(resolveProvider({})).toEqual({ provider: 'google', apiKeyEnv: 'GEMINI_API_KEY', endpoint: DEFAULT_GOOGLE_ENDPOINT, model: DEFAULT_GOOGLE_MODEL, aspectRatio: '1:1', imageSize: '1K' })
  })

  it('resolves editable OpenAI-compatible profiles independently', () => {
    expect(resolveProvider({ provider: 'openai' })).toEqual({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', baseURL: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL, imageSize: '1024x1024' })
    expect(resolveProvider({ provider: 'seedream' })).toEqual({
      provider: 'seedream',
      apiKeyEnv: 'ARK_API_KEY',
      baseURL: DEFAULT_SEEDREAM_BASE_URL,
      model: DEFAULT_SEEDREAM_MODEL,
      imageSize: '2K',
      arkOptions: { outputFormat: 'jpeg', watermark: true, background: 'opaque' },
    })
  })

  it('carries the Seedream output controls through to the resolved profile', () => {
    expect(resolveProvider({
      provider: 'seedream',
      seedreamOutputFormat: 'png',
      seedreamWatermark: false,
      seedreamBackground: 'transparent',
    })).toMatchObject({
      provider: 'seedream',
      arkOptions: { outputFormat: 'png', watermark: false, background: 'transparent' },
    })
  })

  // Ark rejects `output_format: jpeg` together with `background: transparent` —
  // a JPEG cannot carry the alpha channel the transparent mode exists to produce.
  // The settings UI keeps the two controls independent, so the profile couples them.
  it('forces PNG output when the Seedream background is transparent', () => {
    expect(resolveProvider({
      provider: 'seedream',
      seedreamOutputFormat: 'jpeg',
      seedreamBackground: 'transparent',
    })).toMatchObject({
      arkOptions: { outputFormat: 'png', background: 'transparent' },
    })
    // An opaque background leaves the chosen format alone.
    expect(resolveProvider({
      provider: 'seedream',
      seedreamOutputFormat: 'jpeg',
      seedreamBackground: 'opaque',
    })).toMatchObject({
      arkOptions: { outputFormat: 'jpeg', background: 'opaque' },
    })
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

describe('openai-compat provider', () => {
  it('resolves the compat profile with its dedicated credential ref', () => {
    expect(resolveProvider({ provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example.com/v1', openaiCompatModel: 'flux-pro-1.1' })).toEqual({
      provider: 'openai-compat',
      apiKeyEnv: 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY',
      baseURL: 'https://relay.example.com/v1',
      model: 'flux-pro-1.1',
      imageSize: '1024x1024',
      editFormat: 'multipart',
      editExtra: {},
    })
  })

  it('carries the edit format and extra fields through to the profile (#41)', () => {
    expect(resolveProvider({
      provider: 'openai-compat',
      openaiCompatBaseURL: 'https://token.sensenova.cn/v1',
      openaiCompatModel: 'sensenova-u1.5-lite',
      openaiCompatEditFormat: 'jsonImageUrlArray',
      openaiCompatEditExtra: { watermark: false, prompt_extend: true },
    })).toMatchObject({
      provider: 'openai-compat',
      editFormat: 'jsonImageUrlArray',
      editExtra: { watermark: false, prompt_extend: true },
    })
  })

  it('fails loudly when the compat row is not fully configured', () => {
    expect(() => resolveProvider({ provider: 'openai-compat' })).toThrow('base URL')
    expect(() => resolveProvider({ provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example.com/v1' })).toThrow('model name')
  })

  it('routes per-call model overrides to the compat field', () => {
    const config = withProviderOverrides(
      { provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example.com/v1', openaiCompatModel: 'flux-pro-1.1' },
      undefined,
      'qwen-image',
    )
    expect(resolveProvider(config)).toMatchObject({ provider: 'openai-compat', model: 'qwen-image' })
  })
})

describe('xai and zhipu providers', () => {
  it('resolves the xai profile with its dedicated credential ref and defaults', () => {
    expect(resolveProvider({ provider: 'xai' })).toEqual({
      provider: 'xai',
      apiKeyEnv: 'XAI_API_KEY',
      baseURL: DEFAULT_XAI_BASE_URL,
      model: DEFAULT_XAI_MODEL,
      imageSize: '1024x1024',
    })
  })

  it('resolves the zhipu profile with its dedicated credential ref and defaults', () => {
    expect(resolveProvider({ provider: 'zhipu' })).toEqual({
      provider: 'zhipu',
      apiKeyEnv: 'ZHIPUAI_API_KEY',
      baseURL: DEFAULT_ZHIPU_BASE_URL,
      model: DEFAULT_ZHIPU_MODEL,
      imageSize: '1024x1024',
    })
  })

  it('honours configured endpoint and model overrides', () => {
    const config = withProviderOverrides(
      { provider: 'xai', xaiBaseURL: 'https://proxy.example.com/v1', xaiModel: 'grok-imagine-image-2.0' },
      undefined,
      'grok-imagine-image-2.0-alt',
    )
    expect(resolveProvider(config)).toMatchObject({ provider: 'xai', baseURL: 'https://proxy.example.com/v1', model: 'grok-imagine-image-2.0-alt' })
  })

  it('routes per-call model overrides to the zhipu field', () => {
    const config = withProviderOverrides({ provider: 'zhipu' }, undefined, 'glm-image-test')
    expect(resolveProvider(config)).toMatchObject({ provider: 'zhipu', model: 'glm-image-test' })
  })

  it('validates both providers through the schema with their defaults', () => {
    const xai = unwrap(Config({ provider: 'xai' }))
    expect(xai.xaiBaseURL).toBe(DEFAULT_XAI_BASE_URL)
    expect(xai.xaiModel).toBe(DEFAULT_XAI_MODEL)
    const zhipu = unwrap(Config({ provider: 'zhipu' }))
    expect(zhipu.zhipuBaseURL).toBe(DEFAULT_ZHIPU_BASE_URL)
    expect(zhipu.zhipuModel).toBe(DEFAULT_ZHIPU_MODEL)
  })
})

describe('openai-compat migration', () => {
  it('moves a legacy relay base URL into the compat row and re-points the default provider', () => {
    const migrated = migrateOpenAICompatConfig({
      provider: 'openai',
      openaiBaseURL: 'https://relay.example.com/v1',
      openaiModel: 'flux-pro-1.1',
    })
    expect(migrated).toMatchObject({
      provider: 'openai-compat',
      openaiBaseURL: DEFAULT_OPENAI_BASE_URL,
      openaiCompatBaseURL: 'https://relay.example.com/v1',
      openaiCompatModel: 'flux-pro-1.1',
    })
  })

  it('keeps the official row and other providers untouched', () => {
    const official = { provider: 'openai', openaiBaseURL: DEFAULT_OPENAI_BASE_URL, openaiModel: 'gpt-image-2' }
    expect(migrateOpenAICompatConfig(official)).toBe(official)
    const google = { provider: 'google' }
    expect(migrateOpenAICompatConfig(google)).toBe(google)
  })

  it('never overwrites an existing compat configuration', () => {
    const config = { provider: 'openai', openaiBaseURL: 'https://old-relay.example.com/v1', openaiCompatBaseURL: 'https://new-relay.example.com/v1', openaiCompatModel: 'qwen-image' }
    expect(migrateOpenAICompatConfig(config)).toBe(config)
  })

  it('migrates relay settings without hijacking a non-OpenAI default provider', () => {
    const migrated = migrateOpenAICompatConfig({ provider: 'google', openaiBaseURL: 'https://relay.example.com/v1', openaiModel: 'flux-pro-1.1' })
    expect(migrated).toMatchObject({
      provider: 'google',
      openaiCompatBaseURL: 'https://relay.example.com/v1',
      openaiCompatModel: 'flux-pro-1.1',
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
  it('exposes the opt-in composer pill as a live settings field', () => {
    expect(unwrap(Config({})).showProviderPill).toBe(false)
    const enabled = Config({ showProviderPill: true })
    expect(enabled.showProviderPill).toHaveProperty('get')
    expect(unwrap(enabled).showProviderPill).toBe(true)
  })

  it('validates provider: dashscope without rejection', () => {
    const validated = unwrap(Config({ provider: 'dashscope' }))
    expect(validated.provider).toBe('dashscope')
    expect(validated.dashscopeModel).toBe(DEFAULT_DASHSCOPE_MODEL)
    expect(validated.dashscopeEndpoint).toBe(DEFAULT_DASHSCOPE_ENDPOINT)
  })

  it('validates provider: comfyui and applies local defaults', () => {
    const validated = unwrap(Config({ provider: 'comfyui' }))
    expect(validated.provider).toBe('comfyui')
    expect(validated.comfyuiBaseURL).toBe(DEFAULT_COMFYUI_BASE_URL)
    expect(validated.comfyuiTimeoutMs).toBe(DEFAULT_COMFYUI_TIMEOUT_MS)
    expect(validated.comfyuiWorkflows).toEqual([])
    expect(validated.comfyuiActiveWorkflow).toBe('')
  })

  it('round-trips named workflows through the schema, defaulting blank presets', () => {
    const validated = unwrap(Config({
      provider: 'comfyui',
      comfyuiWorkflows: [{ name: 'a.json', json: '{}' }, { name: 'b.json', json: '{}', presetPrompt: 'masterpiece' }],
      comfyuiActiveWorkflow: 'a.json',
    }))
    expect(validated.comfyuiWorkflows).toEqual([
      { name: 'a.json', json: '{}', presetPrompt: '' },
      { name: 'b.json', json: '{}', presetPrompt: 'masterpiece' },
    ])
    expect(validated.comfyuiActiveWorkflow).toBe('a.json')
  })
})
