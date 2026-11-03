import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveVault, serveVaultGc } from '../src/vault-route.js'
import { saveOriginal, type VaultConfig } from '../src/vault-store.js'

class FakeResponse {
  chunks: Buffer[] = []
  status = 0
  headers: Record<string, string> = {}
  ended = false
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.headers = { ...headers }
    return this
  }
  write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  end(chunk?: Buffer | string): void {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk))
    this.ended = true
  }
  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function request(method: string, url: string, body?: string): IncomingMessage {
  const stream = body === undefined ? undefined : body
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:8765', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (stream !== undefined) yield Buffer.from(stream)
    },
  }
  return req as unknown as IncomingMessage
}

const configs: VaultConfig[] = []
async function makeConfig(): Promise<VaultConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vault-route-'))
  const config = { enabled: true, dir, maxBytes: 0 }
  configs.push(config)
  return config
}

afterEach(async () => {
  for (const config of configs.splice(0)) await rm(config.dir, { recursive: true, force: true })
})

describe('raw vault routes', () => {
  it('serves an original with immutable headers and a 304 on ETag match', async () => {
    const config = await makeConfig()
    const saved = await saveOriginal(config, { data: new Uint8Array([9, 8, 7]), mediaType: 'image/png' })
    const res = new FakeResponse()
    await serveVault(request('GET', '/plugins/dsh-image-gen/vault?key=' + saved!.key + '&mediaType=image%2Fpng'), res as unknown as ServerResponse, config)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers.etag).toBe('"sha256:' + saved!.key + '"')
    expect(Array.from(res.body())).toEqual([9, 8, 7])

    const cached = new FakeResponse()
    const req = request('GET', '/plugins/dsh-image-gen/vault?key=' + saved!.key)
    ;(req.headers as Record<string, string>)['if-none-match'] = '"sha256:' + saved!.key + '"'
    await serveVault(req, cached as unknown as ServerResponse, config)
    expect(cached.status).toBe(304)
    expect(cached.body().length).toBe(0)
  })

  it('rejects malformed keys and reports missing files', async () => {
    const config = await makeConfig()
    const bad = new FakeResponse()
    await serveVault(request('GET', '/plugins/dsh-image-gen/vault?key=nope'), bad as unknown as ServerResponse, config)
    expect(bad.status).toBe(400)
    const missing = new FakeResponse()
    await serveVault(request('GET', '/plugins/dsh-image-gen/vault?key=' + 'a'.repeat(64)), missing as unknown as ServerResponse, config)
    expect(missing.status).toBe(404)
  })

  it('garbage-collects unreferenced files over POST', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const dropped = await saveOriginal(config, { data: new Uint8Array([2]), mediaType: 'image/png' })
    // Past the recent-write protection window.
    for (const key of [kept!.key, dropped!.key]) {
      await utimes(join(config.dir, key.slice(0, 2), key + '.png'), new Date(1_000), new Date(1_000))
    }
    const res = new FakeResponse()
    await serveVaultGc(request('POST', '/plugins/dsh-image-gen/vault-gc', JSON.stringify({ keys: [kept!.key] })), res as unknown as ServerResponse, config)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body().toString())).toEqual({ removed: 1, bytes: 1 })
  })
})
