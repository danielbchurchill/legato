// @vitest-environment jsdom
// Issue #118: the "never use the relay" setting.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const roots: Root[] = []

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

// A fresh module graph per test: whether a server served the page is read
// once, as serverHost.ts loads.
async function render() {
  vi.resetModules()
  const { NeverRelayRow } = await import('./NeverRelayRow')
  const connection = await import('../connect/connectionPath')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(NeverRelayRow)))
  return { container, connection, toggle: () => container.querySelector<HTMLButtonElement>('[role="switch"]') }
}

describe('NeverRelayRow', () => {
  it('is off until turned on, and keeps the pin on this device', async () => {
    const { toggle, connection } = await render()
    expect(toggle()!.getAttribute('aria-checked')).toBe('false')
    act(() => toggle()!.click())
    expect(toggle()!.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('legato:never-relay')).toBe('true')
    expect(connection.neverUseRelay()).toBe(true)
    act(() => toggle()!.click())
    expect(localStorage.getItem('legato:never-relay')).toBeNull()
  })

  it('shows the pin this device already has', async () => {
    localStorage.setItem('legato:never-relay', 'true')
    const { toggle } = await render()
    expect(toggle()!.getAttribute('aria-checked')).toBe('true')
  })

  // Issue #391: since #365 a page a server served can take its own server's
  // route through legato.fm, and the pin is what keeps it off that route.
  it('is offered on a page a Legato server served, and keeps that page off its relay route', async () => {
    const id = '0123456789abcdef0123456789abcdef'
    for (const [name, content] of [
      ['legato-server', 'same-origin'],
      ['legato-server-id', id],
    ]) {
      const meta = document.createElement('meta')
      meta.name = name
      meta.content = content
      document.head.appendChild(meta)
    }
    // This server, picked on the connect screen through legato.fm.
    localStorage.setItem('legato:server-choice', `https://auth.legato.fm/relay/${id}`)

    const { toggle } = await render()
    const before = await import('../config/serverHost')
    expect(before.SERVED_BY_SERVER).toBe(true)
    expect(before.RELAY_SERVER_ID).toBe(id)
    expect(toggle()).not.toBeNull()

    // Turned on while on the relay route, the pin reloads the page
    // (connectionPath.ts, whose spec checks that), and the reloaded page
    // resolves its server again as it loads.
    act(() => toggle()!.click())
    expect(localStorage.getItem('legato:never-relay')).toBe('true')

    vi.resetModules()
    const after = await import('../config/serverHost')
    expect(after.SERVER_ORIGIN).toBe(window.location.origin)
    expect(after.RELAY_SERVER_ID).toBeNull()
  })
})
