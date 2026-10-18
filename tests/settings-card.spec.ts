import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { ImageGenerationSettingsCard } from '../src/client/index.js'

// Exercise the actual rendered form handlers without a DOM dependency. Effects
// (host subscriptions and status polling) are outside this form-action harness.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, scopeEffects: [] as Array<() => unknown> }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect(setup: () => unknown, dependencies?: unknown[]) {
      const dependency = dependencies?.[0] as { getSnapshot?: unknown; set?: unknown; subscribe?: unknown } | undefined
      if (typeof dependency?.getSnapshot === 'function' && typeof dependency.set === 'function'
        && typeof dependency.subscribe === 'function') hooks.scopeEffects.push(setup)
    },
    useState(initial: unknown) {
      const index = hooks.cursor++
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
      return [hooks.values[index], (next: unknown) => {
        hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next
      }]
    },
  }
})

type Element = ReactElement<Record<string, any>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node === null || typeof node === 'boolean' || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  return 'props' in node ? text((node as Element).props.children) : ''
}

function formHarness(lang = 'zh', initialValue: Record<string, unknown> = { openaiCompatBaseURL: 'https://relay.example/v1' }, provider = 'openai-compat', state: { writable?: boolean; status?: 'loading' | 'ready' | 'unavailable'; mode?: 'host' | 'memory' } = {}) {
  let stored = { ...initialValue }
  const setKey = vi.fn(async () => ({ ok: true }))
  const setSetting = vi.fn(async (field: string, value: unknown): Promise<boolean | void> => {
    stored = { ...stored, [field]: value }
  })
  const props = {
    scope: {
      getSnapshot: () => ({ writable: true, value: stored, ...state }),
      subscribe: vi.fn(), set: setSetting,
    },
    credentials: { describe: vi.fn(), set: setKey },
    credentialsAvailable: () => true,
    locale: { getSnapshot: () => ({ active: lang }) },
  } as unknown as Parameters<typeof ImageGenerationSettingsCard>[0]
  const render = () => {
    hooks.cursor = 0
    return ImageGenerationSettingsCard(props)
  }
  const row = () => elements(render()).find(element => element.key === provider
    && element.props.className?.startsWith('dsh-ig-provider-row'))!
  const find = (predicate: (element: Element) => boolean) => elements(row()).find(predicate)!
  // The card renders open on the plugin's own page now, so only the provider
  // row still needs a click to expand.
  find(element => element.props.className === 'dsh-ig-provider-head').props.onClick()
  return {
    setKey, setSetting,
    expand: () => find(element => element.props.className === 'dsh-ig-provider-head').props.onClick(),
    cardText: () => text(render()),
    syncScope: () => { for (const setup of hooks.scopeEffects.splice(0)) setup() },
    rowText: () => text(row()),
    typeURL: (value: string) => find(element => element.props.type === 'url').props.onChange({ target: { value } }),
    typeKey: (value: string) => find(element => element.props.type === 'password').props.onChange({ target: { value } }),
    keyValue: () => find(element => element.props.type === 'password').props.value,
    field: (label: string, value: string) => {
      const field = find(element => element.type === 'label' && text(element).startsWith(label))
      elements(field).find(element => ['input', 'textarea', 'select'].includes(String(element.type)))!.props.onChange({ target: { value } })
    },
    disabled: (label: string) => find(element => element.type === 'button' && text(element) === label).props.disabled,
    click: (label: string) => find(element => element.type === 'button' && text(element) === label).props.onClick(),
    save: () => find(element => element.type === 'form').props.onSubmit({ preventDefault() {} }),
  }
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.scopeEffects = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('settings card credential actions', () => {
  it.each(['拉取模型', '测试连接'])('requires saving a changed Google protocol before %s', action => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('zh', {}, 'google')
    form.field('请求协议', 'native')
    form.click(action)
    expect(form.rowText()).toContain('请求协议尚未保存')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['zh', 'en'])('saves and reopens the Google native protocol setting in %s', async lang => {
    const form = formHarness(lang, {}, 'google')
    form.field(lang === 'zh' ? '请求协议' : 'Request protocol', 'native')
    form.typeURL('https://relay.example/v1beta')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('googleNative', true))
    expect(form.setSetting).toHaveBeenCalledWith('googleEndpoint', 'https://relay.example/v1beta')
    hooks.values = []
    form.expand()
    expect(form.rowText()).toContain('https://example.com/v1beta')
    form.field(lang === 'zh' ? '请求协议' : 'Request protocol', 'interactions')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('googleNative', false))
  })

  it.each([
    { openaiCompatBaseURL: 'https://token.sensenova.cn/v1', openaiCompatModel: 'sensenova-u1.5-lite' },
    { openaiCompatBaseURL: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', openaiCompatModel: 'qwen-image-3.0' },
  ])('exposes JSON edit fields for a recognized official endpoint without a manual format switch', async config => {
    const form = formHarness('zh', config)
    expect(form.rowText()).toContain('自动：官方接口 JSON 格式')
    form.field('附加 JSON 字段', '{"watermark":false,"prompt_extend":false}')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('openaiCompatEditExtra', { watermark: false, prompt_extend: false }))
  })
  it('saves independent resolution, quality and generation JSON fields', async () => {
    const form = formHarness()
    form.field('自定义分辨率表', '{"16:9":{"2K":"2048x1152"}}')
    form.field('默认生成质量', ' high ')
    form.field('可选生成质量', 'low, high, high')
    form.field('文生图附加字段', '{"watermark":false,"prompt_extend":false}')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('openaiCompatExtraBody', { watermark: false, prompt_extend: false }))
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatSizes', { '16:9': { '2K': '2048x1152' } })
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatQuality', 'high')
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatQualityOptions', ['low', 'high'])
  })
  it.each(['[]', '{broken'])('rejects invalid generation JSON %s before any settings or key write', async invalid => {
    const form = formHarness()
    form.typeKey('test-draft')
    form.field('文生图附加字段', invalid)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('合法的 JSON 对象'))
    expect(form.setSetting).not.toHaveBeenCalled()
    expect(form.setKey).not.toHaveBeenCalled()
  })
  it('rejects unsupported official sizes before saving any field', async () => {
    const form = formHarness('zh', { openaiModel: 'gpt-image-2' }, 'openai')
    form.field('自定义分辨率表', '{"1:1":{"4K":"4096x4096"}}')
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('尺寸'))
    expect(form.setSetting).not.toHaveBeenCalled()
  })
  it.each(['拉取模型', '测试连接'])('asks to save before %s without sending a request or storing the draft', async action => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async (): Promise<Record<string, unknown>> => ({ ok: false, reason: 'missing-key' }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.typeKey('  sk-draft  ')
    form.click(action)
    await vi.waitFor(() => expect(form.rowText()).toContain('请先保存 API Key'))
    expect(fetch).not.toHaveBeenCalled()
    expect(form.setKey).not.toHaveBeenCalled()
    expect(form.keyValue()).toBe('  sk-draft  ')
  })

  it('also blocks probing a replacement key when a previous key was saved', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('en')
    form.typeKey('sk-old')
    form.save()
    await vi.waitFor(() => expect(form.keyValue()).toBe(''))
    form.typeKey('sk-replacement')
    form.click('Test connection')
    expect(form.rowText()).toContain('Save the API key first')
    expect(fetch).not.toHaveBeenCalled()
    expect(form.setKey).toHaveBeenCalledTimes(1)
  })

  it('clears old model and connection errors after saving, then allows model fetching', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async (): Promise<Record<string, unknown>> => ({ ok: false, reason: 'missing-key' }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.click('拉取模型')
    await vi.waitFor(() => expect(form.rowText()).toContain('Key 未配置'))
    form.click('测试连接')
    await vi.waitFor(() => expect(form.rowText().match(/Key 未配置/g)).toHaveLength(2))
    form.typeKey('  sk-saved  ')
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('已保存'))
    expect(form.setKey).toHaveBeenCalledWith('DSH_IMAGE_GEN_OPENAI_COMPAT_KEY', 'sk-saved')
    expect(form.keyValue()).toBe('')
    expect(form.rowText()).not.toContain('Key 未配置')
    fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, models: ['gpt-image-1'] }) })
    form.click('拉取模型')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(JSON.parse(fetch.mock.calls[2]![1].body as string)).toEqual({ provider: 'openai-compat', action: 'models' })
  })

  it.each(['拉取模型', '测试连接'])('disables saving until the outstanding %s request finishes', async action => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const form = formHarness()
    form.click(action)
    expect(form.disabled('保存')).toBe(true)
    finish(new Response(JSON.stringify({ ok: false, reason: 'missing-key' })))
    await vi.waitFor(() => expect(form.disabled('保存')).toBe(false))
  })

  it('disables model fetching and probing while the key is being saved', async () => {
    const form = formHarness()
    let finish!: () => void
    form.setSetting.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    form.typeKey('sk-draft')
    form.save()
    expect(form.disabled('拉取模型')).toBe(true)
    expect(form.disabled('测试连接')).toBe(true)
    finish()
    await vi.waitFor(() => expect(form.disabled('测试连接')).toBe(false))
    expect(form.disabled('拉取模型')).toBe(false)
  })

  it('preserves the draft and earlier model error when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, reason: 'missing-key' }) })))
    const form = formHarness()
    form.click('拉取模型')
    await vi.waitFor(() => expect(form.rowText()).toContain('Key 未配置'))
    form.typeKey('sk-draft')
    form.setSetting.mockRejectedValueOnce(new Error('Settings unavailable'))
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('Settings unavailable'))
    expect(form.rowText()).toContain('Key 未配置')
    expect(form.keyValue()).toBe('sk-draft')
    expect(form.setKey).not.toHaveBeenCalled()
  })
})

