import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index.js'
import { SETTINGS_HEALTH_ROUTE, TEST_CONNECTION_ROUTE } from '../src/shared.js'
import { withWebAdmission } from '../src/web-route.js'

function harness(rejection: 401 | 403 | undefined, modernHost = false) {
  const routes: WebRoute[] = []
  const requestRejection = vi.fn(() => rejection)
  const ctx = {
    tools: { register: vi.fn() },
    effect: (setup: () => unknown) => setup(),
    webServer: { register: (route: WebRoute) => { routes.push(route); return () => {} } },
    connection: modernHost ? {} : { requestRejection },
    credentials: { resolve: vi.fn(async () => ({ value: 'test-key' })) },
    inject: (services: readonly string[], callback: (owner: Context) => void) => {
      if (services.includes('webServer') || services.includes('connection')) callback(ctx)
    },
    attachments: {
      imageLimits: { maxImageBytes: 10 * 1024 * 1024, mediaTypes: ['image/png'] },
      readImage: vi.fn(), saveImage: vi.fn(),
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
  apply(ctx, { saveToWorkspace: false, requireHostAdmission: modernHost })
  return { routes, requestRejection }
}

function request(): IncomingMessage {
  return {
    method: 'GET',
    url: '/',
    headers: { host: '127.0.0.1:8765' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
  } as unknown as IncomingMessage
}

function response(): ServerResponse {
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse
  vi.mocked(res.writeHead).mockImplementation((status: number) => {
    res.statusCode = status
    return res
  })
  return res
}

describe('plugin web route admission', () => {
  it('keeps legacy host dispatch when no admission service is available', async () => {
    const handler = vi.fn()
    const route = withWebAdmission({ kind: 'exact', path: '/legacy-host', handler }, () => undefined)
    const res = response()
    await route.handler(request(), res)
    expect(handler).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
  })
  it.each([401, 403] as const)('applies host rejection %i to every registered route before dispatch', async rejection => {
    const { routes, requestRejection } = harness(rejection)
    expect(routes.length).toBeGreaterThan(8)
    const statuses: Array<{ path: string; status: number }> = []
    for (const route of routes) {
      const res = response()
      await route.handler(request(), res)
      statuses.push({ path: route.path, status: res.statusCode })
    }
    expect(statuses).toEqual(routes.map(route => ({ path: route.path, status: rejection })))
    expect(requestRejection).toHaveBeenCalledTimes(routes.length)
  })

  it('allows a route when the host admits the request', async () => {
    const { routes, requestRejection } = harness(undefined)
    const route = routes.find(route => route.path === SETTINGS_HEALTH_ROUTE)
    expect(route).toBeDefined()
    const res = response()
    await route!.handler(request(), res)
    expect(res.statusCode).toBe(200)
    expect(requestRejection).toHaveBeenCalledOnce()
  })

  it('serves connection tests and model discovery with the Peer admitted by DSH 0.2', async () => {
    const { routes } = harness(undefined, true)
    const route = routes.find(route => route.path === TEST_CONNECTION_ROUTE)!
    const model = 'doubao-seedream-5-5-261028'
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [{ id: model }] }))
    try {
      for (const action of [undefined, 'models']) {
        const req = Object.assign(request(), {
          method: 'POST',
          url: route.path,
          headers: { host: '127.0.0.1:8765', 'content-type': 'application/json' },
          async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ provider: 'seedream', action })) },
        })
        const res = response()
        const peer = { signal: new AbortController().signal }
        await Reflect.apply(route.handler, route, [req, res, peer])
        expect(res.statusCode).toBe(200)
        expect(res.end).toHaveBeenCalledWith(JSON.stringify(action === 'models' ? { ok: true, models: [model] } : { ok: true }))
      }
      expect(upstream).toHaveBeenCalledTimes(2)
      expect(routes.every(route => 'auth' in route && route.auth === 'required')).toBe(true)
    } finally {
      upstream.mockRestore()
    }
  })

  it('fails closed if modern dispatch does not supply an admitted Peer', async () => {
    const { routes } = harness(undefined, true)
    const route = routes.find(route => route.path === SETTINGS_HEALTH_ROUTE)!
    const res = response()
    await route.handler(request(), res)
    expect(res.statusCode).toBe(503)
  })

  it('rejects an admitted Peer that has disconnected', async () => {
    const handler = vi.fn()
    const route = withWebAdmission({ kind: 'exact', path: '/fixture', handler }, () => undefined)
    const res = response()
    const controller = new AbortController()
    controller.abort()
    await route.handler(request(), res, { signal: controller.signal })
    expect(res.statusCode).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})
