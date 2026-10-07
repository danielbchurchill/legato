import { useEffect, useState } from 'react'
import { API_BASE as API } from '../config/serverHost'
import { withMediaTicket } from '../auth/session'

/* A cover's dominant colour, computed here from the thumbnail the client
 * already loads — the player's wash, the right panel's wash, and every
 * artist's glow on the map come from this, with no server work.
 *
 * "Dominant" is the plain average of a 16×16 downscale. It's muddier than a
 * clustering palette would be, which is the point: the colour sits behind
 * text and under glass at 12–40% alpha, where a saturated pick would fight
 * the type.
 *
 * Cached per image URL for the life of the page — the same cover is asked
 * for by the player, the panel and the map at once. Covers are CORS-clean
 * (the server sends Access-Control-Allow-Origin, and WebGL already depends on
 * that for the map's textures), so reading pixels doesn't taint the canvas. */

const SAMPLE_PX = 16
const cache = new Map<string, Promise<string | null>>()

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

export function sampleCoverColor(url: string): Promise<string | null> {
  const cached = cache.get(url)
  if (cached) return cached
  const pending = new Promise<string | null>((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = SAMPLE_PX
        canvas.height = SAMPLE_PX
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, SAMPLE_PX, SAMPLE_PX)
        const { data } = ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX)
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          n++
        }
        resolve(n === 0 ? null : toHex(r / n, g / n, b / n))
      } catch {
        // A tainted canvas (a cover served without CORS headers) throws on
        // getImageData; no colour is the honest answer.
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
  cache.set(url, pending)
  return pending
}

export function nodeCoverUrl(nodeId: number): string {
  return withMediaTicket(`${API}/nodes/${nodeId}/cover?size=thumb`)
}

export function hashCoverUrl(hash: string): string {
  return withMediaTicket(`${API}/covers/${hash}?size=thumb`)
}

/** The mean of several colours — an artist's glow is the average of its
 * releases' covers. */
export function averageColors(hexes: readonly string[]): string | null {
  if (hexes.length === 0) return null
  let r = 0
  let g = 0
  let b = 0
  for (const hex of hexes) {
    const n = Number.parseInt(hex.slice(1), 16)
    r += (n >> 16) & 255
    g += (n >> 8) & 255
    b += n & 255
  }
  return toHex(r / hexes.length, g / hexes.length, b / hexes.length)
}

export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`
}

/** The cover colour of a node's own art (or whatever it inherits), or null
 * until it has been sampled — callers draw nothing rather than a guess. */
export function useCoverColor(nodeId: number | null): string | null {
  const [color, setColor] = useState<{ nodeId: number; hex: string | null } | null>(null)
  useEffect(() => {
    if (nodeId == null) return
    let cancelled = false
    void sampleCoverColor(nodeCoverUrl(nodeId)).then((hex) => {
      if (!cancelled) setColor({ nodeId, hex })
    })
    return () => {
      cancelled = true
    }
  }, [nodeId])
  return color != null && color.nodeId === nodeId ? color.hex : null
}
