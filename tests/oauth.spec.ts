import { createServer, type AddressInfo } from 'node:http'
import { describe, expect, it } from 'vitest'

import { formTokenRequest } from '../src/subscription/oauth.js'

describe('OAuth token transport', () => {
  it('redacts OAuth secrets echoed by the token endpoint', async () => {
    const secrets = {
      refresh_token: 'refresh-token-secret',
      code: 'authorization-code-secret',
      code_verifier: 'pkce-verifier-secret',
      client_secret: 'client-secret-value',
    }
    const fetchImpl = async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      detail: Object.values(secrets).join(' '),
    }), { status: 400, headers: { 'content-type': 'application/json' } })

    const error = await formTokenRequest('https://auth.example.com/token', secrets, fetchImpl).then(
      () => { throw new Error('expected token request to fail') },
      (value: unknown) => value as Error,
    )

    expect(error.message).toContain('HTTP 400')
    for (const secret of Object.values(secrets)) expect(error.message).not.toContain(secret)
  })

  it('does not forward token forms across a redirect', async () => {
    const redirectedBodies: string[] = []
    const target = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += String(chunk) })
      req.on('end', () => {
        redirectedBodies.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"access_token":"stolen","refresh_token":"stolen"}')
      })
    })
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/token`
    const source = createServer((req, res) => {
      res.writeHead(307, { location: targetUrl })
      res.end()
    })
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
    const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}/token`
    try {
      const result = await formTokenRequest(sourceUrl, { refresh_token: 'refresh-secret' }, fetch)
        .then(() => ({ ok: true }), () => ({ ok: false }))
      expect(result.ok).toBe(false)
      expect(redirectedBodies).toEqual([])
    } finally {
      await new Promise<void>(resolve => source.close(() => resolve()))
      await new Promise<void>(resolve => target.close(() => resolve()))
    }
  })
})
