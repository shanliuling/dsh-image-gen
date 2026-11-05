import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { downloadPublicImage, isPublicAddress } from '../src/public-image-download.js'

function transport(status = 200, chunks = [Buffer.from('image')], headers: Record<string, string> = {}) {
  let requests = 0
  let reads = 0
  let captured: any
  let response: Readable
  const deps: any = {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (_url: URL, options: unknown, callback: (response: unknown) => void) => {
      requests++
      captured = options
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () => queueMicrotask(() => {
        response = Readable.from((async function* () { for (const chunk of chunks) { reads++; yield chunk } })(), { highWaterMark: 1 })
        Object.assign(response, { statusCode: status, headers })
        callback(response)
      })
      return req
    },
  }
  return { deps, get requests() { return requests }, get reads() { return reads }, get options() { return captured }, get destroyed() { return response?.destroyed } }
}

describe('public result-image transport', () => {
  it('denies private, mapped, translated and non-global targets', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.0.1', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) expect(isPublicAddress(address)).toBe(false)
    for (const address of ['8.8.8.8', '2606:4700::1111']) expect(isPublicAddress(address)).toBe(true)
    const t = transport()
    for (const url of ['http://example.test/a', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://[::1]/a', 'https://user:pass@example.test/a', 'https://example.test:444/a']) await expect(downloadPublicImage(url, { maxBytes: 8 }, t.deps)).rejects.toThrow()
    expect(t.requests).toBe(0)
    t.deps.lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]
    await expect(downloadPublicImage('https://example.test/a', { maxBytes: 8 }, t.deps)).rejects.toThrow()
    expect(t.requests).toBe(0)
  })

  it('pins public DNS answers without changing the TLS hostname', async () => {
    const t = transport(200, [Buffer.from('image')], { 'content-type': 'image/png' })
    const result = await downloadPublicImage('https://example.test/a', { maxBytes: 5 }, t.deps)
    expect(result.data.byteLength).toBe(5)
    expect(t.options.agent).toBe(false)
    expect(t.options.headers.authorization).toBeUndefined()
    let pinned: unknown
    t.options.lookup('example.test', { all: true }, (error: unknown, answer: unknown) => { expect(error).toBeNull(); pinned = answer })
    expect(pinned).toEqual([{ address: '8.8.8.8', family: 4 }])
  })

  it('never follows redirects, and stops oversized responses before buffering them all', async () => {
    const redirect = transport(302, [], { location: 'https://127.0.0.1/a' })
    await expect(downloadPublicImage('https://example.test/a', { maxBytes: 8 }, redirect.deps)).rejects.toThrow('302')
    expect(redirect.requests).toBe(1)
    const declared = transport(200, [Buffer.alloc(16)], { 'content-length': '1000' })
    await expect(downloadPublicImage('https://example.test/a', { maxBytes: 8 }, declared.deps)).rejects.toThrow('byte limit')
    expect(declared.reads).toBe(0)
    const streamed = transport(200, [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])
    await expect(downloadPublicImage('https://example.test/a', { maxBytes: 8 }, streamed.deps)).rejects.toThrow('byte limit')
    expect(streamed.reads).toBeLessThan(4)
    expect(streamed.destroyed).toBe(true)
  })

  it('does not send a request for an already aborted operation', async () => {
    const controller = new AbortController(); controller.abort()
    const t = transport()
    await expect(downloadPublicImage('https://example.test/a', { maxBytes: 8, signal: controller.signal }, t.deps)).rejects.toThrow()
    expect(t.requests).toBe(0)
  })
})
