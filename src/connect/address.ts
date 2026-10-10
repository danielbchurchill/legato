/* What someone types into the connect screen's address field (issue #117),
 * turned into the origin to try: "musicbox.local", "192.168.1.20:8899",
 * "https://music.example.com", a Tailscale IP.
 *
 * With no scheme it's plain http on Legato's own port, since that's how a
 * server on the LAN answers out of the box (server/src/config.ts). A typed
 * scheme is taken at its word, default port included: https://music.example.com
 * is a reverse proxy on 443, not Legato on 8899. */

export const LEGATO_PORT = '8899'

export type Address = { ok: true; origin: string; host: string; port: string } | { ok: false }

export function normalizeAddress(input: string): Address {
  const trimmed = input.trim()
  if (!trimmed || /\s/.test(trimmed)) return { ok: false }
  const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  let url: URL
  try {
    url = new URL(typedScheme ? trimmed : `http://${trimmed}`)
  } catch {
    return { ok: false }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false }
  if (!url.hostname || url.username || url.password) return { ok: false }
  if (!typedScheme && !url.port) url.port = LEGATO_PORT
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return { ok: true, origin: url.origin, host: url.hostname, port }
}

/** True for an address that only works on the local network: private IPv4
 * ranges, .local names, this machine, and IPv6 unique-local addresses. "At
 * home" on the connect screen means one of these answered (plan 03). A
 * Tailscale address (100.64.0.0/10) or a public name isn't one: it works
 * from anywhere. */
export function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.local')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h)
}

/** True for this machine: localhost, ::1 and the whole 127/8 block. The
 * folder picker (library/folderPicker.ts) and the unreachable state
 * (unreachable.ts) both ask. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare)
}

/** The origin for one address a server advertised, in URL form. */
export function originFor(address: string, port: number | string, scheme: 'http' | 'https' = 'http'): string {
  const host = address.includes(':') ? `[${address}]` : address
  return `${scheme}://${host}:${port}`
}
