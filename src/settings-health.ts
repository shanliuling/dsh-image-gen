/** Diagnose the actual host service and schema without reading any settings values. */
import type z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SettingsHealth } from './shared.js'

export function describeSettingsHealth(settings: unknown, schema: z): SettingsHealth {
  const service = settings as { installSection?: unknown; describe?: unknown } | undefined
  const fields = Object.values(schema.dict ?? {})
  return {
    settings: typeof service?.installSection === 'function' ? 'legacy'
      : typeof service?.describe === 'function' ? 'live' : 'unavailable',
    // Check what the host actually projects, rather than a version string or
    // the presence of a method on a different schemastery copy.
    liveSchema: fields.length > 0 && fields.every(field => field.meta.volatile === true),
  }
}

export function serveSettingsHealth(req: IncomingMessage, res: ServerResponse, health: SettingsHealth): void {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'GET') {
    res.statusCode = 405
    res.setHeader('allow', 'GET')
    res.end()
    return
  }
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(health))
}
