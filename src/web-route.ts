import type { ConnectionRequestRejection, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

export type WebAdmission = (request: ConnectionTrustRequest) => ConnectionRequestRejection | 503

/** Preserve hosts without connection admission unless the operator opts in. */
export function resolveWebAdmission(check: WebAdmission | undefined, required: boolean): WebAdmission | undefined {
  return check ?? (required ? () => 503 : undefined)
}

export function withWebAdmission(route: WebRoute, admission: () => WebAdmission | undefined): WebRoute {
  return {
    ...route,
    handler: (req, res) => {
      let rejection: number | undefined
      try {
        const check = admission()
        rejection = check?.(req)
      } catch { rejection = 503 }
      if (rejection === undefined) return route.handler(req, res)
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
    },
  }
}
