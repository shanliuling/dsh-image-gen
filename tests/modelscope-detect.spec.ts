/**
 * ModelScope API-Inference is recognised by its official address (#140), the
 * same way SiliconFlow is, so a channel pointed at it works without a settings
 * choice and gets the long timeout its polled tasks need.
 */
import { describe, expect, it } from 'vitest'
import { resolveProvider, type Config } from '../src/config.js'
import { channelPollsTask } from '../src/studio.js'
import { compatEditFormat } from '../src/watermark.js'

const MODELSCOPE = 'https://api-inference.modelscope.cn/v1'

describe('ModelScope detection by base URL', () => {
  it('selects the async task flow for the official address', () => {
    for (const baseURL of [MODELSCOPE, `${MODELSCOPE}/`]) {
      expect(compatEditFormat({ openaiCompatBaseURL: baseURL } as Config), baseURL).toBe('modelscopeAsync')
    }
    const config = { provider: 'openai-compat', openaiCompatBaseURL: MODELSCOPE, openaiCompatModel: 'MiniMax/MiniMax-H3-Image' } as Config
    expect(resolveProvider(config)).toMatchObject({ provider: 'openai-compat', editFormat: 'modelscopeAsync' })
  })

  it('leaves look-alike addresses on the configured format', () => {
    for (const baseURL of [
      'http://api-inference.modelscope.cn/v1',
      'https://api-inference.modelscope.cn:8443/v1',
      'https://api-inference.modelscope.cn/v2',
      'https://api-inference.modelscope.cn.evil.example/v1',
      'https://relay.example/v1',
    ]) {
      expect(compatEditFormat({ openaiCompatBaseURL: baseURL } as Config), baseURL).toBe('multipart')
    }
  })

  it('gives a ModelScope channel the long timeout, and nothing else', () => {
    const modelscope = { openaiCompatBaseURL: MODELSCOPE } as Config
    expect(channelPollsTask(modelscope, { provider: 'openai-compat' })).toBe(true)
    expect(channelPollsTask({ openaiCompatBaseURL: 'https://relay.example/v1' } as Config, { provider: 'openai-compat' })).toBe(false)
    expect(channelPollsTask(modelscope, { provider: 'seedream' })).toBe(false)
  })
})
