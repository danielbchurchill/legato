// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnerGate } from './OwnerGate'
import type { AuthStatus } from './useAuth'
import type { ClaimView } from './useSetupCode'

/* Issue #237 on /setup: a claim shows whose account it is, and linking it
 * is its own button, never what the form does on Enter. */

const STATUS: AuthStatus = {
  ownerExists: false,
  setupCodeRequired: true,
  user: null,
  oauth: { google: false, github: false },
}

const ROWAN = { id: '7', name: 'Rowan', email: 'r•••@example.com' }
const SESSION = { token: 'session-token', mediaTicket: 'ticket' }

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function serve(claim: ClaimView, owner: (body: Record<string, unknown>) => Response = () => Response.json(SESSION, { status: 201 })) {
  const posted: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/auth/setup')) {
        return Response.json({ code: 'K7QM-4XRD', expiresInMs: 540_000, claimUrl: 'https://legato.fm/claim?code=K7QM-4XRD', claim })
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posted.push(body)
      return owner(body)
    }),
  )
  return posted
}

async function render() {
  const onSession = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(OwnerGate, { mode: 'create-owner', status: STATUS, theme: 'dark', onSession }))
  })
  return { container, onSession }
}

// React reads an input's value through the native setter.
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function fillPasswords(container: HTMLElement) {
  await act(async () => {
    type(container.querySelector<HTMLInputElement>('[aria-label="Password"]')!, 'correct horse battery')
    type(container.querySelector<HTMLInputElement>('[aria-label="Password again"]')!, 'correct horse battery')
  })
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

describe('OwnerGate on /setup, with a claim', () => {
  it('names the account and offers linking as its own button, with no QR', async () => {
    serve({ state: 'claimed', account: ROWAN, expiresInMs: 540_000 })
    const { container } = await render()
    expect(container.textContent).toContain('Claimed on legato.fm by Rowan (r•••@example.com).')
    expect(button(container, 'create owner').type).toBe('submit')
    expect(button(container, 'create owner and link Rowan (r•••@example.com)').type).toBe('button')
    expect(container.querySelector('svg[aria-label^="QR code"]')).toBeNull()
  })

  it("doesn't link on Enter", async () => {
    const posted = serve({ state: 'claimed', account: ROWAN, expiresInMs: 540_000 })
    const { container, onSession } = await render()
    await fillPasswords(container)
    await act(async () => {
      container.querySelector('form')!.requestSubmit()
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).not.toHaveProperty('linkAccountId')
    expect(onSession).toHaveBeenCalled()
  })

  it('sends the account it showed when linking is chosen', async () => {
    const posted = serve({ state: 'claimed', account: ROWAN, expiresInMs: 540_000 }, () =>
      Response.json({ ...SESSION, legato: { linked: { accountId: '7', name: 'Rowan' } } }, { status: 201 }),
    )
    const { container, onSession } = await render()
    await fillPasswords(container)
    await act(async () => button(container, 'create owner and link Rowan (r•••@example.com)').click())
    expect(posted[0]).toMatchObject({ linkAccountId: '7', setupCode: 'K7QM-4XRD' })
    expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ token: 'session-token' }))
  })

  it('says why when the owner was created but the account not linked, before going on', async () => {
    serve({ state: 'claimed', account: ROWAN, expiresInMs: 540_000 }, () =>
      Response.json({ ...SESSION, legato: { linked: null, error: "Couldn't reach legato.fm to record the link." } }, { status: 201 }),
    )
    const { container, onSession } = await render()
    await fillPasswords(container)
    await act(async () => button(container, 'create owner and link Rowan (r•••@example.com)').click())
    expect(container.textContent).toContain("Couldn't reach legato.fm to record the link.")
    // Issue #325: and where to link it from instead.
    expect(container.textContent).toContain('You can link it later: open Settings and choose link to legato.fm, under legato.fm account.')
    expect(onSession).not.toHaveBeenCalled()
    await act(async () => button(container, 'continue').click())
    expect(onSession).toHaveBeenCalled()
  })
})

describe('OwnerGate on /setup, before a claim', () => {
  it('shows the QR with what scanning it does, and nothing about "coming soon"', async () => {
    serve({ state: 'waiting', unreachable: false })
    const { container } = await render()
    expect(container.querySelector('svg[aria-label="QR code for https://legato.fm/claim?code=K7QM-4XRD"]')).not.toBeNull()
    expect(container.textContent).toContain('claim this server for your legato.fm account')
    expect(container.textContent).not.toContain('coming soon')
    expect(container.textContent).not.toContain('create owner and link')
  })

  it('says legato.fm is busy and the server keeps trying, rather than that it refused', async () => {
    serve({ state: 'waiting', unreachable: false, busy: true })
    const { container } = await render()
    expect(container.querySelector('svg[aria-label^="QR code"]')).not.toBeNull()
    expect(container.textContent).toContain(
      'legato.fm is busy, so a claim may take a few minutes to show up here. This server keeps trying.',
    )
    expect(container.textContent).not.toContain('refused')
  })

  it.each([
    [{ state: 'lapsed', account: ROWAN } as ClaimView, 'The claim for Rowan (r•••@example.com) lapsed before the owner was created'],
    [{ state: 'used' } as ClaimView, 'A claim of the last code ran out on legato.fm before it reached this server'],
    [{ state: 'expired' } as ClaimView, 'A claim of this code expired on legato.fm'],
  ])('explains a claim that went nowhere (%o)', async (claim, text) => {
    serve(claim)
    const { container } = await render()
    expect(container.textContent).toContain(text)
    expect(container.querySelector('svg[aria-label^="QR code"]')).not.toBeNull()
  })
})
