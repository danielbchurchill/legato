// Issue #119: the unreachable state's "likely why", worked out from the
// path that failed, how the check failed, when the server last answered and
// whether this device's network changed since.
import { describe, expect, it } from 'vitest'
import {
  ASLEEP_WITHIN_MS,
  classifyFailure,
  describeOutage,
  inferReason,
  outageFailure,
  outageFooter,
  pathFor,
  type OutageFacts,
  type ServerPath,
  type UnreachableReason,
} from './unreachable'

const NOW = Date.parse('2026-10-09T14:30:00Z')
const MINUTE = 60_000

function facts(overrides: Partial<OutageFacts> = {}): OutageFacts {
  return {
    path: 'home',
    failure: { kind: 'no-answer' },
    lastSeenAt: NOW - 2 * MINUTE,
    networkChangedAt: null,
    deviceOnline: true,
    ...overrides,
  }
}

describe('pathFor', () => {
  it('tells this computer, the home network and anywhere else apart', () => {
    expect(pathFor('http://127.0.0.1:8899', true)).toBe('embedded')
    expect(pathFor('http://127.0.0.1:8905', false)).toBe('this-device')
    expect(pathFor('http://localhost:8899', false)).toBe('this-device')
    expect(pathFor('http://[::1]:8899', false)).toBe('this-device')
    expect(pathFor('http://192.168.1.20:8899', false)).toBe('home')
    expect(pathFor('http://musicbox.local:8899', false)).toBe('home')
    expect(pathFor('http://[fd12:3456::1]:8899', false)).toBe('home')
    expect(pathFor('http://100.101.102.103:8899', false)).toBe('custom')
    expect(pathFor('https://music.example.com', false)).toBe('custom')
  })

  it("only calls a loopback server the desktop app's own when the app started it", () => {
    // The desktop app's default can point at another machine (a .env.local
    // baked into the build); that's still a server elsewhere.
    expect(pathFor('http://192.168.1.20:8899', true)).toBe('home')
  })
})

describe('classifyFailure', () => {
  it('reads a fast failure as refused, and a slow one or a timeout as no answer', () => {
    expect(classifyFailure({ elapsedMs: 12, timedOut: false })).toEqual({ kind: 'refused' })
    expect(classifyFailure({ elapsedMs: 3200, timedOut: false })).toEqual({ kind: 'no-answer' })
    expect(classifyFailure({ elapsedMs: 4000, timedOut: true })).toEqual({ kind: 'no-answer' })
  })
})

// The coordinator's review of #346: a sleeping LAN host's reason swapped
// between "asleep" and "stopped" with every check.
describe('outageFailure', () => {
  const refused = { kind: 'refused' } as const
  const silence = { kind: 'no-answer' } as const
  const proxy = { kind: 'bad-status', status: 502 } as const

  it('starts from the first failure', () => {
    expect(outageFailure(null, refused)).toEqual(refused)
  })

  it('keeps silence once an outage has seen it, whatever the checks after it say', () => {
    let sofar = outageFailure(null, silence)
    for (const latest of [refused, silence, refused, proxy, refused]) {
      sofar = outageFailure(sofar, latest)
      expect(inferReason(facts({ failure: sofar }), NOW)).toBe('asleep')
    }
  })

  it('moves up from a refusal to silence once, and stays', () => {
    expect(outageFailure(refused, proxy)).toEqual(proxy)
    expect(outageFailure(proxy, refused)).toEqual(proxy)
    expect(outageFailure(proxy, silence)).toEqual(silence)
  })
})

describe('inferReason', () => {
  it('says asleep when a server seen a moment ago stops answering', () => {
    expect(inferReason(facts(), NOW)).toBe('asleep')
    expect(inferReason(facts({ path: 'custom' }), NOW)).toBe('asleep')
  })

  it('says offline once the last answer is older than the asleep window, or never came', () => {
    expect(inferReason(facts({ lastSeenAt: NOW - ASLEEP_WITHIN_MS + MINUTE }), NOW)).toBe('asleep')
    expect(inferReason(facts({ lastSeenAt: NOW - ASLEEP_WITHIN_MS }), NOW)).toBe('offline')
    expect(inferReason(facts({ lastSeenAt: NOW - 3 * 24 * 60 * MINUTE }), NOW)).toBe('offline')
    expect(inferReason(facts({ lastSeenAt: null }), NOW)).toBe('offline')
  })

  it('says stopped when the machine turned the connection away, or something else answered', () => {
    expect(inferReason(facts({ failure: { kind: 'refused' } }), NOW)).toBe('stopped')
    expect(inferReason(facts({ failure: { kind: 'bad-status', status: 502 } }), NOW)).toBe('stopped')
  })

  it('says this device is offline before guessing anything about the server', () => {
    expect(inferReason(facts({ deviceOnline: false, failure: { kind: 'refused' } }), NOW)).toBe('device-offline')
    expect(inferReason(facts({ deviceOnline: false, networkChangedAt: NOW - MINUTE }), NOW)).toBe('device-offline')
  })

  it('says the network changed when it changed after the server last answered', () => {
    expect(inferReason(facts({ networkChangedAt: NOW - MINUTE }), NOW)).toBe('network-changed')
    expect(inferReason(facts({ networkChangedAt: NOW - MINUTE, failure: { kind: 'refused' } }), NOW)).toBe('network-changed')
    expect(inferReason(facts({ path: 'custom', networkChangedAt: NOW - MINUTE }), NOW)).toBe('network-changed')
  })

  it("doesn't blame a network change the server answered after", () => {
    expect(inferReason(facts({ networkChangedAt: NOW - 5 * MINUTE }), NOW)).toBe('asleep')
    // Nothing to compare it with: no answer ever came on any network.
    expect(inferReason(facts({ networkChangedAt: NOW - MINUTE, lastSeenAt: null }), NOW)).toBe('offline')
  })

  it("never calls this computer's server asleep, offline or cut off by the network", () => {
    for (const path of ['embedded', 'this-device'] as const) {
      expect(inferReason(facts({ path }), NOW)).toBe('not-responding')
      expect(inferReason(facts({ path, lastSeenAt: null }), NOW)).toBe('not-responding')
      expect(inferReason(facts({ path, failure: { kind: 'refused' } }), NOW)).toBe('stopped')
      expect(inferReason(facts({ path, failure: { kind: 'refused' }, deviceOnline: false }), NOW)).toBe('stopped')
      expect(inferReason(facts({ path, failure: { kind: 'refused' }, networkChangedAt: NOW - MINUTE }), NOW)).toBe('stopped')
    }
  })
})

