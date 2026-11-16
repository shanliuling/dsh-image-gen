/**
 * Regression tests: an unmapped ratio must keep its orientation.
 *
 * The openai-compat size resolver falls back to `LEGACY_OPENAI_TABLE`, which
 * only lists 1:1, 3:2 and 2:3. Every other ratio the tool schema advertises
 * (3:4, 4:5, 9:16, 4:3, 5:4, 16:9, 21:9) used to resolve to 1024x1024, so a
 * portrait request silently produced a square image.
 */
import { describe, expect, it } from 'vitest'
import { openAIRequestSize } from '../src/studio.js'
import type { Config } from '../src/config.js'

/** No relay size table: the resolver falls back to the built-in trio. */
const emptyConfig = { openaiCompatSizes: {} } as Config

describe('openAIRequestSize without a configured relay table', () => {
  it('keeps a square request square', () => {
    expect(openAIRequestSize(emptyConfig, '1:1', '1K')).toBe('1024x1024')
  })

  it('keeps the two documented ratios on their exact pixels', () => {
    expect(openAIRequestSize(emptyConfig, '3:2', '1K')).toBe('1536x1024')
    expect(openAIRequestSize(emptyConfig, '2:3', '1K')).toBe('1024x1536')
  })

  it('orients every other portrait ratio vertically', () => {
    for (const ratio of ['3:4', '4:5', '9:16']) {
      expect(openAIRequestSize(emptyConfig, ratio, '1K'), ratio).toBe('1024x1536')
    }
  })

  it('orients every other landscape ratio horizontally', () => {
    for (const ratio of ['4:3', '5:4', '16:9', '21:9']) {
      expect(openAIRequestSize(emptyConfig, ratio, '1K'), ratio).toBe('1536x1024')
    }
  })

  it('still falls back to a square for a ratio it cannot parse', () => {
    expect(openAIRequestSize(emptyConfig, 'auto', '1K')).toBe('1024x1024')
    expect(openAIRequestSize(emptyConfig, '', '1K')).toBe('1024x1024')
  })
})

describe('openAIRequestSize with a configured relay table', () => {
  it('prefers the configured exact size over the orientation fallback', () => {
    const config = { openaiCompatSizes: { '3:4': { '1K': '896x1152' } } } as Config
    expect(openAIRequestSize(config, '3:4', '1K')).toBe('896x1152')
  })
})
