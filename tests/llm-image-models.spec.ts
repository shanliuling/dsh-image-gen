import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateLlmImage, imageUrlsFromText, isLlmImageModel, llmImageProfiles } from '../src/llm-image-models.js'

function contextWith(models: Array<{ id: string; name: string }>, chunks: unknown[] = []): any {
  const llm = {
    listProviders: () => [{ id: 'doubao', name: '豆包' }, { id: 'google', name: 'Google' }],
    listModels: vi.fn(async () => models),
    stream: vi.fn(async function* () { for (const chunk of chunks) yield chunk }),
  }
  return {
    llm,
    get: (name: string) => name === 'llm' ? llm : undefined,
    attachments: {
      imageLimits: { maxImageBytes: 1024 * 1024 },
      saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string }) => ({
        attachmentId: 'saved-image', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1,
      })),
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('conversation image models', () => {
  it('offers explicit image-generation models from a configured conversation provider', async () => {
    const ctx = contextWith([
      { id: '0', name: '豆包 快速' },
      { id: 'image-gen', name: '豆包 生图（Seedream 5.0）' },
    ])
    const profiles = await llmImageProfiles(ctx)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ provider: 'llm:doubao', model: 'image-gen', configured: true, supportsEditing: false })
    expect(profiles[0]?.modelOptions).toEqual([{ value: 'image-gen', label: '豆包 生图（Seedream 5.0）' }])
  })

  it('does not mistake an image-understanding chat model for generation', () => {
    expect(isLlmImageModel({ id: 'vision-chat', name: '图片理解' })).toBe(false)
    expect(isLlmImageModel({ id: 'doubao-seedream-5-0-pro', name: 'Seedream 5.0' })).toBe(true)
  })

  it('extracts image URLs from the conversation transport without trailing punctuation', () => {
    expect(imageUrlsFromText('![豆包生图](https://img.example/a.png)\n完成。')).toEqual(['https://img.example/a.png'])
  })

  it('streams a selected image model and saves the returned image as an attachment', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })))
    const ctx = contextWith(
      [{ id: 'image-gen', name: '豆包 生图（Seedream 5.0）' }],
      [{ type: 'text-delta', text: '![豆包生图](https://img.example/a.png)' }],
    )
    const result = await generateLlmImage(ctx, {
      provider: 'llm:doubao', model: 'image-gen', mode: 'generate', prompt: 'a sailboat', ratio: '1:1', quality: 'default',
    } as any, new AbortController().signal)
    expect(result.attachment.attachmentId).toBe('saved-image')
    expect(ctx.attachments.saveImage).toHaveBeenCalledOnce()
    expect(ctx.llm.stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'doubao', model: 'image-gen' }))
  })

  it('rejects a model absent from the provider image catalog before streaming', async () => {
    const ctx = contextWith([{ id: '0', name: '豆包 快速' }])
    await expect(generateLlmImage(ctx, {
      provider: 'llm:doubao', model: '0', mode: 'generate', prompt: 'a sailboat', ratio: '1:1', quality: 'default',
    } as any, new AbortController().signal)).rejects.toThrow('不是当前对话通道已启用的生图模型')
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })
})
