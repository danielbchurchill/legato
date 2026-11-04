// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_CHANGED_EVENT, AccountContext, type AccountUser } from '../auth/accountContext'
import { storeSession } from '../auth/session'
import { API_BASE } from '../config/serverHost'
import { TouchLayoutContext } from '../ui/touchLayout'

/* #470: the Account panel's own card: the picture, the name, the way out.
 * The legato.fm card under it has its own specs. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const auth = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined) }))
vi.mock('../auth/useAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/useAuth')>()),
  signOut: auth.signOut,
}))
vi.mock('./LegatoAccountRow', () => ({ LegatoAccountRow: () => null }))

import { AccountSettings } from './AccountSettings'

const SAM: AccountUser = { id: 1, role: 'owner', provider: 'local', displayName: 'Sam Rivera', email: null, picture: null }
const HASH = 'ab'.repeat(20)

type Call = { method: string; path: string; body: unknown; contentType: string | null }
let calls: Call[]
let answer: (call: Call) => Response

const roots: Root[] = []

beforeEach(() => {
  localStorage.clear()
  calls = []
  answer = () => Response.json({ user: SAM })
  auth.signOut.mockClear()
  vi.stubGlobal(
    'WebSocket',
    class {
      static CLOSED = 3
      readyState = 0
      close() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        path: new URL(url).pathname.replace('/api/v1', ''),
        body: init?.body,
        contentType: new Headers(init?.headers).get('content-type'),
      }
      calls.push(call)
      return answer(call)
    }),
  )
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function render(user: AccountUser | null = SAM, touch = false) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () =>
    root.render(
      createElement(
        TouchLayoutContext.Provider,
        { value: touch },
        createElement(AccountContext.Provider, { value: user }, createElement(AccountSettings)),
      ),
    ),
  )
  return container
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null
const nameField = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[aria-label="Your name"]')

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

function changes() {
  const seen = vi.fn()
  window.addEventListener(ACCOUNT_CHANGED_EVENT, seen)
  return seen
}

describe('the picture', () => {
  it('is the initials when there is none', async () => {
    const container = await render()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('SR')
  })

  it("is the server's own copy, loaded with the media ticket", async () => {
    storeSession({ token: 'session', mediaTicket: 'ticket' })
    const container = await render({ ...SAM, picture: { hash: HASH, source: 'upload' } })
    expect(container.querySelector('img')!.getAttribute('src')).toBe(`${API_BASE}/account/pictures/${HASH}?t=ticket`)
  })

  it("falls back to the initials when it won't load", async () => {
    const container = await render({ ...SAM, picture: { hash: HASH, source: 'upload' } })
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('SR')
  })

  it('uploads a chosen file as it is, and says the account changed', async () => {
    const container = await render()
    const seen = changes()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toBe('image/*')
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'me.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(calls).toEqual([{ method: 'PUT', path: '/account/picture', body: file, contentType: 'image/jpeg' }])
    expect(seen).toHaveBeenCalledOnce()
    window.removeEventListener(ACCOUNT_CHANGED_EVENT, seen)
  })

  it("says so, and sends nothing, for a file that isn't a picture", async () => {
    const container = await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(calls).toEqual([])
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("isn't a picture")
  })

  it("shows the server's reason when it refuses one", async () => {
    answer = () => Response.json({ error: "That file isn't a picture this server can read." }, { status: 400 })
    const container = await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'odd.png', { type: 'image/png' })], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("That file isn't a picture this server can read.")
  })

  it('offers to remove only an uploaded one', async () => {
    const legato = await render({ ...SAM, picture: { hash: HASH, source: 'legato' } })
    expect(legato.textContent).toContain('picture from legato.fm')
    expect(button(legato, 'upload picture')).not.toBeNull()
    expect(button(legato, 'remove')).toBeNull()

    const uploaded = await render({ ...SAM, picture: { hash: HASH, source: 'upload' } })
    expect(button(uploaded, 'change picture')).not.toBeNull()
    await act(async () => button(uploaded, 'remove')!.click())
    expect(calls).toContainEqual({ method: 'DELETE', path: '/account/picture', body: undefined, contentType: null })
  })
})

describe('the name', () => {
  it('saves on Enter, trimmed, and says the account changed', async () => {
    const container = await render()
    const seen = changes()
    const field = nameField(container)!
    expect(field.value).toBe('Sam Rivera')
    act(() => type(field, '  Sam R.  '))
    await act(async () => press(field, 'Enter'))
    expect(calls).toEqual([{ method: 'PATCH', path: '/account', body: JSON.stringify({ displayName: 'Sam R.' }), contentType: 'application/json' }])
    expect(seen).toHaveBeenCalledOnce()
    window.removeEventListener(ACCOUNT_CHANGED_EVENT, seen)
    // Until the new name comes back, the field keeps what was typed.
    expect(field.value).toBe('  Sam R.  ')
  })

  it('saves when the field loses the focus, and not when nothing changed', async () => {
    const container = await render()
    const field = nameField(container)!
    await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(calls).toEqual([])
    act(() => type(field, 'Samantha'))
    await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(calls.map((c) => c.body)).toEqual([JSON.stringify({ displayName: 'Samantha' })])
  })

  it('goes back to the saved name on Escape, sending nothing', async () => {
    const container = await render()
    const field = nameField(container)!
    act(() => type(field, 'Nobody'))
    act(() => press(field, 'Escape'))
    expect(field.value).toBe('Sam Rivera')
    expect(calls).toEqual([])
  })

  it("keeps what was typed and says why when the server refuses it", async () => {
    answer = () => Response.json({ error: 'A name can be at most 200 characters.' }, { status: 400 })
    const container = await render()
    const field = nameField(container)!
    act(() => type(field, 'Sam'))
    await act(async () => press(field, 'Enter'))
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('A name can be at most 200 characters.')
    expect(field.value).toBe('Sam')
  })
})

it('signs out', async () => {
  const container = await render()
  await act(async () => button(container, 'sign out')!.click())
  expect(auth.signOut).toHaveBeenCalledOnce()
})

it('names the server and changes it on the desktop, where Settings no longer does', async () => {
  const container = await render()
  expect(button(container, 'change server')).not.toBeNull()
})

it("leaves the server to the phone's Settings, and gives the name field a finger's height", async () => {
  const container = await render(SAM, true)
  expect(button(container, 'change server')).toBeNull()
  expect(nameField(container)!.parentElement!.className).toContain('h-[44px]')
  expect(nameField(container)!.className).toContain('text-[16px]')
})

it('only names the user on a server too old to change the name or picture', async () => {
  const { picture: _none, ...old } = SAM
  const container = await render(old)
  expect(container.textContent).toContain('Sam Rivera')
  expect(nameField(container)).toBeNull()
  expect(container.querySelector('input[type="file"]')).toBeNull()
})
