import { describe, expect, it } from 'vitest'
import { ratioLabel } from '../src/ratio-labels.js'
import { localizeRatioOptions, localizeResolutionOptions, studioProfileLabel } from '../src/client/studio-helpers.js'
import { localizeChannelLabel } from '../src/shared.js'
import { CLOUD_CAPABILITIES } from '../src/capabilities.js'

describe('Studio ratio labels', () => {
  it.each([
    ['2:1', 'Panorama'], ['1:2', 'Portrait'], ['3:1', 'Panorama'], ['1:3', 'Tall'],
    ['9:21', 'Tall'], ['7:5', 'Landscape'], ['5:7', 'Portrait'], ['5:2', 'Ultrawide'],
    ['9:19.5', 'Portrait'], ['19.5:9', 'Widescreen'], ['9:20', 'Portrait'], ['20:9', 'Widescreen'],
    ['4:1', 'Panorama'], ['1:4', 'Tall'], ['8:1', 'Panorama'], ['1:8', 'Tall'], ['2.35:1', 'Ultrawide'],
  ])('localizes relay ratio %s in English', (value, name) => {
    expect(localizeRatioOptions([{ value, label: '中文标签' }], 'en')).toEqual([
      { value, label: `${value} ${name}` },
    ])
  })

  it('labels widescreen and portrait ratios in Chinese on server and client', () => {
    const options = CLOUD_CAPABILITIES.google.ratioOptions.filter(option => ['16:9', '9:16'].includes(option.value))
    expect(options).toEqual([
      { value: '16:9', label: '16:9 宽屏' },
      { value: '9:16', label: '9:16 竖屏' },
    ])
    expect(localizeRatioOptions(options, 'zh')).toEqual(options)
  })

  it.each(['en', 'zh'] as const)('uses only the raw value for unknown ratios in %s', lang => {
    const options = [{ value: '13:6', label: '中文标签' }, { value: '6:13', label: 'English label' }]
    expect(localizeRatioOptions(options, lang)).toEqual(options.map(({ value }) => ({ value, label: value })))
    expect(ratioLabel('13:6', lang)).toBe('13:6')
    expect(ratioLabel('constructor', lang)).toBe('constructor')
  })

  it('does not preserve Chinese server labels in English', () => {
    const options = Object.values(CLOUD_CAPABILITIES).flatMap(profile => profile.ratioOptions)
    expect(localizeRatioOptions(options, 'en').every(option => !/\p{Script=Han}/u.test(option.label))).toBe(true)
  })

  it('keeps an empty option list empty', () => {
    expect(localizeRatioOptions([], 'en')).toEqual([])
    expect(localizeRatioOptions([], 'zh')).toEqual([])
  })
})

describe('localizeResolutionOptions', () => {
  const options = [{ value: 'standard', label: '标准 · 1536x1024' }]

  it('shows the standard tier in the UI language', () => {
    expect(localizeResolutionOptions(options, 'en')).toEqual([{ value: 'standard', label: 'Standard · 1536x1024' }])
    expect(localizeResolutionOptions(options, 'zh')).toEqual(options)
  })

  it('keeps size-table tiers and localizes the bare standard quality', () => {
    expect(localizeResolutionOptions([{ value: '2K', label: '2K · 2048x2048' }, { value: 'standard', label: '标准（推荐）' }], 'en')).toEqual([
      { value: '2K', label: '2K · 2048x2048' },
      { value: 'standard', label: 'Standard (Recommended)' },
    ])
  })
})

describe('studioProfileLabel', () => {
  it('shows host provider labels in English', () => {
    expect(studioProfileLabel({ provider: 'zhipu', label: '智谱 GLM' }, 'en')).toBe('Zhipu GLM')
    expect(studioProfileLabel({ provider: 'chatgpt-sub', label: 'ChatGPT 订阅' }, 'en')).toBe('ChatGPT Subscription')
    expect(studioProfileLabel({ provider: 'zhipu', label: '智谱 GLM' }, 'zh')).toBe('智谱 GLM')
  })

  it('localizes default channel names and keeps names the user typed', () => {
    expect(studioProfileLabel({ provider: 'openai-compat', channel: 'default', label: 'OpenAI 兼容' }, 'en')).toBe('OpenAI Compatible')
    expect(studioProfileLabel({ provider: 'openai-compat', channel: 'b', label: 'OpenAI 兼容 2' }, 'en')).toBe('OpenAI Compatible 2')
    expect(studioProfileLabel({ provider: 'openai-compat', channel: 'b', label: '我的中转' }, 'en')).toBe('我的中转')
    expect(localizeChannelLabel('OpenAI 兼容 2', 'zh')).toBe('OpenAI 兼容 2')
  })
})
