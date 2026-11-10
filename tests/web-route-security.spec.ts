import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index.js'
import { SETTINGS_HEALTH_ROUTE } from '../src/shared.js'
import { withWebAdmission } from '../src/web-route.js'

function harness(rejection: 401 | 403 | undefined) {
  const routes: WebRoute[] = []
  const requestRejection = vi.fn(() => rejection)
  const ctx = {
    tools: { register: vi.fn() },
    effect: (setup: () => unknown) => setup(),
    webServer: { register: (route: WebRoute) => { routes.push(route); return () => {} } },
    connection: { requestRejection },
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
  apply(ctx, { saveToWorkspace: false })
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
})
