/** Network boundary for URLs supplied by an image provider. */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent } from 'undici'

const nonPublicV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublicV4.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const nonPublicV6 = new BlockList()
nonPublicV6.addSubnet('2001::', 23, 'ipv6')
nonPublicV6.addSubnet('2001:db8::', 32, 'ipv6')
nonPublicV6.addSubnet('2002::', 16, 'ipv6')
const localAddresses = new BlockList()
for (const [address, prefix] of [['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) localAddresses.addSubnet(address, prefix, 'ipv4')
localAddresses.addAddress('::1', 'ipv6')
localAddresses.addSubnet('fc00::', 7, 'ipv6')

function hostname(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
}

function isPublic(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !nonPublicV4.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !nonPublicV6.check(address, 'ipv6')
}

function explicitlyConfiguredLocal(target: URL, base: URL, address: string): boolean {
  if (target.origin !== base.origin) return false
  const configured = hostname(base)
  if (configured === 'localhost') return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))
  const family = isIP(configured)
  return family !== 0 && configured === address && localAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

async function resolvedAddresses(url: URL, signal: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  signal.throwIfAborted()
  const host = hostname(url), family = isIP(host)
  if (family !== 0) return [{ address: host, family }]
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([lookup(host, { all: true, verbatim: true }), aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

/**
 * Validate every redirect and pin the checked DNS addresses to the socket.
 * Local URLs are allowed only on an explicitly configured local provider origin.
 * Authorization is recomputed at every hop and never sent to another origin.
 */
export async function fetchProviderImage(
  value: string,
  input: { baseURL: string; signal: AbortSignal; apiKey?: string },
): Promise<Response> {
  const base = new URL(input.baseURL)
  let target = new URL(value, base)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!['http:', 'https:'].includes(target.protocol) || target.username !== '' || target.password !== '') throw new Error('Blocked image download URL')
    const addresses = await resolvedAddresses(target, input.signal)
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublic(address) && !explicitlyConfiguredLocal(target, base, address))) throw new Error('Blocked private image download target')
    const pinnedLookup: LookupFunction = (_host, options, callback) => {
      const first = addresses[0]!
      if (options.all) callback(null, addresses)
      else callback(null, first.address, first.family)
    }
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup }, connections: 1, pipelining: 0 })
    let response: Response
    try {
      const options: RequestInit & { dispatcher: Agent } = {
        dispatcher, redirect: 'manual', signal: input.signal,
        ...(input.apiKey === undefined || target.origin !== base.origin ? {} : { headers: { authorization: 'Bearer ' + input.apiKey } }),
      }
      response = await fetch(target.toString(), options)
    } catch (error) {
      await dispatcher.destroy().catch(() => undefined)
      throw error
    }
    // Graceful close waits for the caller to consume/cancel the response body.
    void dispatcher.close().catch(() => undefined)
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null || redirects === 5) throw new Error('Image download redirect limit exceeded')
    const next = new URL(location, target)
    if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Blocked insecure image download redirect')
    target = next
  }
  throw new Error('Image download redirect limit exceeded')
}
