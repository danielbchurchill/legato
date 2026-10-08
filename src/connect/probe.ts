import { normalizeAddress } from './address'

/* Checking a typed address before connecting to it (issue #117), with an
 * answer specific enough to act on. Who can tell what apart:
 *
 *   - The desktop app (Tauri on macOS, Linux and Windows) asks Rust
 *     (src-tauri/src/probe.rs): a name that doesn't resolve, a refusal, no
 *     answer, an untrusted / expired / wrong-name certificate, https to a
 *     plain-http port, and something that isn't Legato are all different.
 *   - A browser, and the installable web app, only see fetch(), which turns
 *     DNS failure, a refusal and a TLS failure into the same TypeError. It
 *     can still tell: no answer in time; an https page that may not load an
 *     http:// address at all (mixed content); and "something answered, but
 *     it isn't Legato", by asking again with mode: 'no-cors', which succeeds
 *     on any HTTP answer and fails only when nothing answered at all. */

export type TlsProblem = 'untrusted' | 'expired' | 'wrongHost' | 'notTls' | 'other'
export type Stage = 'dns' | 'connect' | 'tls' | 'http'

/** What src-tauri/src/probe.rs's Probe serializes to. */
export type NativeProbe =
  | { kind: 'legato'; name: string | null; version: string | null }
  | { kind: 'invalid' }
  | { kind: 'dns'; detail: string }
  | { kind: 'refused' }
  | { kind: 'timeout'; stage: Stage }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'tls'; problem: TlsProblem; detail: string }
  | { kind: 'notLegato'; status: number | null; contentType: string | null }

/** The browser-only outcomes on top of those. */
export type WebProbe = { kind: 'mixedContent' } | { kind: 'cantConnect' }

export type ProbeKind = NativeProbe['kind'] | WebProbe['kind']

export type ProbeOutcome =
  | { ok: true; origin: string; name: string | null; version: string | null }
  | { ok: false; kind: ProbeKind; origin: string | null; message: string }

type HealthBody = { status?: unknown; version?: unknown; name?: unknown; libraryRoots?: unknown }

function legatoHealth(body: HealthBody | null): { name: string | null; version: string | null } | null {
  if (!body || body.status !== 'ok') return null
  if (typeof body.version !== 'string' && !Array.isArray(body.libraryRoots)) return null
  return {
    name: typeof body.name === 'string' ? body.name : null,
    version: typeof body.version === 'string' ? body.version : null,
  }
}

export type WebProbeDeps = { fetchImpl?: typeof fetch; pageProtocol?: string; timeoutMs?: number }

export async function probeInBrowser(origin: string, deps: WebProbeDeps = {}): Promise<NativeProbe | WebProbe> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pageProtocol = deps.pageProtocol ?? (typeof location === 'undefined' ? 'http:' : location.protocol)
  const timeoutMs = deps.timeoutMs ?? 8000
  if (pageProtocol === 'https:' && origin.startsWith('http:')) return { kind: 'mixedContent' }

  try {
    const res = await fetchImpl(`${origin}/api/v1/health`, { credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) })
    const body = (await res.json().catch(() => null)) as HealthBody | null
    const legato = res.ok ? legatoHealth(body) : null
    if (legato) return { kind: 'legato', ...legato }
    return { kind: 'notLegato', status: res.status, contentType: res.headers.get('content-type') }
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { kind: 'timeout', stage: 'connect' }
    }
  }
  // The answer may only have been unreadable: a server that sent no CORS
  // headers, which Legato always does. An opaque answer means something is
  // there and speaking HTTP, so it isn't a Legato server.
  try {
    await fetchImpl(`${origin}/`, { mode: 'no-cors', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) })
    return { kind: 'notLegato', status: null, contentType: null }
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { kind: 'timeout', stage: 'connect' }
    }
    return { kind: 'cantConnect' }
  }
}

const MAC = typeof navigator !== 'undefined' && /Macintosh/.test(navigator.userAgent)

export function describeProbe(result: NativeProbe | WebProbe, origin: string): string {
  const url = new URL(origin)
  const host = url.hostname
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  switch (result.kind) {
    case 'legato':
      return result.version ? `${result.name ?? host} is a Legato server.` : `${host} runs a Legato server too old to connect to. Update it first.`
    case 'invalid':
      return "That isn't an address Legato can use. Try one like 192.168.1.20, musicbox.local or https://music.example.com."
    case 'dns':
      return host.endsWith('.local')
        ? `Couldn't find ${host}. A .local name only works on the same network as the server, and on Linux only with mDNS name lookup (nss-mdns) installed. Its IP address works everywhere.`
        : `Couldn't find ${host}: no such name. Check the spelling.`
    case 'refused':
      return `${host} is there, but nothing is answering on port ${port}. Check that Legato is running on it, and on which port.`
    case 'timeout':
      return result.stage === 'dns'
        ? `Looking up ${host} took too long. Check the name, or use its IP address.`
        : result.stage === 'connect'
          ? `${host} didn't answer. It may be asleep or switched off, or a firewall is in the way.`
          : `${host} took the connection but never answered. Check the port is Legato's.`
    case 'unreachable':
      return MAC
        ? `Couldn't reach ${host} from this computer (${result.detail}). If Legato isn't allowed on the local network, macOS blocks it: System Settings → Privacy & Security → Local Network.`
        : `Couldn't reach ${host} from this computer (${result.detail}).`
    case 'tls':
      switch (result.problem) {
        case 'untrusted':
          return `${host}'s certificate isn't trusted on this computer: it's self-signed, or from an authority this computer doesn't know.`
        case 'expired':
          return `${host}'s certificate has expired. Renew it on the server.`
        case 'wrongHost':
          return `${host}'s certificate is for a different name. Use the name it was issued for.`
        case 'notTls':
          return `${host} doesn't speak https on port ${port}. If it's plain http, type http:// instead.`
        case 'other':
          return `Couldn't make a secure connection to ${host} (${result.detail}).`
      }
      break
    case 'notLegato':
      return `Something answered at ${url.host}, but it isn't a Legato server${result.status && result.status !== 200 ? ` (it said ${result.status})` : ''}. Legato listens on port 8899 unless it was changed.`
    case 'mixedContent':
      return `This page is on https, so the browser won't connect to an http:// address. Use the server's https address, or open http://${url.host} directly.`
    case 'cantConnect':
      return url.protocol === 'https:'
        ? `Couldn't connect to ${url.host}. A browser doesn't say why: the name may not exist, nothing may be listening, or its certificate isn't trusted. The Legato desktop app can tell which.`
        : `Couldn't connect to ${url.host}. A browser doesn't say why: the name may not exist, or nothing may be listening there. The Legato desktop app can tell which.`
  }
  return ''
}

export type ProbeDeps = WebProbeDeps & { native?: ((origin: string) => Promise<NativeProbe>) | null }

/** Normalizes the typed address, checks it the best way this client can,
 * and says what it found. */
export async function probeAddress(input: string, deps: ProbeDeps = {}): Promise<ProbeOutcome> {
  const address = normalizeAddress(input)
  if (!address.ok) return { ok: false, kind: 'invalid', origin: null, message: describeProbe({ kind: 'invalid' }, 'http://x') }
  const result = deps.native ? await deps.native(address.origin) : await probeInBrowser(address.origin, deps)
  if (result.kind === 'legato' && result.version) {
    return { ok: true, origin: address.origin, name: result.name, version: result.version }
  }
  return { ok: false, kind: result.kind, origin: address.origin, message: describeProbe(result, address.origin) }
}
