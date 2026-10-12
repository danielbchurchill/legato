// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch } from './Switch'

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
  const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!
  const track = control.querySelector<HTMLElement>('.focus-ring-part')!
  return { control, track, thumb: track.firstElementChild as HTMLElement }
}

describe('Switch', () => {
  it("at the phone's size, is 51×31 with a 27px knob travelling 20px, a 44px target", () => {
    const { control, track, thumb } = render(<Switch size="xl" checked onChange={() => undefined} accessibilityLabel="Gapless" />)
    expect(track.className).toContain('h-[31px] w-[51px]')
    expect(thumb.className).toContain('size-[27px]')
    expect(thumb.style.transform).toBe('translateX(20px)')
    expect(control.className).toContain('touch-target')
  })

  it("at the phone's size, has a white knob on either track, and off is the control colour", () => {
    const on = render(<Switch size="xl" checked onChange={() => undefined} accessibilityLabel="on" />)
    const off = render(<Switch size="xl" checked={false} onChange={() => undefined} accessibilityLabel="off" />)
    expect(on.track.className).toContain('bg-[image:var(--accent-fill)]')
    expect(off.track.className).toContain('bg-[var(--color-control)]')
    for (const { thumb } of [on, off]) expect(thumb.className).toContain('bg-[#fefefe]')
    expect(off.thumb.style.transform).toBe('translateX(0px)')
  })

  it('keeps the desktop sizes as they were: off a wash with an ink-2 knob, no touch target', () => {
    const { control, track, thumb } = render(<Switch checked={false} onChange={() => undefined} accessibilityLabel="Lock" />)
    expect(track.className).toContain('bg-[var(--color-wash-2)]')
    expect(thumb.className).toContain('bg-[var(--color-ink-2)]')
    expect(control.className).not.toContain('touch-target')
  })

  it('says it changed', () => {
    const onChange = vi.fn()
    const { control } = render(<Switch size="xl" checked={false} onChange={onChange} accessibilityLabel="Gapless" />)
    act(() => control.click())
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