describe('settings card host state', () => {
  it('reads a form that became ready between render and subscription instead of staying disabled', () => {
    const state = { writable: true, status: 'loading' as 'loading' | 'ready', mode: 'host' as const }
    const form = formHarness('en', {}, 'openai-compat', state)
    expect(form.disabled('Save')).toBe(true)
    state.status = 'ready'
    form.syncScope()
    expect(form.disabled('Save')).toBe(false)
    expect(form.cardText()).not.toContain('Settings are loading')
  })
  it('explains remote memory mode instead of telling users to edit a profile file', () => {
    const form = formHarness('zh', {}, 'openai-compat', { writable: false, status: 'unavailable', mode: 'memory' })
    expect(form.cardText()).toContain('当前连接不支持保存到宿主')
    expect(form.cardText()).not.toContain('设置由配置文件提供')
    expect(form.disabled('保存')).toBe(true)
  })

  it('blocks writes while the real host form is loading even when writable is true', async () => {
    const form = formHarness('en', {}, 'openai-compat', { writable: true, status: 'loading', mode: 'host' })
    expect(form.cardText()).toContain('Settings are loading')
    expect(form.disabled('Save')).toBe(true)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('Settings are loading'))
    expect(form.setSetting).not.toHaveBeenCalled()
    expect(form.setKey).not.toHaveBeenCalled()
  })

  it('explains an unavailable namespace and refuses writes without claiming success', async () => {
    const form = formHarness('zh', {}, 'openai-compat', { writable: true, status: 'unavailable', mode: 'host' })
    expect(form.cardText()).toContain('宿主尚未提供图像生成设置')
    expect(form.disabled('保存')).toBe(true)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('宿主尚未提供图像生成设置'))
    expect(form.setSetting).not.toHaveBeenCalled()
  })

  it('keeps an actual read-only document distinct from unavailable services', () => {
    const form = formHarness('zh', {}, 'openai-compat', { writable: false, status: 'ready', mode: 'host' })
    expect(form.cardText()).toContain('设置由配置文件提供')
    expect(form.cardText()).not.toContain('宿主尚未提供图像生成设置')
    expect(form.disabled('保存')).toBe(true)
  })
})

