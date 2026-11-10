import { describe, expect, it } from 'vitest'
import { compatQualityOptions, compatRequestQuality, compatWatermarkField, gifRequestFields, officialQualityOptions, officialSizeTable, outputRequestFields, PROVIDER_DEFAULT_QUALITY, validateGifFrameSize, validateOfficialSize } from '../src/openai-output.js'
import { parseExtraFields, parseSizeTable } from '../src/client/output-settings.js'
import { buildComparisonTargets, comparisonOutputOptions } from '../src/client/multi-model-compare.js'
import { studioProfile } from '../src/studio.js'
import { conversationRegenerateRequest } from '../src/client/conversation-regenerate.js'

describe('independent OpenAI output parameters', () => {
  it.each(['2048x2048', '2048x1152', '3840x2160', '2160x3840'])('accepts the official flexible size %s', size => {
    expect(() => validateOfficialSize('gpt-image-2', size)).not.toThrow()
  })
  it.each(['4096x4096', '2049x1152', '3840x3840', '512x512', '3840x1024', 'bad'])('rejects the unsupported official size %s', size => {
    expect(() => validateOfficialSize('gpt-image-2', size)).toThrow('尺寸')
  })
  it('keeps old official models within their size and quality contract', () => {
    expect(() => validateOfficialSize('gpt-image-1.5', '2048x2048')).toThrow('不支持')
    expect(Object.keys(officialSizeTable({}, 'gpt-image-1.5'))).toEqual(['1:1', '3:2', '2:3'])
    expect(officialQualityOptions('gpt-image-2').map(option => option.value)).not.toContain('max')
    expect(officialQualityOptions('gpt-image-2.5-flare').map(option => option.value)).toContain('max')
  })
  it('distinguishes explicit omission, a configured default and a per-call override', () => {
    expect(compatRequestQuality({})).toBeUndefined()
    expect(compatRequestQuality({ openaiCompatQuality: 'high' })).toBe('high')
    expect(compatRequestQuality({ openaiCompatQuality: 'high' }, 'low')).toBe('low')
    expect(compatRequestQuality({ openaiCompatQuality: 'high' }, PROVIDER_DEFAULT_QUALITY)).toBeUndefined()
    expect(compatQualityOptions({ openaiCompatQualityOptions: ['draft', 'best'], openaiCompatQuality: 'custom' }).map(option => option.value)).toEqual([PROVIDER_DEFAULT_QUALITY, 'draft', 'best', 'custom'])
  })
  it('maps a shared resolution and quality to separate provider dimensions', () => {
    const profiles = [studioProfile({}, 'openai', true), studioProfile({ openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay', openaiCompatSizes: { '16:9': { '2K': '2048x1152' } } }, 'openai-compat', true), studioProfile({}, 'google', true)]
    const targets = buildComparisonTargets(profiles, ['openai', 'openai-compat', 'google'], '16:9', 'high', { resolution: '2K', generationQuality: 'high' })
    expect(targets.map(({ profile, quality, resolution, generationQuality }) => ({ provider: profile.provider, quality, resolution, generationQuality }))).toEqual([
      { provider: 'openai', quality: 'high', resolution: '2K', generationQuality: undefined },
      { provider: 'openai-compat', quality: '2K', resolution: '2K', generationQuality: 'high' },
      { provider: 'google', quality: '2K', resolution: undefined, generationQuality: undefined },
    ])
    expect(comparisonOutputOptions(profiles, '16:9', 'resolution').map(option => option.value)).not.toContain('high')
    expect(comparisonOutputOptions(profiles, '16:9', 'generationQuality').map(option => option.value)).not.toContain('2K')
  })
  it('does not carry an unavailable pixel tier to another ratio', () => {
    const profile = studioProfile({}, 'openai', true)
    const [target] = buildComparisonTargets([profile], ['openai'], '1:1', 'high', { resolution: '4K', generationQuality: 'high' })
    expect(target).toMatchObject({ resolution: '1K', quality: 'high', adjusted: true })
  })
  it('preserves the chosen dimensions and quality when regenerating saved images', () => {
    expect(conversationRegenerateRequest({ provider: 'openai-compat', model: 'relay' }, 'again', { ratio: '16:9', quality: '2K', generationQuality: 'high', watermark: 'off' })).toMatchObject({ quality: '2K', generationQuality: 'high', watermark: 'off' })
    expect(conversationRegenerateRequest({ provider: 'openai', model: 'gpt-image-2', output: '3840x2160, quality=high' }, 'again')).toMatchObject({ ratio: '16:9', resolution: '4K', quality: 'high' })
  })
  it('validates advanced JSON without losing false or nested provider fields', () => {
    expect(parseExtraFields('{"watermark":false,"vendor":{"strength":0}}', 'invalid')).toEqual({ watermark: false, vendor: { strength: 0 } })
    expect(parseSizeTable('{"16:9":{"2K":"2048x1152"}}', 'invalid')).toEqual({ '16:9': { '2K': '2048x1152' } })
    for (const text of ['[]', '{bad', '{"16:9":{"bad":"2048x1152"}}', '{"16:9":{"2K":false}}']) expect(() => parseSizeTable(text, 'invalid')).toThrow('invalid')
  })
})

describe('compatible watermark contracts', () => {
  it('recognizes the exact official SenseNova endpoint without guessing from a model name', () => {
    const config = { openaiCompatBaseURL: 'https://token.sensenova.cn/v1/', openaiCompatModel: 'sensenova-u1.5-lite' }
    expect(compatWatermarkField(config)).toBe('watermark')
    for (const address of ['https://relay.example/v1', 'https://token.sensenova.cn.evil.example/v1', 'https://token.sensenova.cn:8443/v1', 'https://token.sensenova.cn/other', 'http://token.sensenova.cn/v1']) {
      expect(compatWatermarkField({ ...config, openaiCompatBaseURL: address })).toBeUndefined()
    }
    expect(compatWatermarkField({ ...config, openaiCompatModel: 'other' })).toBeUndefined()
    expect(compatWatermarkField({ ...config, openaiCompatExtraBody: { model: 'other' } })).toBeUndefined()
  })
  it('uses existing boolean fields as configuration, rather than inferring a relay provider', () => {
    expect(compatWatermarkField({ openaiCompatExtraBody: { watermark: false } })).toBe('watermark')
    expect(compatWatermarkField({ openaiCompatExtraBody: { watermark_enabled: true } })).toBe('watermark_enabled')
    expect(compatWatermarkField({ openaiCompatExtraBody: { parameters: { watermark: false } } })).toBe('parameters.watermark')
    expect(compatWatermarkField({ openaiCompatExtraBody: { watermark: 'false' } })).toBeUndefined()
  })
})

describe('SVG output parameters', () => {
  it('asks for a single vector document and sends nothing else', () => {
    expect(outputRequestFields({ outputFormat: 'svg' })).toEqual({ output_format: 'svg' })
  })
  it('rejects the frame controls, which only a GIF honours', () => {
    expect(() => outputRequestFields({ outputFormat: 'svg', frameCount: 4 })).toThrow('SVG')
    expect(() => outputRequestFields({ outputFormat: 'svg', frameDurationMs: 120 })).toThrow('SVG')
  })
  it('refuses an output format outside the OpenAI images contract', () => {
    expect(() => outputRequestFields({ outputFormat: 'webp' })).toThrow('output_format')
  })
  it('keeps gifRequestFields limited to GIF fields', () => {
    expect(gifRequestFields({ outputFormat: 'svg' })).toEqual({})
  })
})

describe('GIF output parameters', () => {
  it('folds per-call GIF parameters into request fields and sends nothing otherwise', () => {
    expect(gifRequestFields({})).toEqual({})
    expect(gifRequestFields({ outputFormat: 'gif' })).toEqual({ output_format: 'gif' })
    expect(gifRequestFields({ outputFormat: 'gif', frameCount: 8 })).toEqual({ output_format: 'gif', frame_count: 8 })
    expect(gifRequestFields({ outputFormat: 'gif', frameCount: 2, frameDurationMs: 120 })).toEqual({ output_format: 'gif', frame_count: 2, frame_duration_ms: 120 })
  })
  it('rejects frame parameters that are not paired with GIF output', () => {
    expect(() => gifRequestFields({ frameCount: 8 })).toThrow('output_format=gif')
    expect(() => gifRequestFields({ frameDurationMs: 120 })).toThrow('output_format=gif')
  })
  it.each([1, 17, 2.5, Number.NaN])('rejects frame_count %s and names the accepted range', value => {
    expect(() => gifRequestFields({ outputFormat: 'gif', frameCount: value })).toThrow('2 到 16')
  })
  it.each([10, 2001, 100.5])('rejects frame_duration_ms %s and names the accepted range', value => {
    expect(() => gifRequestFields({ outputFormat: 'gif', frameDurationMs: value })).toThrow('20 到 2000')
  })
  it('validates a GIF frame size by the per-frame contract rather than the still-image pixel floor', () => {
    expect(() => validateOfficialSize('gpt-image-2', '768x768')).toThrow('尺寸')
    expect(() => validateGifFrameSize('768x768')).not.toThrow()
    expect(() => validateGifFrameSize('auto')).not.toThrow()
    // The sheet budget is the provider's call: a 3840 edge is legal for one frame.
    expect(() => validateGifFrameSize('3840x3840')).not.toThrow()
    expect(() => validateGifFrameSize('1000x1000')).toThrow('16 的倍数')
    expect(() => validateGifFrameSize('3856x16')).toThrow('3840')
    for (const size of ['0x0', '16x0', '0x16', 'bad']) expect(() => validateGifFrameSize(size)).toThrow('无效')
  })
})
