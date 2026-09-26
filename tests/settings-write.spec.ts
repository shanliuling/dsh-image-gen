import { describe, expect, it, vi } from 'vitest'
import { writeSetting } from '../src/client/settings-write.js'

describe('settings write compatibility', () => {
  it('surfaces a refused 0.1.7 form write instead of reporting success', async () => {
    const set = vi.fn(async () => false)
    await expect(writeSetting({ set }, 'provider', 'openai', 'Setting was not saved'))
      .rejects.toThrow('Setting was not saved')
    expect(set).toHaveBeenCalledWith('provider', 'openai')
  })

  it('accepts both successful 0.1.7 writes and legacy void results', async () => {
    await expect(writeSetting({ set: async () => true }, 'provider', 'openai', 'rejected')).resolves.toBeUndefined()
    await expect(writeSetting({ set: async () => {} }, 'provider', 'openai', 'rejected')).resolves.toBeUndefined()
  })
})
