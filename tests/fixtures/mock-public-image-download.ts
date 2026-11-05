import { vi } from 'vitest'

// Adapter unit tests stub fetch for both provider JSON and fixture image bytes.
// Keep those fixtures offline after result images move to the HTTPS transport.
// The real transport (DNS pinning, redirects, streaming/abort limits) is exercised
// independently in public-image-download.spec.ts, without this mock.
vi.mock('../../src/public-image-download.js', () => ({
  downloadPublicImage: async (url: string, options: { maxBytes: number; signal?: AbortSignal; authorization?: string }) => {
    const response = await fetch(url, {
      redirect: 'error', signal: options.signal,
      ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
    })
    if (!response.ok) throw new Error(`Image download HTTP ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength > options.maxBytes) throw new Error('Image response exceeds the byte limit')
    return { data, contentType: response.headers.get('content-type') ?? undefined }
  },
}))
