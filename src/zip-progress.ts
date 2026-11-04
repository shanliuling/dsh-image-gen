/** Progress/cancel bookkeeping for host-streamed ZIP exports. */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type ZipJobState = 'running' | 'done' | 'cancelled' | 'error'

interface ZipJob {
  token: string
  total: number
  done: number
  state: ZipJobState
  cancelled: boolean
  listeners: Set<() => void>
  updatedAt: number
}

const jobs = new Map<string, ZipJob>()
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const JOB_TTL_MS = 10 * 60 * 1000

/** Tokens are client-generated identifiers; anything else is ignored. */
export function isValidZipToken(token: string): boolean {
  return TOKEN_PATTERN.test(token)
}

function notify(job: ZipJob): void {
  job.updatedAt = Date.now()
  for (const listener of [...job.listeners]) listener()
}

function prune(): void {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [token, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(token)
  }
}

function ensureJob(token: string): ZipJob | undefined {
  if (!isValidZipToken(token)) return undefined
  let job = jobs.get(token)
  if (job === undefined) {
    prune()
    job = {
      token,
      total: 0,
      done: 0,
      state: 'running',
      cancelled: false,
      listeners: new Set(),
      updatedAt: Date.now(),
    }
    jobs.set(token, job)
  }
  return job
}

/** The SSE listener may connect first; createZipJob then fills in the total. */
export function createZipJob(token: string, total: number): void {
  const job = ensureJob(token)
  if (job === undefined) return
  job.total = total
  job.done = 0
  job.state = 'running'
  // A placeholder may already have been cancelled from the progress stream;
  // keep that flag so the export stops before its first attachment.
  notify(job)
}

export function updateZipJob(token: string, done: number): void {
  const job = jobs.get(token)
  if (job === undefined || job.state !== 'running') return
  job.done = Math.max(job.done, done)
  notify(job)
}

export function finishZipJob(token: string, state: Exclude<ZipJobState, 'running'>): void {
  const job = jobs.get(token)
  if (job === undefined || job.state !== 'running') return
  job.state = state
  if (state === 'done') job.done = job.total
  notify(job)
  for (const listener of [...job.listeners]) {
    job.listeners.delete(listener)
  }
}

export function isZipJobCancelled(token: string): boolean {
  return jobs.get(token)?.cancelled === true
}

export function cancelZipJob(token: string): boolean {
  const job = jobs.get(token)
  if (job === undefined) return false
  if (job.state !== 'running') return false
  job.cancelled = true
  notify(job)
  return true
}

/**
 * Server-sent events for one export: the client keeps the fast iframe download
 * and still sees "N/M" progress plus completion.
 */
export function serveZipProgress(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') return jsonError(res, 405, 'method-not-allowed')
  const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? ''
  const job = ensureJob(token)
  if (job === undefined) return jsonError(res, 404, 'unknown-job')

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = (): void => {
    if (res.writableEnded) return
    res.write('event: progress\ndata: ' + JSON.stringify({ done: job.done, total: job.total, state: job.state }) + '\n\n')
    if (job.state !== 'running') {
      job.listeners.delete(send)
      res.end()
    }
  }
  send()
  if (job.state === 'running') {
    job.listeners.add(send)
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n')
    }, 15_000)
    heartbeat.unref?.()
    // Request close signals the completed GET, not the SSE socket; clean up
    // when the response itself closes instead.
    res.on('close', () => {
      clearInterval(heartbeat)
      job.listeners.delete(send)
    })
  }
}

/** Stop an in-flight export; the ZIP response is destroyed so the download fails. */
export function serveZipCancel(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed')
  const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? ''
  const ok = cancelZipJob(token)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok }))
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
}
