import type { ConnectionRequestRejection, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type WebAdmission = (request: ConnectionTrustRequest) => ConnectionRequestRejection | 503

/** Preserve hosts without connection admission unless the operator opts in. */
export function resolveWebAdmission(check: WebAdmission | undefined, required: boolean): WebAdmission | undefined {
  return check ?? (required ? () => 503 : undefined)
}

// DSH 0.2 passes the authenticated Peer to the route. The 0.1 dispatcher
// ignores auth and calls the same handler with only the request and response.
type ProtectedWebRoute = Omit<WebRoute, 'handler'> & {
  auth: 'required'
  handler: (req: IncomingMessage, res: ServerResponse, peer?: { readonly signal: AbortSignal }) => ReturnType<WebRoute['handler']>
}

export function withWebAdmission(route: WebRoute, admission: () => WebAdmission | undefined): ProtectedWebRoute {
  return {
    ...route,
    auth: 'required',
    handler: (req, res, peer) => {
      let rejection: number | undefined
      if (peer !== undefined) {
        if (peer.signal.aborted) rejection = 401
      } else {
        try {
          rejection = admission()?.(req)
        } catch { rejection = 503 }
      }
      if (rejection === undefined) return route.handler(req, res)
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
    },
  }
}