describe('settings card endpoint actions', () => {
  it.each(['拉取模型', '测试连接'])('asks to save a newly entered relay address before %s', async action => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, reason: 'error', message: 'Base URL is not configured' }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('zh', {})
    form.typeURL('https://relay.example/v1')
    form.click(action)
    expect(form.rowText()).toContain('接口地址尚未保存，请先点击保存')
    expect(fetch).not.toHaveBeenCalled()
    expect(form.setSetting).not.toHaveBeenCalled()
  })

  it.each(['拉取模型', '测试连接'])('asks for an empty relay address before %s', action => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('zh', {})
    form.click(action)
    expect(form.rowText()).toContain('请填写接口地址并保存')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['拉取模型', '测试连接'])('allows %s after the edited address is saved', async action => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, models: ['gpt-image-1'] }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.typeURL('https://replacement.example/v1')
    form.click(action)
    expect(fetch).not.toHaveBeenCalled()
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('已保存'))
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatBaseURL', 'https://replacement.example/v1')
    form.click(action)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })

  it('keeps blocking requests when the address write is refused', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.typeURL('https://replacement.example/v1')
    form.setSetting.mockImplementationOnce(async () => {}).mockResolvedValueOnce(false)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('设置未能保存'))
    form.click('拉取模型')
    expect(form.rowText()).toContain('接口地址尚未保存，请先点击保存')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['拉取模型', '测试连接'])('localizes a missing saved address returned by the host during %s', async action => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, reason: 'error', message: 'Base URL is not configured' }) })))
    const form = formHarness()
    form.click(action)
    await vi.waitFor(() => expect(form.rowText()).toContain('未读取到已保存的接口地址，请保存后重试'))
    expect(form.rowText()).not.toContain('Base URL is not configured')
  })

  it('checks edited official addresses too, while allowing unchanged defaults', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('en', {}, 'openai')
    form.typeURL('https://relay.example/v1')
    form.click('Test connection')
    expect(form.rowText()).toContain('The endpoint address has not been saved')
    expect(fetch).not.toHaveBeenCalled()
    form.typeURL('  https://api.openai.com/v1  ')
    form.click('Test connection')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })
})
