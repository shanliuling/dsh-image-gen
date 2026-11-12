import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import type { LookupAddress } from 'node:dns'

const denied4 = new BlockList()
for (const [base, mask] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied4.addSubnet(base, mask, 'ipv4')
const public6 = new BlockList()
public6.addSubnet('2000::', 3, 'ipv6')
const denied6 = new BlockList()
for (const [base, mask] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  denied6.addSubnet(base, mask, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !denied4.check(address, 'ipv4')
    : family === 6 && public6.check(address, 'ipv6') && !denied6.check(address, 'ipv6')
}

interface DownloadOptions { maxBytes: number; signal?: AbortSignal; authorization?: string }
interface DownloadDeps {
  lookup?: (host: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>
  request?: typeof httpsRequest
}

/** Pin validated DNS answers at socket lookup. Never follow provider-result redirects.
 * Explicitly configured local ComfyUI uses its separate bounded transport.
 */
export async function downloadPublicImage(value: string, options: DownloadOptions, deps: DownloadDeps = {}): Promise<{ data: Uint8Array; contentType: string | undefined }> {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Image download requires a public HTTPS URL on port 443')
  }
  const max = options.maxBytes
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error('Invalid image byte limit')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const timeout = AbortSignal.timeout(30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  signal.throwIfAborted()
  const resolve: NonNullable<DownloadDeps['lookup']> = deps.lookup ?? ((host, options) => dnsLookup(host, options))
  const request = deps.request ?? httpsRequest
  let abortDns: (() => void) | undefined
  let answers: LookupAddress[]
  try {
    answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      resolve(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        abortDns = () => reject(signal.reason)
        signal.addEventListener('abort', abortDns, { once: true })
      }),
    ])
  } finally { if (abortDns) signal.removeEventListener('abort', abortDns) }
  signal.throwIfAborted()
  if (!answers.length || answers.some(a => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) {
    throw new Error('Image download target is not a public address')
  }
  const pinnedLookup = ((_host, opts, callback) => {
    if (opts?.all) callback(null, answers)
    else {
      const a = answers.find(a => !opts?.family || a.family === opts.family) ?? answers[0]!
      callback(null, a.address, a.family)
    }
  }) as LookupFunction
  return await new Promise((resolveResult, reject) => {
    const req = request(url, {
      signal, lookup: pinnedLookup, agent: false,
      headers: { accept: 'image/png,image/jpeg,image/webp,image/gif', ...(options.authorization ? { authorization: options.authorization } : {}) },
    }, res => {
      void (async () => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) { res.destroy(); throw new Error(`Image download HTTP ${status}`) }
        const length = res.headers['content-length']
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > max)) {
          res.destroy(); throw new Error('Image response exceeds the byte limit')
        }
        const chunks: Buffer[] = []
        let bytes = 0
        try {
          for await (const chunk of res) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bytes += data.length
            if (bytes > max) throw new Error('Image response exceeds the byte limit')
            chunks.push(data)
          }
          resolveResult({ data: new Uint8Array(Buffer.concat(chunks, bytes)), contentType: res.headers['content-type'] })
        } catch (error) { res.destroy(); throw error }
      })().catch(reject)
    })
    req.on('error', reject)
    req.end()
  })
}
