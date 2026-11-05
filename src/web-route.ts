import type { ConnectionRequestRejection, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

export type WebAdmission = (request: ConnectionTrustRequest) => ConnectionRequestRejection

export function withWebAdmission(route: WebRoute, admission: () => WebAdmission | undefined): WebRoute {
  return {
    ...route,
    handler: (req, res) => {
      let rejection: ConnectionRequestRejection | 503
      try {
        const check = admission()
        rejection = check === undefined ? 503 : check(req)
      } catch {
        rejection = 503
      }
      if (rejection === undefined) return route.handler(req, res)
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: rejection === 503 ? 'authentication-unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden' }))
    },
  }
}
