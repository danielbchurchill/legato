// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Issue #325's review: the link button in Settings' legato.fm account group,
 * in the desktop app and the web client. */

const { runtime, relaySession, fetchRelayMe, linkWithLegato, startBrowserLink } = vi.hoisted(() => ({
  runtime: { IS_TAURI: true },
  relaySession: { current: null as { token: string; expiresAt: string } | null },
  fetchRelayMe: vi.fn(),
  linkWithLegato: vi.fn(),
  startBrowserLink: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))
vi.mock('../config/runtime', () => runtime)
vi.mock('../config/relayHost', () => ({ RELAY_ORIGIN: 'https://auth.legato.fm' }))
vi.mock('../auth/accountContext', () => ({
  useAccount: () => ({ role: 'owner', provider: 'local', displayName: 'Rowan', email: null }),
}))
vi.mock('../auth/relaySession', () => ({
  RelaySignInError: class extends Error {},
  clearRelaySession: vi.fn(),
  fetchRelayMe,
  readRelaySession: () => relaySession.current,
  relaySignOut: vi.fn(),
  signInWithRelay: vi.fn(),
}))
vi.mock('../connect/legatoLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connect/legatoLink')>()),
  linkWithLegato,
}))
vi.mock('../connect/legatoLinkReturn', () => ({ startBrowserLink }))

import { LegatoAccountRow } from './LegatoAccountRow'

const ROWAN = { id: 7, provider: 'github', email: 'rowan@example.com', displayName: 'Rowan', avatarUrl: null }
const SERVER_ID = '0123456789abcdef0123456789abcdef'

function serverSays(legato: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ legato: { serverId: SERVER_ID, issuer: 'https://auth.legato.fm', linked: false, linkedAccountId: null, ...legato } }),
    ),
  )
}

// Unmounted after each test: a signed-in row also lists the account's
// sessions and servers (#115), and an earlier test's fetch answering after
// its body was cleared would re-render into nodes that are gone.
const roots: Root[] = []

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(LegatoAccountRow))
  })
  return container
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

beforeEach(() => {
  // jsdom has no matchMedia; the confirm dialog asks it about reduced motion.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
  runtime.IS_TAURI = true
  relaySession.current = { token: 'relay-session', expiresAt: '2026-11-08T00:00:00.000Z' }
  fetchRelayMe.mockReset().mockResolvedValue({ user: ROWAN, configured: { google: true, github: true } })
  linkWithLegato.mockReset().mockResolvedValue({ ok: true, linked: { accountId: '7', email: 'rowan@example.com', name: 'Rowan' } })
  startBrowserLink.mockReset()
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('linking this server from Settings', () => {
  it('asks before the desktop app links its account in place of a different one', async () => {
    serverSays({ linked: true, linkedAccountId: '9' })
    await render()
    await act(async () => button('link again').click())
    expect(linkWithLegato).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'This server is linked to another legato.fm account. Link it to Rowan (rowan@example.com) instead? The other account will stop opening it.',
    )

    await act(async () => button('link instead').click())
    expect(linkWithLegato).toHaveBeenCalledWith(SERVER_ID)
    expect(document.body.textContent).toContain('Linked this server to Rowan on legato.fm.')
  })

  it("links again without asking when it's the account already linked", async () => {
    serverSays({ linked: true, linkedAccountId: '7' })
    await render()
    await act(async () => button('link again').click())
    expect(linkWithLegato).toHaveBeenCalledWith(SERVER_ID)
    expect(document.body.textContent).not.toContain('link a different account')
  })

  // Issue #115: the account removed the server on legato.fm, or its
  // credential ran out, and a new link is the way back.
  it('says the server was disconnected from legato.fm, and offers to link it again', async () => {
    serverSays({ linked: true, linkedAccountId: '7', tunnel: 'refused' })
    const container = await render()
    expect(container.textContent).toContain('Disconnected from legato.fm. Link it again to reach it through legato.fm.')
    await act(async () => button('link again').click())
    expect(linkWithLegato).toHaveBeenCalledWith(SERVER_ID)
  })

  it('says nothing about a tunnel that is only reconnecting', async () => {
    serverSays({ linked: true, linkedAccountId: '7', tunnel: 'waiting' })
    const container = await render()
    expect(container.textContent).toContain('This server is linked to legato.fm.')
    expect(container.textContent).not.toContain('Disconnected')
  })

  it('says why instead of offering a link the desktop app would get refused', async () => {
    serverSays({ issuer: 'https://id.example.net' })
    const container = await render()
    expect(container.textContent).toContain(
      "It uses legato.fm at id.example.net, and this app signs in at auth.legato.fm, so it can't link it from here.",
    )
    expect(() => button('link to legato.fm')).toThrow()
  })

  it('is ready to link again when the browser brings the page back from its back-forward cache', async () => {
    runtime.IS_TAURI = false
    serverSays({})
    await render()
    await act(async () => button('link to legato.fm').click())
    expect(startBrowserLink).toHaveBeenCalledWith(SERVER_ID, 'https://auth.legato.fm')
    expect(button('linking…').disabled).toBe(true)

    // A pageshow that isn't a restore changes nothing.
    await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false })))
    expect(button('linking…').disabled).toBe(true)
    await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })))
    expect(button('link to legato.fm').disabled).toBe(false)
  })
})

