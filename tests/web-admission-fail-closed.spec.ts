import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'
import { withWebAdmission } from '../src/web-route.js'

it.each([
  [undefined, 503],
  [() => 401, 401],
  [() => 403, 403],
  [() => { throw new Error('unavailable') }, 503],
] as const)('fails closed when admission is unavailable or rejects', async (check, code) => {
  const handler = vi.fn()
  const res = { writeHead: vi.fn(), end: vi.fn() }
  const route = withWebAdmission({ kind: 'exact', path: '/fixture', handler }, () => check)
  await route.handler({} as IncomingMessage, res as unknown as ServerResponse)
  expect(res.writeHead.mock.calls[0]?.[0]).toBe(code)
  expect(handler).not.toHaveBeenCalled()
})

it('admits a valid request and denies after admission disposal', async () => {
  let admission: (() => undefined) | undefined = () => undefined
  const handler = vi.fn()
  const route = withWebAdmission({ kind: 'exact', path: '/fixture', handler }, () => admission)
  const response = { writeHead: vi.fn(), end: vi.fn() }
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).toHaveBeenCalledOnce()
  admission = undefined
  await route.handler({} as IncomingMessage, response as unknown as ServerResponse)
  expect(handler).toHaveBeenCalledOnce()
  expect(response.writeHead.mock.calls[0]?.[0]).toBe(503)
})
