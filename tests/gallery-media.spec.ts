import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGalleryItemBlob, galleryDownloadName, postZipDownload, syncVaultRefs } from '../src/client/gallery-media.js'
import type { GalleryItem } from '../src/client/gallery-store.js'
import { parseImageAttachmentRef } from '../src/reference-image.js'

afterEach(() => vi.unstubAllGlobals())

describe('gallery original reference sync', () => {
  it('submits 2000 compact attachment refs that the real ZIP parser still accepts', () => {
    let body = ''
    vi.stubGlobal('document', {
      body: { appendChild() {} },
      createElement: () => {
        const children: Array<{ name: string; value: string }> = []
        return { style: {}, appendChild: (child: { name: string; value: string }) => children.push(child), remove() {}, submit() { body = new URLSearchParams(children.map(child => [child.name, child.value])).toString() } }
      },
    })
    vi.stubGlobal('window', { setTimeout() {} })
    const item: GalleryItem = {
      id: 'import-normal', provider: 'import', prompt: '', model: '', createdAt: 0,
      attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/jpeg', bytes: 24996, width: 1672, height: 2508, name: 'fixture-portrait.png', originalDimensions: { width: 2400, height: 3600 } },
      original: { key: 'b'.repeat(64), bytes: 121331, mediaType: 'image/png' },
    }
    postZipDownload(Array.from({ length: 2000 }, () => item), 'zip-contract-1234')
    const payload = JSON.parse(new URLSearchParams(body).get('items')!) as Array<{ attachment: unknown }>
    expect(payload).toHaveLength(2000)
    expect(payload.every(entry => parseImageAttachmentRef(entry.attachment) !== undefined)).toBe(true)
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024)
  })
  it('names a PNG original fallback from the resolved JPEG attachment bytes', async () => {
    const item: GalleryItem = {
      id: 'jpeg-fallback', provider: 'import', model: '', prompt: '', createdAt: 0,
      attachment: { attachmentId: 'sha256:' + 'd'.repeat(64), mediaType: 'image/jpeg', bytes: 3 },
      original: { key: 'a'.repeat(64), mediaType: 'image/png', bytes: 100 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } })))
    const blob = await fetchGalleryItemBlob(item)
    expect(blob.type).toBe('image/jpeg')
    expect(galleryDownloadName(item, blob)).toBe('dsh-import-jpeg-fallback.jpg')
  })
  it('surfaces rejected references rather than reporting successful import', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'profile-browser-b' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"registry-unavailable"}', { status: 409 })))
    await expect(syncVaultRefs(['a'.repeat(64)])).rejects.toThrow('409')
  })
})
