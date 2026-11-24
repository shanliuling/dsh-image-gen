import type { ConnectionRequestRejection, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

export type WebAdmission = (request: ConnectionTrustRequest) => ConnectionRequestRejection | 503

/** The admission methods a DSH connection service has offered across versions. */
export interface AdmissionConnection {
  /** DSH before 0.2.2-rc.2. */
  readonly requestRejection?: ((request: ConnectionTrustRequest) => ConnectionRequestRejection) | undefined
  /** Every DSH version; from 0.2.2-rc.2 the only one, and it may also answer 503. */
  readonly admit?: ((request: ConnectionTrustRequest) => { readonly peer: unknown } | { readonly rejection: 401 | 403 | 503 }) | undefined
}

/**
 * Admission check for one DSH connection service (#159). Older hosts keep the
 * exact call they always had; newer hosts removed `requestRejection` and only
 * offer `admit`. A host offering neither throws, which the route wrapper turns
 * into a 503 rather than letting the request through.
 */
export function connectionAdmission(connection: AdmissionConnection): WebAdmission {
  return request => {
    if (typeof connection.requestRejection === 'function') return connection.requestRejection(request)
    if (typeof connection.admit === 'function') {
      const admission = connection.admit(request)
      return 'rejection' in admission ? admission.rejection : undefined
    }
    throw new Error('DSH connection service offers neither admit() nor requestRejection()')
  }
}

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
