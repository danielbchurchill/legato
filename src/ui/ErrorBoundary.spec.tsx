// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, RenderError } from './ErrorBoundary'

let shouldThrow = true

function Fragile() {
  if (shouldThrow) throw new Error('node.files is undefined')
  return <p>drawn</p>
}

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let resetBoundary: () => void = () => {}
  await act(async () => {
    createRoot(container).render(
      <ErrorBoundary
        fallback={(error, reset) => {
          resetBoundary = reset
          return <RenderError title="This panel couldn't be drawn." error={error} />
        }}
      >
        <Fragile />
      </ErrorBoundary>,
    )
  })
  return { container, reset: () => resetBoundary() }
}

beforeEach(() => {
  shouldThrow = true
  // React and the boundary both report the caught error; the test asserts
  // on what's drawn instead.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ErrorBoundary', () => {
  it('draws the fallback with the error instead of unmounting', async () => {
    const { container } = await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('node.files is undefined')
  })

  it('draws the children again after a reset once the cause has gone', async () => {
    const { container, reset } = await render()
    shouldThrow = false
    await act(async () => reset())
    expect(container.textContent).toBe('drawn')
  })
})
