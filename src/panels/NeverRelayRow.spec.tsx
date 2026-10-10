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

  it("isn't offered on a page a Legato server served, which never uses the relay", async () => {
    const meta = document.createElement('meta')
    meta.name = 'legato-server'
    document.head.appendChild(meta)
    const { container } = await render()
    expect(container.textContent).toBe('')
  })
})
