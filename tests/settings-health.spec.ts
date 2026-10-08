import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import { apply } from '../src/index.js'

function harness(settings?: object) {
  const routes: Array<{ path: string; handler: (...args: any[]) => unknown }> = []
  const warn = vi.fn()
  const ctx = {
    tools: { register: vi.fn() },
    effect: (setup: () => unknown) => setup(),
    webServer: { register: (route: typeof routes[number]) => { routes.push(route); return () => {} } },
    credentials: {}, attachments: {}, logger: { warn },
    inject: (services: string[], callback: (owner: unknown) => unknown) => {
      if (services.includes('settings') && settings !== undefined) return callback({ settings })
    },
  }
  apply(ctx as never)
  const read = () => {
    const route = routes.find(route => route.path === '/plugins/dsh-image-gen/settings-health')
    expect(route, 'settings diagnostics must be available even when no form can be served').toBeDefined()
    let body = ''
    route!.handler({ method: 'GET' }, { setHeader: vi.fn(), end: (value: string) => { body = value } })
    return JSON.parse(body)
  }
  return { warn, read }
}

afterEach(() => { vi.restoreAllMocks() })

describe('host settings compatibility', () => {
  it('reports a healthy schema-derived host without a warning', () => {
    const host = harness({ describe: vi.fn(), mutate: vi.fn() })
    expect(host.read()).toEqual({ settings: 'live', liveSchema: true })
    expect(host.warn).not.toHaveBeenCalled()
  })

  it('reports missing volatile fields instead of silently allowing a broken modern form', () => {
    const fields = Object.values(Config.dict!)
    const previous = fields.map(field => field.meta.volatile)
    try {
      for (const field of fields) delete field.meta.volatile
      const host = harness({ describe: vi.fn(), mutate: vi.fn() })
      expect(host.read()).toEqual({ settings: 'live', liveSchema: false })
      expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('@deepseek-ai/schemastery >=3.18.4 <4'))
    } finally {
      fields.forEach((field, index) => { field.meta.volatile = previous[index] })
    }
  })

  it('preserves the legacy installSection path when a legacy schema is used', () => {
    const fields = Object.values(Config.dict!)
    const previous = fields.map(field => field.meta.volatile)
    const installSection = vi.fn()
    try {
      for (const field of fields) delete field.meta.volatile
      const host = harness({ installSection })
      expect(host.read()).toEqual({ settings: 'legacy', liveSchema: false })
      expect(installSection).toHaveBeenCalledOnce()
      expect(host.warn).not.toHaveBeenCalled()
    } finally {
      fields.forEach((field, index) => { field.meta.volatile = previous[index] })
    }
  })

  it('reports a missing settings service without exposing configuration or credentials', () => {
    expect(harness().read()).toEqual({ settings: 'unavailable', liveSchema: true })
  })
})
