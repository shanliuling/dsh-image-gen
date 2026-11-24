import { describe, expect, it } from 'vitest'
import { subscriptionToolParameters } from '../src/subscription.js'

describe('subscription image tool parameters', () => {
  it.each(['', '   '])('treats empty placeholders %j as omitted before validating', empty => {
    expect(subscriptionToolParameters('chatgpt-sub', { size: empty, aspectRatio: '1:1', imageSize: empty })).toEqual({ size: '1024x1024' })
    expect(subscriptionToolParameters('grok-sub', { size: '16:9', aspectRatio: empty, imageSize: empty })).toEqual({ size: '16:9' })
    expect(subscriptionToolParameters('google-sub', { size: empty, aspectRatio: empty, imageSize: empty })).toEqual({})
  })

  it('trims valid strings and ignores a filled-in image_size ChatGPT has no tier for (#160)', () => {
    expect(subscriptionToolParameters('grok-sub', { aspectRatio: ' 16:9 ', imageSize: ' 2K ' })).toEqual({ size: '16:9', quality: '2k' })
    expect(subscriptionToolParameters('chatgpt-sub', { size: '', aspectRatio: '1:1', imageSize: '1K' })).toEqual({ size: '1024x1024' })
  })

  it('accepts a size and aspect_ratio that describe the same frame (#160)', () => {
    expect(subscriptionToolParameters('chatgpt-sub', { size: '1024x1024', aspectRatio: '1:1', imageSize: '1K' })).toEqual({ size: '1024x1024' })
    expect(subscriptionToolParameters('grok-sub', { size: '16:9', aspectRatio: '16:9' })).toEqual({ size: '16:9' })
    // Google maps only a few pixel sizes, so a matching pair travels as its ratio.
    expect(subscriptionToolParameters('google-sub', { size: '1920x1080', aspectRatio: '16:9' })).toEqual({ size: '16:9' })
  })

  it('rejects an overlong pixel size without hanging', () => {
    expect(() => subscriptionToolParameters('chatgpt-sub', { size: `${'9'.repeat(400)}x1`, aspectRatio: '1:1' })).toThrow('只选一个')
  })

  it('maps selected ratios and tiers to each subscription wire protocol', () => {
    expect(subscriptionToolParameters('chatgpt-sub', { aspectRatio: '9:16' })).toEqual({ size: '864x1536' })
    expect(subscriptionToolParameters('grok-sub', { aspectRatio: '9:16', imageSize: '2K' })).toEqual({ size: '9:16', quality: '2k' })
    expect(subscriptionToolParameters('google-sub', { aspectRatio: '16:9', imageSize: '4K' })).toEqual({ size: '16:9', quality: 'hd' })
  })

  it('rejects conflicting or unsupported selections instead of silently dropping them', () => {
    expect(() => subscriptionToolParameters('grok-sub', { size: '1024x1024', aspectRatio: '9:16' })).toThrow('只选一个')
    expect(() => subscriptionToolParameters('grok-sub', { imageSize: '4K' })).toThrow('不支持清晰度')
    expect(() => subscriptionToolParameters('google-sub', { imageSize: '2K' })).toThrow('不支持清晰度')
  })
})
