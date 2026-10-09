// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Issue #325's review: the link button in Settings' legato.fm account group,
 * in the desktop app and the web client. */

const { runtime, fetchRelayMe, linkWithLegato, startBrowserLink } = vi.hoisted(() => ({
  runtime: { IS_TAURI: true },
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
  readRelaySession: () => ({ token: 'relay-session', expiresAt: '2026-11-08T00:00:00.000Z' }),
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

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(createElement(LegatoAccountRow))
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
  fetchRelayMe.mockReset().mockResolvedValue({ user: ROWAN, configured: { google: true, github: true } })
  linkWithLegato.mockReset().mockResolvedValue({ ok: true, linked: { accountId: '7', email: 'rowan@example.com', name: 'Rowan' } })
  startBrowserLink.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('linking this server from Settings', () => {
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
