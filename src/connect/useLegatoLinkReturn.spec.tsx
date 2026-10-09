// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui/Toast'
import { useLegatoLinkReturn } from './useLegatoLinkReturn'

/* Issue #325's review: what the owner sees when the web client comes back
 * from legato.fm, and that a code legato.fm didn't settle can be tried
 * again from the toast. */

const ISSUER = 'http://127.0.0.1:8912'

function Finisher() {
  useLegatoLinkReturn(true)
  return null
}

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(createElement(ToastProvider, null, createElement(Finisher)))
  })
  return container
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })),
  )
})

afterEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('coming back from legato.fm', () => {
  it('offers to try the same code again after a rate limit, and links with it', async () => {
    sessionStorage.setItem('legato:link-pending', JSON.stringify({ issuer: ISSUER, verifier: 'v'.repeat(43), code: 'the-code' }))
    const answers = [
      Response.json(
        { error: 'Too many failed link attempts from this address. Try again in 60 seconds.', reason: 'rate_limited' },
        { status: 429 },
      ),
      Response.json({ token: 'link.jws.token', expiresAt: '2026-10-09T12:10:00.000Z', scope: 'link' }),
    ]
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/link/redeem') ? answers.shift()! : Response.json({ linked: { accountId: '7', email: null, name: 'Rowan' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await render()
    expect(document.body.textContent).toContain("couldn't link to legato.fm")
    expect(document.body.textContent).toContain('Try again in 60 seconds.')

    await act(async () => button('try again').click())
    expect(document.body.textContent).toContain('This server is linked to Rowan.')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/link/redeem'))).toHaveLength(2)
  })

  it('offers nothing to retry once legato.fm has refused the code', async () => {
    sessionStorage.setItem('legato:link-pending', JSON.stringify({ issuer: ISSUER, verifier: 'v'.repeat(43), code: 'late' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'This link code expired.', reason: 'expired' }, { status: 400 })),
    )
    await render()
    expect(document.body.textContent).toContain('This link code expired.')
    expect(() => button('try again')).toThrow()
  })

})
