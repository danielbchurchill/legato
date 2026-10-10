// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Issue #115: the desktop app's legato.fm account, where it's signed in and
 * the servers it has linked, in Settings. */

vi.mock('../config/relayHost', () => ({ RELAY_ORIGIN: 'https://auth.legato.fm' }))

import { LegatoAccountDevices } from './LegatoAccountDevices'

const SERVER_A = '0123456789abcdef0123456789abcdef'
const SERVER_B = 'fedcba9876543210fedcba9876543210'

type Call = { method: string; url: string; auth: string | null }

function relaySays(answers: Record<string, () => Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET'
      calls.push({ method, url, auth: new Headers(init.headers).get('authorization') })
      const answer = answers[`${method} ${url.replace('https://auth.legato.fm', '')}`]
      return answer ? answer() : Response.json({ error: 'unexpected' }, { status: 500 })
    }),
  )
  return calls
}

const LISTS = {
  'GET /auth/sessions': () =>
    Response.json({
      sessions: [
        {
          id: '3',
          client: 'Legato app on macOS',
          createdAt: '2026-10-09T10:00:00.000Z',
          lastSeenAt: '2026-10-10T09:00:00.000Z',
          current: true,
        },
        {
          id: '2',
          client: 'Firefox on Linux',
          createdAt: '2026-10-01T10:00:00.000Z',
          lastSeenAt: '2026-10-08T21:30:00.000Z',
          current: false,
        },
        { id: '1', client: null, createdAt: '2026-09-20T10:00:00.000Z', lastSeenAt: null, current: false },
      ],
    }),
  'GET /linked-servers': () =>
    Response.json({
      servers: [
        {
          serverId: SERVER_A,
          linkedAt: '2026-09-01T00:00:00.000Z',
          tunnel: { connected: true, connectedAt: '2026-10-10T08:00:00.000Z' },
          credentialIssuedAt: '2026-10-01T12:00:00.000Z',
        },
        {
          serverId: SERVER_B,
          linkedAt: '2026-09-02T00:00:00.000Z',
          tunnel: { connected: false, lastSeenAt: null },
          credentialIssuedAt: null,
        },
      ],
    }),
}

// Unmounted after each test, so an earlier one's listeners don't answer a
// later one's events.
const roots: Root[] = []

async function render(onSignedOut = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(LegatoAccountDevices, { token: 'relay-session', onSignedOut }))
  })
  return container
}

function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

function row(text: string): HTMLElement {
  const found = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(text))
  if (!found) throw new Error(`no row with "${text}"`)
  return found
}

const lines = (li: HTMLElement) => [...li.querySelectorAll('p')].map((p) => p.textContent)

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  localStorage.setItem(
    'legato:known-servers',
    JSON.stringify({ [SERVER_A]: { name: 'musicbox', lanOrigin: null, lastReachedAt: '2026-10-10T08:00:00.000Z' } }),
  )
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('the account in Settings', () => {
  it('lists where it is signed in, with this device marked, and the servers with their tunnel and credential', async () => {
    const calls = relaySays(LISTS)
    const container = await render()
    expect(calls.every((call) => call.auth === 'Bearer relay-session')).toBe(true)

    expect(row('Legato app on macOS').textContent).toContain('this device')
    expect(() => button('sign out', row('Legato app on macOS'))).toThrow()
    expect(row('Firefox on Linux').textContent).toContain('last seen')
    expect(row('An earlier sign-in').textContent).toContain('signed in')

    expect(lines(row('musicbox'))).toEqual(['musicbox', 'connected', 'credential from Oct 1'])
    // Never reached from this device, so legato.fm's id is all there is.
    expect(lines(row('fedcba98…'))).toEqual(['fedcba98…', 'never connected', 'no credential'])
    expect(container.textContent).not.toContain(SERVER_B)
  })

  it('signs another session out, then lists again', async () => {
    const calls = relaySays({ ...LISTS, 'DELETE /auth/sessions/2': () => Response.json({ revoked: true }) })
    await render()
    await act(async () => button('sign out', row('Firefox on Linux')).click())
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain('DELETE https://auth.legato.fm/auth/sessions/2')
    expect(calls.filter((call) => call.url.endsWith('/auth/sessions') && call.method === 'GET')).toHaveLength(2)
  })

  it('asks before removing a server, and says what that does', async () => {
    const calls = relaySays({ ...LISTS, [`DELETE /linked-servers/${SERVER_A}`]: () => Response.json({ unlinked: true }) })
    await render()
    await act(async () => button('remove', row('musicbox')).click())
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(document.body.textContent).toContain(
      "musicbox won't open from this legato.fm account any more, and its connection to legato.fm closes. Its owner can link it again from its Settings.",
    )
    await act(async () => button('remove', document.querySelector('[role="alertdialog"]') ?? document).click())
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(`DELETE https://auth.legato.fm/linked-servers/${SERVER_A}`)
  })

  it('lists again when a link finishes, so a server linked again is back', async () => {
    const calls = relaySays(LISTS)
    await render()
    await act(async () => window.dispatchEvent(new Event('legato:link-changed')))
    expect(calls.filter((call) => call.url.endsWith('/linked-servers'))).toHaveLength(2)
  })

  it('hands back to the account row when legato.fm says the session ended', async () => {
    relaySays({
      'GET /auth/sessions': () => Response.json({ error: 'Sign in to legato.fm first.', reason: 'signed_out' }, { status: 401 }),
    })
    const onSignedOut = vi.fn()
    await render(onSignedOut)
    expect(onSignedOut).toHaveBeenCalledWith('Your legato.fm session ended. Sign in again.')
  })

  it("says so, with a way to try again, when legato.fm can't list them", async () => {
    relaySays({
      'GET /auth/sessions': () => Response.json({ message: 'Route GET:/auth/sessions not found', error: 'Not Found' }, { status: 404 }),
      'GET /linked-servers': LISTS['GET /linked-servers'],
    })
    const container = await render()
    expect(container.textContent).toContain('legato.fm answered 404. Try again in a moment.')
    expect(button('try again')).toBeTruthy()
  })
})
