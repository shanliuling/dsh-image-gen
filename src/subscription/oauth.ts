/**
 * OAuth primitives shared by the subscription vendors.
 *
 * Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
 * lib/oauth.js, lib/pkce.js, lib/jwt.js — PKCE generation, authorize-URL
 * building and the JWT payload reads the vendors need for identity headers.
 */
import { createHash, randomBytes } from 'node:crypto'
import { redactSecrets } from '../redact.js'

/** A PKCE pair plus the OAuth state binding the callback to this login. */
export interface Pkce {
  verifier: string
  challenge: string
  state: string
}

export async function createPkce(): Promise<Pkce> {
  const verifier = Buffer.from(randomBytes(32)).toString('base64url')
  const challenge = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url')
  const state = Buffer.from(randomBytes(16)).toString('base64url')
  return { verifier, challenge, state }
}

/** Build an authorization-code URL with PKCE and optional extra params. */
export function buildAuthorizeUrl(input: {
  authUrl: string
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  scope?: string
  extra?: Record<string, string>
}): string {
  const url = new URL(input.authUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.state)
  if (input.scope !== undefined && input.scope.length > 0) url.searchParams.set('scope', input.scope)
  if (input.extra !== undefined) {
    for (const [key, value] of Object.entries(input.extra)) {
      if (value === null || value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/** Decode a JWT payload without signature verification (identity read only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = String(token ?? '').split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The chatgpt-account-id a Codex API call must carry. */
export function chatgptAccountId(token: string): string {
  const payload = decodeJwtPayload(token)
  if (payload === undefined) return ''
  if (typeof payload.chatgpt_account_id === 'string') return payload.chatgpt_account_id
  const nested = payload['https://api.openai.com/auth']
  if (typeof nested === 'object' && nested !== null && typeof (nested as Record<string, unknown>).chatgpt_account_id === 'string') {
    return (nested as Record<string, unknown>).chatgpt_account_id as string
  }
  const orgs = payload.organizations
  if (Array.isArray(orgs) && orgs[0] !== null && typeof orgs[0] === 'object' && typeof (orgs[0] as Record<string, unknown>).id === 'string') {
    return (orgs[0] as Record<string, unknown>).id as string
  }
  return ''
}

/** The account email for badges and login confirmation. */
export function emailFromToken(token: string): string {
  const payload = decodeJwtPayload(token)
  if (payload === undefined) return ''
  const email = payload.email
  const preferred = payload.preferred_username
  if (typeof email === 'string' && email.length > 0) return email
  if (typeof preferred === 'string') return preferred
  return ''
}

/** POST an OAuth token endpoint with form encoding; 25s cap like the source. */
export async function formTokenRequest(
  url: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const secrets = Object.entries(params).flatMap(([key, value]) =>
      ['access_token', 'refresh_token', 'id_token', 'code', 'code_verifier', 'client_secret'].includes(key) ? [value] : [])
    const detail = redactSecrets(text, ...secrets).slice(0, 200)
    throw new Error(`token endpoint HTTP ${String(response.status)}${detail.length > 0 ? `: ${detail}` : ''}`)
  }
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}