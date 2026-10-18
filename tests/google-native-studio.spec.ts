import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { generateFromStudio } from '../src/studio.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const attachment = { attachmentId: 'sha256:reference', mediaType: 'image/png' as const, bytes: png.length, width: 1, height: 1 }

describe('Studio Google native protocol over HTTP', () => {
  it.each(['generate', 'edit'] as const)('routes a %s request through a native-only gateway', async mode => {
    const requests: Array<{ url?: string; key?: string; body: any }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ url: req.url, key: req.headers['x-goog-api-key'] as string, body })
      const supported = req.url === '/proxy/v1beta/models/gemini-3-pro-image:generateContent' && Array.isArray(body.contents)
      res.writeHead(supported ? 200 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(supported ? { candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] } : { error: { message: 'contents is required' } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const saveImage = vi.fn(async () => ({ ...attachment, attachmentId: 'sha256:generated' }))
    const ctx = {
      credentials: { resolve: async () => ({ value: 'dummy-test-key' }) },
      attachments: { imageLimits: { maxImageBytes: 1024, mediaTypes: ['image/png'] }, readImage: async () => ({ data: new Uint8Array(png), ref: attachment }), saveImage },
      logger: { warn: vi.fn() },
    }
    try {
      const result = await generateFromStudio(ctx as never, {
        googleNative: true, googleModel: 'gemini-3-pro-image', googleEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy/v1beta`, saveToWorkspace: false,
      }, {
        mode, provider: 'google', model: 'gemini-3-pro-image', prompt: 'a cat', ratio: '16:9', quality: '2K',
        ...(mode === 'edit' ? { references: [{ attachment }] } : {}),
      }, new AbortController().signal)
      expect(result.attachment.attachmentId).toBe('sha256:generated')
      expect(requests).toHaveLength(1)
      expect(requests[0]!.key).toBe('dummy-test-key')
      expect(requests[0]!.body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' })
      const parts = requests[0]!.body.contents[0].parts
      expect(parts.at(-1)).toEqual({ text: 'a cat' })
      if (mode === 'edit') expect(parts[0]).toEqual({ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } })
      expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: new Uint8Array(png), mediaType: 'image/png' }))
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
