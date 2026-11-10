import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'
import { resolveWebAdmission, withWebAdmission } from '../src/web-route.js'

it.each([
  [undefined, 503],
  [() => 401, 401],
  [() => 403, 403],
  [() => { throw new Error('unavailable') }, 503],
] as const)('fails closed when admission is unavailable or rejects', async (check, code) => {
  const handler = vi.fn()
  const res = { writeHead: vi.fn(), end: vi.fn() }
  const route = withWebAdmission({ kind: 'exact', path: '/fixture', handler }, () => resolveWebAdmission(check, true))
  await route.handler({} as IncomingMessage, res as unknown as ServerResponse)
  expect(res.writeHead.mock.calls[0]?.[0]).toBe(code)
  expect(handler).not.toHaveBeenCalled()
})

it('admits a valid request and denies after admission disposal', async () => {
  let admission: (() => undefined) | undefined = () => undefined
  const handler = vi.fn()
  const route = withWebAdmission({ kind: 'exact', path: '/fixture', handler }, () => resolveWebAdmission(admission, true))
  const response = { writeHead: vi.fn(), end: vi.fn() }
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).toHaveBeenCalledOnce()
  admission = undefined
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).toHaveBeenCalledOnce()
  expect(response.writeHead.mock.calls[0]?.[0]).toBe(503)
})

it('keeps admission optional by default and applies live opt-in changes', async () => {
  let required = false
  const handler = vi.fn()
  const response = { writeHead: vi.fn(), end: vi.fn() }
  const route = withWebAdmission({ kind: 'exact', path: '/fixture', handler }, () => resolveWebAdmission(undefined, required))
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).toHaveBeenCalledOnce()
  required = true
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).toHaveBeenCalledOnce()
  expect(response.writeHead).toHaveBeenCalledWith(503, expect.anything())
  required = false
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).toHaveBeenCalledTimes(2)
})

it.each([false, true])('still honors host rejection when required=%s', async required => {
  const handler = vi.fn()
  const response = { writeHead: vi.fn(), end: vi.fn() }
  const route = withWebAdmission({ kind: 'exact', path: '/fixture', handler }, () => resolveWebAdmission(() => 403, required))
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).not.toHaveBeenCalled()
  expect(response.writeHead).toHaveBeenCalledWith(403, expect.anything())
})