describe('a linked server while the app is signed out of legato.fm (#361)', () => {
  beforeEach(() => {
    relaySession.current = null
    fetchRelayMe.mockResolvedValue({ user: null, configured: { google: true, github: true } })
  })

  it('says the server is linked, and that signing in is how to link it again', async () => {
    serverSays({ linked: true, linkedAccountId: '7' })
    const container = await render()
    expect(container.textContent).toContain('This server is linked to legato.fm. Sign in to legato.fm to link it again.')
    expect(() => button('link again')).toThrow()
  })

  it("still says signing in is how to link a server that isn't linked yet", async () => {
    serverSays({})
    const container = await render()
    expect(container.textContent).toContain("This server isn't linked to a legato.fm account yet. Sign in to legato.fm to link it.")
  })

  it('in the web client, which has no legato.fm sign-in, offers to link it again', async () => {
    runtime.IS_TAURI = false
    serverSays({ linked: true, linkedAccountId: '7' })
    const container = await render()
    expect(container.textContent).toContain('This server is linked to legato.fm.')
    expect(container.textContent).not.toContain('Sign in to legato.fm')
    expect(button('link again').disabled).toBe(false)
  })

  it('keeps saying whose account a link from this visit went to, once the app signs out', async () => {
    relaySession.current = { token: 'relay-session', expiresAt: '2026-11-08T00:00:00.000Z' }
    fetchRelayMe.mockResolvedValue({ user: ROWAN, configured: { google: true, github: true } })
    serverSays({ linked: true, linkedAccountId: '7' })
    const container = await render()
    await act(async () => button('link again').click())
    expect(container.textContent).toContain('Linked this server to Rowan on legato.fm.')

    await act(async () => button('sign out').click())
    expect(container.textContent).toContain('This server is linked to legato.fm. Sign in to legato.fm to link it again.')
    expect(container.textContent).toContain('Linked this server to Rowan on legato.fm.')
  })

  it('names the account by its email when legato.fm has no name for it', async () => {
    relaySession.current = { token: 'relay-session', expiresAt: '2026-11-08T00:00:00.000Z' }
    fetchRelayMe.mockResolvedValue({ user: ROWAN, configured: { google: true, github: true } })
    linkWithLegato.mockResolvedValue({ ok: true, linked: { accountId: '7', email: 'rowan@example.com', name: null } })
    serverSays({ linked: true, linkedAccountId: '7' })
    const container = await render()
    await act(async () => button('link again').click())
    await act(async () => button('sign out').click())
    expect(container.textContent).toContain('Linked this server to rowan@example.com on legato.fm.')
  })
})
