import { describe, expect, it, vi } from 'vitest'
import { describeProbe, probeAddress, probeInBrowser, type NativeProbe } from './probe'

/* Issue #117: a custom address gets an answer specific enough to act on.
 * What the desktop app tells apart comes from src-tauri/src/probe.rs (its
 * own tests cover how); this covers the sentences, and what a browser can
 * and can't tell apart with fetch() alone. */

const ORIGIN = 'http://192.168.1.20:8899'

function fetchSequence(...steps: (Response | Error)[]) {
  const fn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const step = steps.shift()
    if (!step || step instanceof Error) throw step ?? new Error('unexpected call')
    return step
  })
  return fn
}

describe('probeInBrowser', () => {
  it('recognises a Legato server by its /health', async () => {
    const fetchImpl = fetchSequence(Response.json({ status: 'ok', name: 'musicbox', version: '0.4.0', libraryRoots: [] }))
    expect(await probeInBrowser(ORIGIN, { fetchImpl })).toEqual({ kind: 'legato', name: 'musicbox', version: '0.4.0' })
    expect(fetchImpl.mock.calls[0]).toEqual([`${ORIGIN}/api/v1/health`, expect.objectContaining({ credentials: 'omit' })])
  })

  it('says not Legato when something readable answers with anything else', async () => {
    const page = new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    expect(await probeInBrowser(ORIGIN, { fetchImpl: fetchSequence(page) })).toEqual({
      kind: 'notLegato',
      status: 200,
      contentType: 'text/html',
    })
    expect(await probeInBrowser(ORIGIN, { fetchImpl: fetchSequence(new Response('', { status: 404 })) })).toMatchObject({
      kind: 'notLegato',
      status: 404,
    })
  })

  it("tells 'something answered without CORS' from 'nothing answered', which is all fetch() can", async () => {
    // A server that sent no CORS headers: the readable request fails, the
    // opaque one succeeds. Legato always sends them, so it isn't Legato.
    const opaque = fetchSequence(new TypeError('Failed to fetch'), new Response(null, { status: 200 }))
    expect(await probeInBrowser(ORIGIN, { fetchImpl: opaque })).toEqual({ kind: 'notLegato', status: null, contentType: null })
    expect(opaque.mock.calls[1]![1]).toMatchObject({ mode: 'no-cors' })

    // DNS failure, a refusal and a bad certificate all look like this.
    const nothing = fetchSequence(new TypeError('Failed to fetch'), new TypeError('Failed to fetch'))
    expect(await probeInBrowser(ORIGIN, { fetchImpl: nothing })).toEqual({ kind: 'cantConnect' })
  })

  it('tells a silence apart, and refuses http from an https page before trying', async () => {
    const timeout = fetchSequence(new DOMException('signal timed out', 'TimeoutError'))
    expect(await probeInBrowser(ORIGIN, { fetchImpl: timeout })).toEqual({ kind: 'timeout', stage: 'connect' })
    const never = vi.fn()
    expect(await probeInBrowser(ORIGIN, { fetchImpl: never, pageProtocol: 'https:' })).toEqual({ kind: 'mixedContent' })
    expect(never).not.toHaveBeenCalled()
  })
})

describe('describeProbe', () => {
  const said = (result: NativeProbe, origin = ORIGIN) => describeProbe(result, origin)

  it('gives each failure the desktop app can tell apart its own sentence', () => {
    const sentences = [
      said({ kind: 'dns', detail: 'nodename nor servname provided' }, 'http://musicbx:8899'),
      said({ kind: 'dns', detail: 'x' }, 'http://musicbox.local:8899'),
      said({ kind: 'refused' }),
      said({ kind: 'timeout', stage: 'dns' }),
      said({ kind: 'timeout', stage: 'connect' }),
      said({ kind: 'timeout', stage: 'http' }),
      said({ kind: 'unreachable', detail: 'No route to host' }),
      said({ kind: 'tls', problem: 'untrusted', detail: '' }, 'https://music.example.com'),
      said({ kind: 'tls', problem: 'expired', detail: '' }, 'https://music.example.com'),
      said({ kind: 'tls', problem: 'wrongHost', detail: '' }, 'https://music.example.com'),
      said({ kind: 'tls', problem: 'notTls', detail: '' }, 'https://192.168.1.20:8899'),
      said({ kind: 'notLegato', status: 404, contentType: null }),
      said({ kind: 'legato', name: null, version: null }),
    ]
    expect(new Set(sentences).size).toBe(sentences.length)
    expect(sentences[0]).toBe("Couldn't find musicbx: no such name. Check the spelling.")
    expect(sentences[1]).toMatch(/\.local name only works on the same network/)
    expect(sentences[2]).toBe("192.168.1.20 is there, but nothing is answering on port 8899. Check that Legato is running on it, and on which port.")
    expect(sentences[7]).toMatch(/certificate isn't trusted/)
    expect(sentences[8]).toMatch(/certificate has expired/)
    expect(sentences[9]).toMatch(/certificate is for a different name/)
    expect(sentences[10]).toMatch(/doesn't speak https on port 8899/)
    expect(sentences[11]).toBe("Something answered at 192.168.1.20:8899, but it isn't a Legato server (it said 404). Legato listens on port 8899 unless it was changed.")
  })

  it("says plainly what a browser can't tell", () => {
    expect(describeProbe({ kind: 'cantConnect' }, ORIGIN)).toMatch(/A browser doesn't say why.*desktop app can tell which/)
  })
})

describe('probeAddress', () => {
  it('normalizes what was typed, asks the native probe when there is one, and passes on a Legato server', async () => {
    const native = vi.fn(async () => ({ kind: 'legato', name: 'musicbox', version: '0.4.0' }) as NativeProbe)
    expect(await probeAddress('192.168.1.20', { native })).toEqual({ ok: true, origin: ORIGIN, name: 'musicbox', version: '0.4.0' })
    expect(native).toHaveBeenCalledWith(ORIGIN)
  })

  it('refuses a server too old to say its version, and an address that isn\'t one', async () => {
    const native = vi.fn(async () => ({ kind: 'legato', name: null, version: null }) as NativeProbe)
    expect(await probeAddress('192.168.1.20', { native })).toMatchObject({ ok: false, kind: 'legato' })
    expect(await probeAddress('ftp://x', { native })).toMatchObject({ ok: false, kind: 'invalid', origin: null })
    expect(native).toHaveBeenCalledTimes(1)
  })
})
