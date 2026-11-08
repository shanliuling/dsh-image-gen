/**
 * ChatGPT (Codex) subscription image vendor.
 *
 * Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
 * lib/vendors/codex.js and lib/images.js — only the pieces the image channel
 * needs: authorize URL, code exchange, refresh, and the generations call.
 * The device-code flow and chat streaming stay out of this bundle.
 */
import { buildAuthorizeUrl, chatgptAccountId, emailFromToken, formTokenRequest, type Pkce } from '../oauth.js'
import type { SubscriptionBlob } from '../blob.js'

export const CODEX_AUTH = 'https://auth.openai.com/oauth/authorize'
export const CODEX_TOKEN = 'https://auth.openai.com/oauth/token'
const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

/** Where the ChatGPT subscription image request goes. */
export const CODEX_IMAGE_URL = 'https://chatgpt.com/backend-api/codex/images/generations'
/** Where the ChatGPT subscription image edit request goes. */
export const CODEX_IMAGE_EDIT_URL = 'https://chatgpt.com/backend-api/codex/images/edits'
/** The model served by this endpoint (probed live: gpt-image-2.5-flare works
 * on the ChatGPT internal generations route as of 2026-09-14). */
export const CODEX_IMAGE_MODEL = 'gpt-image-2.5-flare'
/** GIF output exists from Images 2.6 on; stills stay on the probed model above. */
export const CODEX_GIF_MODEL = 'gpt-image-2.6-flare'

/** Public client id of the Codex CLI; vendor-fixed redirect on port 1455. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback'

export interface CodexConfig {
  clientId: string
  redirectUri: string
}

export function codexConfig(): CodexConfig {
  return { clientId: CODEX_CLIENT_ID, redirectUri: CODEX_REDIRECT_URI }
}

export function codexAuthorizeUrl(cfg: CodexConfig, pkce: Pkce): string {
  return buildAuthorizeUrl({
    authUrl: CODEX_AUTH,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    challenge: pkce.challenge,
    state: pkce.state,
    scope: CODEX_SCOPE,
    extra: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
  })
}

/** Identity fields every Codex API call must carry. */
export function codexIdentityHeaders(blob: SubscriptionBlob): Record<string, string> {
  return {
    authorization: `Bearer ${blob.accessToken}`,
    // ChatGPT distinguishes accounts with a separate header; without it the request is rejected.
    'chatgpt-account-id': blob.accountId,
    originator: 'codex_cli_rs',
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

function decorate(blob: SubscriptionBlob, json: Record<string, unknown>): SubscriptionBlob {
  const idToken = typeof json.id_token === 'string' ? json.id_token : ''
  return {
    ...blob,
    accountId: blob.accountId.length > 0
      ? blob.accountId
      : chatgptAccountId(idToken) || chatgptAccountId(blob.accessToken),
    email: blob.email.length > 0 ? blob.email : emailFromToken(idToken) || emailFromToken(blob.accessToken),
    label: blob.label.length > 0 ? blob.label : emailFromToken(idToken) || emailFromToken(blob.accessToken) || 'ChatGPT',
  }
}

function tokenBlobFromOAuth(json: Record<string, unknown>): SubscriptionBlob {
  const access = json.access_token
  const refresh = json.refresh_token
  return {
    accessToken: typeof access === 'string' ? access : '',
    refreshToken: typeof refresh === 'string' ? refresh : '',
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    label: '',
    email: '',
    accountId: '',
  }
}

export async function codexExchangeCode(cfg: CodexConfig, pkce: Pkce, code: string): Promise<SubscriptionBlob> {
  const json = await formTokenRequest(CODEX_TOKEN, {
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: pkce.verifier,
  }, fetch)
  return decorate(tokenBlobFromOAuth(json), json)
}

export async function codexRefresh(blob: SubscriptionBlob): Promise<SubscriptionBlob> {
  const json = await formTokenRequest(CODEX_TOKEN, {
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: blob.refreshToken,
  }, fetch)
  const next = tokenBlobFromOAuth(json)
  return {
    ...next,
    // OpenAI rotates the refresh token on use; keep the old one when absent.
    refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
    label: blob.label,
    email: blob.email,
    accountId: blob.accountId.length > 0 ? blob.accountId : next.accountId,
  }
}