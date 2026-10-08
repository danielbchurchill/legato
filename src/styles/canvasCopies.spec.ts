// @vitest-environment jsdom
//
// #291: tokens.css's --color-canvas is copied by hand into every place that
// paints before tokens.css loads, or can't read it at all: index.html's
// title-bar colour, the web app manifest, the Tauri window and the three
// sign-in pages. The v2 token port moved the canvas and none of the copies
// followed. Each copy lives in a different build (Vite, tauri-build, the
// server binary, the relay's own Docker image, Rust), so rather than generate
// them, this reads every one as text and fails when it disagrees with
// tokens.css. DESIGN.md's canvas figures are checked the same way.
import { afterEach, describe, expect, it } from 'vitest'
import tokensCss from './tokens.css?raw'
import indexHtml from '../../index.html?raw'
import manifest from '../../public/manifest.webmanifest?raw'
import tauriConf from '../../src-tauri/tauri.conf.json?raw'
import serverAuth from '../../server/src/routes/auth.ts?raw'
import relayAuth from '../../relay/src/routes/auth.ts?raw'
import relayClaimPage from '../../relay/src/routes/claim-page.ts?raw'
import relaySignIn from '../../src-tauri/src/relay_sign_in.rs?raw'
import designMd from '../../DESIGN.md?raw'

type Theme = 'dark' | 'light'

// Ink is tokens.css's @theme block; paper overrides some of the same names
// under :root[data-theme='light'] and inherits the rest. Neither block nests
// braces, so each runs to the first '}'.
function block(opener: string): string {
  const start = tokensCss.indexOf(opener)
  if (start < 0) throw new Error(`tokens.css has no "${opener}" block`)
  return tokensCss.slice(start, tokensCss.indexOf('}', start))
}

const BLOCKS: Record<Theme, string[]> = {
  dark: [block('@theme {')],
  light: [block(":root[data-theme='light'] {"), block('@theme {')],
}

// A token's value for a theme, with a var() alias followed to what it names.
function token(theme: Theme, name: string): string {
  for (const css of BLOCKS[theme]) {
    const value = css.match(new RegExp(`\\s${name}:\\s*([^;]+);`))?.[1].trim()
    if (value) return value.replace(/^var\((--[\w-]+)\)$/, (_, alias: string) => token(theme, alias))
  }
  throw new Error(`tokens.css has no ${name} for ${theme}`)
}

const canvas: Record<Theme, string> = { dark: token('dark', '--color-canvas'), light: token('light', '--color-canvas') }

describe("index.html's title-bar colour", () => {
  const page = new DOMParser().parseFromString(indexHtml, 'text/html')
  const bootScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''

  afterEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    document.head.innerHTML = ''
  })

  it("starts as ink's canvas", () => {
    expect(page.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(canvas.dark)
  })

  // The same boot script useTheme.spec.tsx runs, against index.html's own meta.
  it.each(['dark', 'light'] as const)('is the %s canvas once the boot script picks that theme', (theme) => {
    localStorage.setItem('legato:theme', theme)
    const meta = page.querySelector('meta[name="theme-color"]')!.cloneNode() as HTMLMetaElement
    document.head.append(meta)
    new Function(bootScript)()
    expect(document.documentElement.dataset.theme).toBe(theme)
    expect(meta.content).toBe(canvas[theme])
  })
})

// These take one colour, whatever the theme, so they take ink's: it's the
// default with nothing stored.
describe("ink's canvas, where only one colour fits", () => {
  it('colours the installed web app', () => {
    const { background_color, theme_color } = JSON.parse(manifest)
    expect(background_color).toBe(canvas.dark)
    expect(theme_color).toBe(canvas.dark)
  })

  it('backs the desktop window before the webview paints', () => {
    const windows: { backgroundColor?: string }[] = JSON.parse(tauriConf).app.windows
    expect(windows.length).toBeGreaterThan(0)
    for (const window of windows) expect(window.backgroundColor?.toLowerCase()).toBe(canvas.dark)
  })

  // Each page's <body style="…">. The Rust one sits in a string literal, so
  // its quotes are escaped.
  it.each([
    ['server/src/routes/auth.ts', serverAuth],
    ['relay/src/routes/auth.ts', relayAuth],
    ['src-tauri/src/relay_sign_in.rs', relaySignIn],
  ])('paints the sign-in page in %s', (_file, source) => {
    const backgrounds = [...source.matchAll(/<body style=\\?"[^"]*?background(?:-color)?:\s*([^;"\\]+)/g)].map((m) => m[1].toLowerCase())
    expect(backgrounds.length).toBeGreaterThan(0)
    for (const background of backgrounds) expect(background).toBe(canvas.dark)
  })
})

// #237's claim page on the relay follows the system theme, so it carries
// both palettes as custom properties: ink in its first :root, paper in the
// one under prefers-color-scheme: light. Each must be tokens.css's value for
// the same role.
describe("the relay's claim page", () => {
  function properties(css: string): [string, string][] {
    return [...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
  }
  const ink = relayClaimPage.match(/:root \{([^}]*)\}/)?.[1] ?? ''
  const paper = relayClaimPage.match(/prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/)?.[1] ?? ''

  it.each([
    ['dark', ink],
    ['light', paper],
  ] as const)('copies the %s tokens it uses', (theme, css) => {
    const copied = properties(css)
    expect(copied.map(([name]) => name)).toContain('canvas')
    for (const [name, value] of copied) {
      const tokenName = name === 'accent-fill' ? '--accent-fill' : `--color-${name}`
      expect(value, `--${name}`).toBe(token(theme, tokenName))
    }
  })
})

describe('DESIGN.md', () => {
  function channels(color: string): number[] {
    if (color.startsWith('#')) return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16))
    return (color.match(/[\d.]+/g) ?? []).map(Number)
  }

  // Straight alpha compositing, to one decimal place as the note writes it.
  function over(surface: string, ground: string): string {
    const [r, g, b, a] = channels(surface)
    const base = channels(ground)
    const mixed = [r, g, b].map((c, i) => Math.round((c * a + base[i] * (1 - a)) * 10) / 10)
    return `rgb(${mixed.join(', ')})`
  }

  it('shows the current canvas and inset in the Color token table', () => {
    const row = (name: string) => designMd.match(new RegExp(`^\\| \`${name}\` \\| \`([^\`]+)\` \\|`, 'm'))?.[1]
    expect(row('--color-canvas')).toBe(canvas.dark)
    expect(row('--color-inset')).toBe(token('dark', '--color-inset'))
  })

  it.each([
    ['ink', 'dark'],
    ['paper', 'light'],
  ] as const)("works the Verification note's %s compositing from tokens.css", (label, theme) => {
    const cell = '`([^`]+)`'
    const row = designMd.match(new RegExp(`^\\| ${label} \\| ${cell} \\| ${cell} \\| ${cell} \\| ${cell} \\|`, 'm'))
    expect(row, `no ${label} row in DESIGN.md's Verification table`).not.toBeNull()
    const [, surface, ground, composite, solid] = row!
    expect(surface).toBe(token(theme, '--color-surface'))
    expect(ground).toBe(canvas[theme])
    expect(solid).toBe(token(theme, '--color-solid'))
    expect(composite).toBe(over(surface, ground))
  })
})
