/**
 * Host routes for subscription login: begin a login (returns the authorize
 * URL for the browser to open), sign out, and read login status.
 *
 * The token never crosses these routes: the browser receives only the
 * authorize URL, OK/error words, and the account email for the badge.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { SubscriptionManager, type SubscriptionVendor } from './manager.js'
import { SUBSCRIPTION_LOGIN_ROUTE, SUBSCRIPTION_STATUS_ROUTE } from '../shared.js'
import { SUBSCRIPTION_PROVIDERS, type SubscriptionProvider } from '../shared.js'
import { withWebAdmission, type WebAdmission } from '../web-route.js'

export { SUBSCRIPTION_LOGIN_ROUTE, SUBSCRIPTION_STATUS_ROUTE } from '../shared.js'

const MAX_BODY_BYTES = 16 * 1024

/** The vendor each subscription provider logs in as. */
function vendorOfProvider(provider: SubscriptionProvider): SubscriptionVendor {
  if (provider === 'chatgpt-sub') return 'codex'
  if (provider === 'google-sub') return 'antigravity'
  return 'grok'
}

/** Register the login/status routes on the plugin's web server. */
export function registerSubscriptionRoutes(ctx: Context, manager: SubscriptionManager, admission: () => WebAdmission | undefined = () => undefined): void {
  ctx.effect(() => ctx.webServer.register(withWebAdmission({
    kind: 'exact',
    path: SUBSCRIPTION_LOGIN_ROUTE,
    handler: (req, res) => { void serveLogin(req, res, manager) },
  }, admission)), 'dsh-image-gen: subscription login route')

  ctx.effect(() => ctx.webServer.register(withWebAdmission({
    kind: 'exact',
    path: SUBSCRIPTION_STATUS_ROUTE,
    handler: (req, res) => { void serveStatus(req, res, manager) },
  }, admission)), 'dsh-image-gen: subscription status route')
}

async function serveLogin(req: IncomingMessage, res: ServerResponse, manager: SubscriptionManager): Promise<void> {
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return jsonError(res, 415, 'json-required')
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return jsonError(res, 400, 'invalid-request')
  }
  const provider = record(body)?.provider
  if (typeof provider !== 'string' || !(SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider)) {
    return jsonError(res, 400, 'invalid-provider')
  }
  const action = record(body)?.action
  const vendor = vendorOfProvider(provider as SubscriptionProvider)
  try {
    if (action === 'logout') {
      await manager.logout(vendor)
      return json(res, 200, { ok: true })
    }
    const { url } = await manager.beginLogin(vendor)
    json(res, 200, { ok: true, url })
  } catch (error) {
    json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function serveStatus(req: IncomingMessage, res: ServerResponse, manager: SubscriptionManager): Promise<void> {
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected')
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  const statuses: Record<string, { state: string; email?: string }> = {}
  for (const provider of SUBSCRIPTION_PROVIDERS satisfies ReadonlyArray<SubscriptionProvider>) {
    const status = await manager.loginStatus(vendorOfProvider(provider))
    statuses[provider] = status.state === 'logged-in'
      ? { state: status.state, email: status.email }
      : { state: status.state }
  }
  json(res, 200, { ok: true, statuses })
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  return origin === undefined || host === undefined || origin === `http://${host}` || origin === `https://${host}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  json(res, status, { error: code })
}