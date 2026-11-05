import type { ConnectionRequestRejection, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

export type WebAdmission = (request: ConnectionTrustRequest) => ConnectionRequestRejection

export function withWebAdmission(route: WebRoute, admission: () => WebAdmission | undefined): WebRoute {
  return {
    ...route,
    handler: (req, res) => {
      let rejection: number | undefined
      try {
        const check = admission()
        rejection = typeof check === 'function' ? check(req) : 503
      } catch { rejection = 503 }
      if (rejection === undefined) return route.handler(req, res)
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
    },
  }
}
