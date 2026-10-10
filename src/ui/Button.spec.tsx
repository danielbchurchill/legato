// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from './Button'

const roots: Root[] = []

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ''
})

function render(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return container.querySelector('button')!
}

describe('Button', () => {
  it('always has a name: a label, or an icon and an aria-label', () => {
    // tsc checks these. An empty pill, and an icon with nothing to name it, don't compile.
    // @ts-expect-error a pill with no label
    void (<Button variant="primary" />)
    // @ts-expect-error an icon alone with no aria-label
    void (<Button variant="primary" icon="arrow-swap" />)

    expect(render(<Button variant="primary">Shuffle library</Button>).textContent).toBe('Shuffle library')
    const iconAlone = render(<Button variant="primary" icon="arrow-swap" aria-label="Shuffle library" />)
    expect(iconAlone.getAttribute('aria-label')).toBe('Shuffle library')
    // A circle: as wide as the pill is tall.
    expect(iconAlone.classList).toContain('aspect-square')
  })
})
