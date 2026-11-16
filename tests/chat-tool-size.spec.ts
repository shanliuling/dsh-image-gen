/**
 * Regression tests for the size-resolution guards in the chat tool path.
 *
 * 两个问题都是「把 aspect_ratio 接进 openAIRequestSize」时容易踩的坑，
 * 与比例本身无关，所以单独成文件：
 *
 * 1. 格式守卫必须先于比例解析。`openAIRequestSize` 在「该比例最低档位高于
 *    请求预算」时抛错，于是本不该带 size 的 SVG / GIF 请求在守卫前就失败了。
 * 2. 预算写死 `'1K'`。渠道把某比例只配了 2K 档时直接抛错；改传空档位，
 *    `openAIRequestSize` 会取该比例配置里最低的一档，才能正常解析。
 *
 * 直接调用生产代码 `chatToolSize`，不在测试里复刻逻辑——复刻版本改坏了源码
 * 也不会失败，起不到回归保护作用。
 */
import { describe, expect, it } from 'vitest'
import { chatToolSize } from '../src/studio.js'
import type { Config } from '../src/config.js'

/** 该比例只配了 2K 档：1K 预算会抛错，正好用来暴露求值顺序问题。 */
const twoKOnly = { openaiCompatSizes: { '3:4': { '2K': '1792x2304' } } } as Config
const noTable = { openaiCompatSizes: {} } as Config

function sizeOf(config: Config, args: { size?: string; aspect_ratio?: string }, opts: { gif?: boolean; svg?: boolean; provider?: 'openai-compat' | 'openai' } = {}) {
  return chatToolSize({
    provider: opts.provider ?? 'openai-compat',
    config,
    fallbackSize: '1024x1024',
    args,
    gifRequested: opts.gif === true,
    svgRequested: opts.svg === true,
  })
}

describe('chatToolSize: format guards precede the ratio lookup', () => {
  it('an SVG request resolves no size, so a 2K-only ratio cannot throw', () => {
    expect(() => sizeOf(twoKOnly, { aspect_ratio: '3:4' }, { svg: true })).not.toThrow()
    expect(sizeOf(twoKOnly, { aspect_ratio: '3:4' }, { svg: true })).toBeUndefined()
  })

  it('a GIF without an explicit size skips the lookup too', () => {
    expect(() => sizeOf(twoKOnly, { aspect_ratio: '3:4' }, { gif: true })).not.toThrow()
    expect(sizeOf(twoKOnly, { aspect_ratio: '3:4' }, { gif: true })).toBeUndefined()
  })

  it('a GIF with an explicit size still sends it', () => {
    expect(sizeOf(twoKOnly, { size: '512x512', aspect_ratio: '3:4' }, { gif: true })).toBe('512x512')
  })
})

describe('chatToolSize: a 2K-only ratio must not throw', () => {
  it('resolves to the configured tier', () => {
    expect(sizeOf(twoKOnly, { aspect_ratio: '3:4' })).toBe('1792x2304')
  })

  it('falls back to the orientation when no table is configured', () => {
    expect(sizeOf(noTable, { aspect_ratio: '3:4' })).toBe('1024x1536')
    expect(sizeOf(noTable, { aspect_ratio: '16:9' })).toBe('1536x1024')
    expect(sizeOf(noTable, { aspect_ratio: '1:1' })).toBe('1024x1024')
  })

  it('an explicit size wins without consulting the table', () => {
    expect(sizeOf(twoKOnly, { size: '1280x720', aspect_ratio: '3:4' })).toBe('1280x720')
  })

  it('falls back to the profile default without an aspect_ratio', () => {
    expect(sizeOf(noTable, {})).toBe('1024x1024')
  })

  it('other providers do not take part in ratio resolution', () => {
    expect(sizeOf(noTable, { aspect_ratio: '3:4' }, { provider: 'openai' })).toBe('1024x1024')
  })
})
