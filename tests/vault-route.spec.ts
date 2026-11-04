import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveVault, serveVaultDelete, serveVaultRefs } from '../src/vault-route.js'
import { readOriginal, saveOriginal, type VaultConfig } from '../src/vault-store.js'

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

  it('syncs references without deleting originals', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const unreferenced = await saveOriginal(config, { data: new Uint8Array([2]), mediaType: 'image/png' })
    const res = new FakeResponse()
    await serveVaultRefs(request('POST', '/plugins/dsh-image-gen/vault-refs', JSON.stringify({ profileId: 'profile-a-1234', keys: [kept!.key] })), res as unknown as ServerResponse, config)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body().toString())).toMatchObject({ removed: 0, bytes: 0 })
    expect(await readOriginal(config, kept!.key)).toBeDefined()
    expect(await readOriginal(config, unreferenced!.key)).toBeDefined()
  })

  it('deletes only keys unreferenced by every profile', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const deleted = await saveOriginal(config, { data: new Uint8Array([2]), mediaType: 'image/png' })
    await serveVaultRefs(request('POST', '/plugins/dsh-image-gen/vault-refs', JSON.stringify({ profileId: 'profile-a-1234', keys: [kept!.key, deleted!.key] })), new FakeResponse() as unknown as ServerResponse, config)

    const res = new FakeResponse()
    await serveVaultDelete(request('POST', '/plugins/dsh-image-gen/vault-delete', JSON.stringify({
      profileId: 'profile-a-1234',
      keys: [kept!.key],
      deleteKeys: [deleted!.key],
      confirm: true,
    })), res as unknown as ServerResponse, config)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body().toString())).toEqual({ removed: 1, bytes: 1 })
    expect(await readOriginal(config, kept!.key)).toBeDefined()
    expect(await readOriginal(config, deleted!.key)).toBeUndefined()
  })

  it('keeps an original that another profile still references', async () => {
    const config = await makeConfig()
    const kept = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const shared = await saveOriginal(config, { data: new Uint8Array([2]), mediaType: 'image/png' })
    await serveVaultRefs(request('POST', '/plugins/dsh-image-gen/vault-refs', JSON.stringify({ profileId: 'profile-a-1234', keys: [kept!.key, shared!.key] })), new FakeResponse() as unknown as ServerResponse, config)
    await serveVaultRefs(request('POST', '/plugins/dsh-image-gen/vault-refs', JSON.stringify({ profileId: 'profile-b-5678', keys: [shared!.key] })), new FakeResponse() as unknown as ServerResponse, config)

    const blocked = new FakeResponse()
    await serveVaultDelete(request('POST', '/plugins/dsh-image-gen/vault-delete', JSON.stringify({
      profileId: 'profile-a-1234',
      keys: [kept!.key],
      deleteKeys: [shared!.key],
      confirm: true,
    })), blocked as unknown as ServerResponse, config)
    expect(JSON.parse(blocked.body().toString())).toEqual({ removed: 0, bytes: 0 })
    expect(await readOriginal(config, shared!.key)).toBeDefined()

    const allowed = new FakeResponse()
    await serveVaultDelete(request('POST', '/plugins/dsh-image-gen/vault-delete', JSON.stringify({
      profileId: 'profile-b-5678',
      keys: [],
      deleteKeys: [shared!.key],
      confirm: true,
    })), allowed as unknown as ServerResponse, config)
    expect(JSON.parse(allowed.body().toString())).toEqual({ removed: 1, bytes: 1 })
  })

  it('does not delete when a legacy client omits profileId', async () => {
    const config = await makeConfig()
    const original = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    const res = new FakeResponse()
    await serveVaultRefs(request('POST', '/plugins/dsh-image-gen/vault-refs', JSON.stringify({ keys: [] })), res as unknown as ServerResponse, config)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body().toString())).toEqual({ removed: 0, bytes: 0 })
    expect(await readOriginal(config, original!.key)).toBeDefined()
  })

  it('adopts pre-existing originals into the legacy profile', async () => {
    const config = await makeConfig()
    const old = await saveOriginal(config, { data: new Uint8Array([7]), mediaType: 'image/png' })
    const sync = new FakeResponse()
    await serveVaultRefs(request('POST', '/plugins/dsh-image-gen/vault-refs', JSON.stringify({ profileId: 'profile-a-1234', keys: [] })), sync as unknown as ServerResponse, config)
    expect(sync.status).toBe(200)

    const registry = JSON.parse(await readFile(join(config.dir, '.refs.json'), 'utf8')) as { profiles: Record<string, { keys: string[] }> }
    expect(registry.profiles['legacy-vault'].keys).toContain(old!.key)

    const res = new FakeResponse()
    await serveVaultDelete(request('POST', '/plugins/dsh-image-gen/vault-delete', JSON.stringify({
      profileId: 'profile-a-1234',
      keys: [],
      deleteKeys: [old!.key],
      confirm: true,
    })), res as unknown as ServerResponse, config)
    expect(JSON.parse(res.body().toString())).toEqual({ removed: 0, bytes: 0 })
    expect(await readOriginal(config, old!.key)).toBeDefined()
  })

  it('does not delete when the registry is corrupt', async () => {
    const config = await makeConfig()
    const original = await saveOriginal(config, { data: new Uint8Array([1]), mediaType: 'image/png' })
    await writeFile(join(config.dir, '.refs.json'), '{not-json')
    const res = new FakeResponse()
    await serveVaultDelete(request('POST', '/plugins/dsh-image-gen/vault-delete', JSON.stringify({
      profileId: 'profile-a-1234',
      keys: [],
      deleteKeys: [original!.key],
      confirm: true,
    })), res as unknown as ServerResponse, config)
    expect(res.status).toBe(409)
    expect(await readOriginal(config, original!.key)).toBeDefined()
  })
});