describe('describeOutage', () => {
  const ctx = {
    path: 'home' as ServerPath,
    name: 'musicbox',
    host: '192.168.1.20:8899',
    lastSeenAt: NOW - 2 * MINUTE,
    everConnected: true,
    now: NOW,
  }

  it('names the server in the title, by its own name, else its address', () => {
    expect(describeOutage('asleep', ctx).title).toBe("Can't reach musicbox")
    expect(describeOutage('asleep', { ...ctx, name: null }).title).toBe("Can't reach 192.168.1.20:8899")
    expect(describeOutage('stopped', { ...ctx, path: 'embedded' }).title).toBe("Can't reach this computer's server")
  })

  it('gives every reason on every path a sentence of its own', () => {
    const reasons: UnreachableReason[] = ['device-offline', 'network-changed', 'stopped', 'not-responding', 'asleep', 'offline']
    const paths: ServerPath[] = ['embedded', 'this-device', 'home', 'custom']
    for (const reason of reasons) {
      for (const path of paths) {
        const copy = describeOutage(reason, { ...ctx, path })
        expect(copy.why.length).toBeGreaterThan(0)
        expect(copy.why).not.toContain('undefined')
        expect(copy.why).not.toContain('null')
      }
    }
    const whys = reasons.map((reason) => describeOutage(reason, ctx).why)
    expect(new Set(whys).size).toBe(reasons.length)
  })

  it('says when it was last reached, and something different when it never was', () => {
    expect(describeOutage('asleep', ctx).why).toMatch(/^musicbox stopped answering at .+\. It's probably asleep/)
    expect(describeOutage('offline', { ...ctx, lastSeenAt: NOW - 2 * 24 * 60 * MINUTE }).why).toMatch(/^musicbox has been offline since /)
    expect(describeOutage('offline', { ...ctx, lastSeenAt: null }).why).toBe(
      "musicbox hasn't answered this device yet. Check that it's switched on and on this network.",
    )
  })

  it("points a sleeping server's owner at keep-awake", () => {
    expect(describeOutage('asleep', ctx).hint).toContain('Settings → serving → awake')
    expect(describeOutage('stopped', ctx).hint).not.toContain('awake')
  })

  it("tells the desktop app's own server stopping apart from it not having started yet", () => {
    expect(describeOutage('stopped', { ...ctx, path: 'embedded' }).why).toBe("Legato's server on this computer stopped.")
    // Pausing serving from the tray stops it too, and the tray starts it again.
    expect(describeOutage('stopped', { ...ctx, path: 'embedded' }).hint).toContain("resume it from Legato's icon")
    expect(describeOutage('stopped', { ...ctx, path: 'embedded', everConnected: false }).why).toBe(
      "Legato's server on this computer hasn't started.",
    )
  })

  it('says why a home address stops working on another network', () => {
    expect(describeOutage('network-changed', ctx).why).toContain('only works on your home network')
    expect(describeOutage('network-changed', { ...ctx, path: 'custom' }).hint).toContain('Tailscale')
  })
})

describe('outageFooter', () => {
  it('says the client keeps trying, and that a manual try ran', () => {
    expect(outageFooter({ everConnected: true, triedAt: null })).toBe(
      "Legato keeps trying, and carries on where you left off once it's back.",
    )
    expect(outageFooter({ everConnected: false, triedAt: null })).toBe("Legato keeps trying, and opens once it's back.")
    expect(outageFooter({ everConnected: true, triedAt: NOW })).toMatch(/^Tried again at .+\. Legato keeps trying/)
  })
})
