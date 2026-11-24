import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decomposeSeedreamLayers } from '../src/seedream-layers.js'
import { downloadPublicImage } from '../src/public-image-download.js'

vi.mock('../src/public-image-download.js', () => ({ downloadPublicImage: vi.fn() }))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1kAAAAASUVORK5CYII=', 'base64')
const box = { absolute: [10, 20, 60, 80], normalized: [100, 200, 600, 800] }
const layers = [
  { url: 'https://images.example/subject', z_index: 3, bounding_box: box, name: '主角', description: '人物' },
  { url: 'https://images.example/base', z_index: 0, name: '背景' },
]
let workspaceRoot: string
const input = () => ({
  model: 'doubao-seedream-5-0-flash-260915', baseURL: 'https://ark.example/v3', apiKey: 'mock',
  source: { data: png, mediaType: 'image/png' as const }, workspaceRoot, maxBytes: 10000, signal: new AbortController().signal,
  watermark: false, requestTimeoutMs: 60_000,
})
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-layer-test-'))
  vi.mocked(downloadPublicImage).mockReset().mockResolvedValue({ data: png, contentType: 'image/png' })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: layers })))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('Seedream layer decomposition', () => {
  it('saves the background and every transparent PNG in stacking order with their positions', async () => {
    const result = await decomposeSeedreamLayers(input())
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({ image: expect.stringMatching(/^data:image\/png;base64,/), layer_decomposition: true, output_format: 'png', size: 'auto' })
    expect(body).not.toHaveProperty('layer_decomposition_options')
    expect(result.imageCount).toBe(2)
    expect(await readdir(result.directory)).toEqual(['base.png', 'layer-3.png', 'manifest.json'])
    expect(await readFile(join(result.directory, 'layer-3.png'))).toEqual(png)
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
    expect(manifest.layers).toEqual([{ file: 'base.png', z_index: 0, name: '背景' }, {
      file: 'layer-3.png', z_index: 3, name: '主角', description: '人物', bounding_box: box,
    }])
  })

  it('passes the optional total image limit only for Seedream 5.5', async () => {
    await expect(decomposeSeedreamLayers({ ...input(), maxImages: 4 })).rejects.toThrow('5.5')
    expect(fetch).not.toHaveBeenCalled()
    await decomposeSeedreamLayers({ ...input(), model: 'doubao-seedream-5-5-261028', maxImages: 4 })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({ layer_decomposition_options: { max_images: 4 } })
  })

  it('sends the configured watermark setting', async () => {
    await decomposeSeedreamLayers(input())
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({ watermark: false })
  })

  it('keeps the downloaded layers and lists a failed one with its URL', async () => {
    vi.mocked(downloadPublicImage).mockResolvedValueOnce({ data: png, contentType: 'image/png' }).mockRejectedValueOnce(new Error('interrupted'))
    const result = await decomposeSeedreamLayers(input())
    expect(result).toMatchObject({ imageCount: 1, missingCount: 1 })
    expect(await readdir(result.directory)).toEqual(['base.png', 'manifest.json'])
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
    expect(manifest.missing).toEqual([{ z_index: 3, name: '主角', url: 'https://images.example/subject', error: 'interrupted' }])
  })

  it('records entries Ark could not produce instead of failing the whole set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [layers[0], { z_index: 5, error: { message: 'layer failed' } }] })))
    const result = await decomposeSeedreamLayers(input())
    expect(result).toMatchObject({ imageCount: 1, missingCount: 2 })
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
    expect(manifest.missing).toEqual([{ z_index: 0, error: 'Seedream returned no base layer' }, { z_index: 5, error: 'layer failed' }])
  })

  it('fails without leaving files when no layer can be saved', async () => {
    vi.mocked(downloadPublicImage).mockRejectedValue(new Error('gone'))
    await expect(decomposeSeedreamLayers(input())).rejects.toThrow('gone')
    expect(await readdir(workspaceRoot)).toEqual([])
  })

  it('removes everything when the user cancels mid-download', async () => {
    const controller = new AbortController()
    vi.mocked(downloadPublicImage).mockResolvedValueOnce({ data: png, contentType: 'image/png' }).mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    await expect(decomposeSeedreamLayers({ ...input(), signal: controller.signal })).rejects.toThrow()
    expect(await readdir(workspaceRoot)).toEqual([])
  })

  it('times only the upstream call, not the layer downloads', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(downloadPublicImage).mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
        return { data: png, contentType: 'image/png' }
      })
      const result = await decomposeSeedreamLayers({ ...input(), requestTimeoutMs: 1_000 })
      expect(result).toMatchObject({ imageCount: 2, missingCount: 0 })
    } finally {
      vi.useRealTimers()
    }
  })
})
