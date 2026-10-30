// #408: one track's audio for the tape, fetched and cut into whole pieces.
// The server is a fake fetch over a hand-built fragmented MP4 whose boxes
// say what they are, so every piece handed on can be checked by name.
import { describe, expect, it, vi } from 'vitest'
import { BoxSplitter, MAX_RESUMES, openTrackFeed, TrackUnavailable, WINDOW_BYTES, type FeedDeps, type FragmentIndex } from './trackFeed'

function box(type: string, payload: Uint8Array | number = 0): Uint8Array {
  const body = typeof payload === 'number' ? new Uint8Array(payload).fill(0x61) : payload
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  )
  out.set(body, 8)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const fourcc = (bytes: Uint8Array, at = 4) => String.fromCharCode(...bytes.subarray(at, at + 4))

// ftyp, moov, then `count` fragments of `size` bytes each, then mfra.
function fragmentedMp4(count: number, size = 1000) {
  const init = concat([box('ftyp', 16), box('moov', 200)])
  const fragments = Array.from({ length: count }, (_, i) => concat([box('moof', new Uint8Array([i, 0, 0, 0])), box('mdat', size)]))
  const file = concat([init, ...fragments, box('mfra', 30)])
  let offset = init.length
  const index: FragmentIndex = {
    codecs: 'fLaC',
    initEnd: init.length,
    fragments: fragments.map((fragment, i) => {
      const entry = { offset, time: i }
      offset += fragment.length
      return entry
    }),
    end: offset,
  }
  return { file, init, fragments, index }
}

// Which fragment a piece is: the byte the fake put in its moof.
const fragmentNumber = (piece: Uint8Array) => (fourcc(piece) === 'moof' ? piece[8] : -1)

function chunked(bytes: Uint8Array, sizes: number[], failAfter?: number): ReadableStream<Uint8Array> {
  let at = 0
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && at >= failAfter) {
        controller.error(new TypeError('network connection was lost'))
        return
      }
      if (at >= bytes.length) {
        controller.close()
        return
      }
      const size = sizes[i++ % sizes.length]
      const end = failAfter !== undefined ? Math.min(at + size, failAfter) : at + size
      controller.enqueue(bytes.slice(at, end))
      at = end
    },
  })
}

type Served = { url: string; range: string | null }

function deps(
  handler: (url: string, range: string | null, attempt: number) => Response | Promise<Response>,
  overrides: Partial<FeedDeps> = {},
) {
  const served: Served[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const range = new Headers(init?.headers).get('Range')
    served.push({ url, range })
    return handler(url, range, served.length)
  })
  const value: FeedDeps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    isTypeSupported: () => true,
    retryAfter: vi.fn(async () => undefined),
    serverTrouble: vi.fn(async () => 'none' as const),
    ...overrides,
  }
  return { deps: value, served }
}

function rangeOf(header: string | null, size: number): [number, number] {
  const [start, end] = header!.slice(6).split('-')
  return [Number(start), end === '' ? size - 1 : Number(end)]
}

function serveFile(file: Uint8Array, index: FragmentIndex, type = 'audio/mp4; codecs="fLaC"') {
  return (url: string, range: string | null) => {
    if (url.includes('/stream/index')) return Response.json(index)
    if (!range) return new Response(file as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': type } })
    const [start, end] = rangeOf(range, file.length)
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Type': type } })
  }
}

async function drain(feed: { next(): Promise<Uint8Array | null> }): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for (let piece = await feed.next(); piece; piece = await feed.next()) out.push(piece)
  return out
}

const signal = () => new AbortController().signal

describe('BoxSplitter', () => {
  it('hands on the init segment, then each moof with its mdat, whatever sizes the bytes come in, and drops the mfra', () => {
    const { file, init, fragments } = fragmentedMp4(5)
    for (const size of [1, 7, 333, 5000]) {
      const splitter = new BoxSplitter()
      const pieces: Uint8Array[] = []
      for (let at = 0; at < file.length; at += size) {
        splitter.push(file.slice(at, at + size))
        for (let piece = splitter.take(); piece; piece = splitter.take()) pieces.push(piece)
      }
      expect(pieces).toEqual([init, ...fragments])
      expect(splitter.buffered).toBe(0)
      expect(splitter.consumed).toBe(file.length)
    }
  })

  it('refuses a stream with no init segment before its first fragment', () => {
    const splitter = new BoxSplitter()
    splitter.push(concat([box('moof', 4), box('mdat', 4)]))
    expect(() => splitter.take()).toThrow('without an init segment')
  })
})

describe('openTrackFeed, an AAC rung from the top', () => {
  it('reads the codec from the Content-Type and hands on whole pieces as the response arrives', async () => {
    const { file, init, fragments } = fragmentedMp4(4)
    const { deps: d, served } = deps(
      () => new Response(chunked(file, [100, 900]), { headers: { 'Content-Type': 'audio/mp4; codecs="mp4a.40.2"' } }),
    )
    const feed = await openTrackFeed({ fileId: 7, rung: 'aac160', fromS: 0, signal: signal() }, d)
    expect(feed.type).toBe('audio/mp4; codecs="mp4a.40.2"')
    expect(feed.fromTime).toBe(0)
    expect(await drain(feed)).toEqual([init, ...fragments])
    expect(served).toEqual([{ url: expect.stringMatching(/\/files\/7\/stream\?quality=aac160$/), range: null }])
  })

  it('picks a cut-off response up from the first byte it had not handed on', async () => {
    const { file, init, fragments } = fragmentedMp4(6)
    // The connection drops part way through the third fragment.
    const cut = init.length + fragments[0].length + fragments[1].length + 500
    const { deps: d, served } = deps((_url, range) => {
      if (!range) return new Response(chunked(file, [700], cut), { headers: { 'Content-Type': 'audio/mp4; codecs="mp4a.40.2"' } })
      const [start] = rangeOf(range, file.length)
      return new Response(file.slice(start), { status: 206, headers: { 'Content-Type': 'audio/mp4; codecs="mp4a.40.2"' } })
    })
    const feed = await openTrackFeed({ fileId: 7, rung: 'aac160', fromS: 0, signal: signal() }, d)
    expect(await drain(feed)).toEqual([init, ...fragments])
    expect(served[1].range).toBe(`bytes=${init.length + fragments[0].length + fragments[1].length}-`)
    expect(d.retryAfter).toHaveBeenCalledTimes(1)
  })

  it('skips what it already had when a resumed request starts from the top again', async () => {
    const { file, init, fragments } = fragmentedMp4(4)
    const cut = init.length + fragments[0].length + 10
    let first = true
    const { deps: d } = deps(() => {
      const body = chunked(file, [300], first ? cut : undefined)
      first = false
      return new Response(body, { headers: { 'Content-Type': 'audio/mp4; codecs="mp4a.40.2"' } })
    })
    const feed = await openTrackFeed({ fileId: 7, rung: 'aac160', fromS: 0, signal: signal() }, d)
    expect(await drain(feed)).toEqual([init, ...fragments])
  })

  it('gives up on a response that keeps ending in the same place', async () => {
    const { file, init } = fragmentedMp4(4)
    const { deps: d } = deps(
      () => new Response(chunked(file, [300], init.length + 10), { headers: { 'Content-Type': 'audio/mp4; codecs="mp4a.40.2"' } }),
    )
    const feed = await openTrackFeed({ fileId: 7, rung: 'aac160', fromS: 0, signal: signal() }, d)
    await expect(drain(feed)).rejects.toBeInstanceOf(TrackUnavailable)
    expect(d.retryAfter).toHaveBeenCalledTimes(MAX_RESUMES)
  })

  it('refuses a response that does not name its codec, rather than guessing one', async () => {
    const { file } = fragmentedMp4(2)
    const { deps: d } = deps(() => new Response(file as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'audio/mp4' } }))
    await expect(openTrackFeed({ fileId: 7, rung: 'aac160', fromS: 0, signal: signal() }, d)).rejects.toBeInstanceOf(TrackUnavailable)
  })
})

describe('openTrackFeed, the original and scrubs', () => {
  it('fetches the init segment, then about a megabyte of whole fragments at a time by Range', async () => {
    const size = 300 * 1024
    const { file, init, fragments, index } = fragmentedMp4(10, size)
    const { deps: d, served } = deps(serveFile(file, index))
    const feed = await openTrackFeed({ fileId: 3, rung: 'original-fmp4', fromS: 0, signal: signal() }, d)
    expect(feed.type).toBe('audio/mp4; codecs="fLaC"')
    expect(feed.rung).toBe('original-fmp4')

    // Byte for byte, compared natively: deep equality over megabytes is slow.
    const pieces = await drain(feed)
    expect(pieces.map(fragmentNumber)).toEqual([-1, ...fragments.map((_, i) => i)])
    const want = [init, ...fragments]
    expect(pieces.every((piece, i) => piece.length === want[i].length && piece.every((byte, j) => byte === want[i][j]))).toBe(true)
    expect(served[0].url).toMatch(/\/files\/3\/stream\/index\?quality=original-fmp4$/)
    expect(served[1].range).toBe(`bytes=0-${index.initEnd - 1}`)
    const windows = served.slice(2).map((s) => rangeOf(s.range, file.length))
    for (const [start, end] of windows) {
      expect(index.fragments.some((f) => f.offset === start)).toBe(true)
      expect(end + 1 - start).toBeLessThanOrEqual(WINDOW_BYTES + size)
    }
    expect(windows.at(-1)![1]).toBe(index.end - 1)
  })

  it('starts a scrub at the fragment holding the target, without fetching the audio before it', async () => {
    const { file, init, fragments, index } = fragmentedMp4(10)
    const { deps: d, served } = deps(serveFile(file, index, 'audio/mp4; codecs="mp4a.40.2"'))
    const feed = await openTrackFeed({ fileId: 3, rung: 'aac256', fromS: 6.5, signal: signal() }, d)
    expect(feed.fromTime).toBe(6)
    const pieces = await drain(feed)
    expect(pieces[0]).toEqual(init)
    expect(pieces.slice(1).map(fragmentNumber)).toEqual([6, 7, 8, 9])
    expect(pieces.slice(1)).toEqual(fragments.slice(6))
    expect(served.slice(2).every((s) => rangeOf(s.range, file.length)[0] >= index.fragments[6].offset)).toBe(true)
  })

  it('plays the nearest AAC rung of an original the server cannot remux', async () => {
    const { file, init, fragments } = fragmentedMp4(3)
    const { deps: d, served } = deps((url) => {
      if (url.includes('original-fmp4')) return new Response('{}', { status: 415 })
      return new Response(file as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'audio/mp4; codecs="mp4a.40.2"' } })
    })
    const feed = await openTrackFeed({ fileId: 3, rung: 'original-fmp4', fromS: 0, signal: signal() }, d)
    expect(feed.rung).toBe('aac256')
    expect(await drain(feed)).toEqual([init, ...fragments])
    expect(served.map((s) => new URL(s.url).searchParams.get('quality'))).toEqual(['original-fmp4', 'aac256'])
  })

  it("plays the nearest AAC rung of an original whose codec this browser won't take", async () => {
    const { file, index } = fragmentedMp4(3)
    const { deps: d } = deps(serveFile(file, index, 'audio/mp4; codecs="mp4a.40.2"'), {
      isTypeSupported: (type) => !type.includes('fLaC'),
    })
    const feed = await openTrackFeed({ fileId: 3, rung: 'original-fmp4', fromS: 0, signal: signal() }, d)
    expect(feed.rung).toBe('aac256')
    expect(feed.type).toBe('audio/mp4; codecs="mp4a.40.2"')
  })
})

describe('openTrackFeed, when the server is away or the file is gone', () => {
  it('asks again through a network failure and a server that is away, and gives up on a missing file at once', async () => {
    const { file, index } = fragmentedMp4(2)
    let calls = 0
    const { deps: d } = deps(
      (url, range) => {
        calls += 1
        if (calls === 1) throw new TypeError('Failed to fetch')
        if (calls === 2) return new Response('', { status: 502 })
        return serveFile(file, index)(url, range)
      },
      { serverTrouble: vi.fn(async () => 'now' as const) },
    )
    const feed = await openTrackFeed({ fileId: 3, rung: 'original-fmp4', fromS: 0, signal: signal() }, d)
    expect(await drain(feed)).toHaveLength(3)
    expect(d.retryAfter).toHaveBeenCalledTimes(2)

    const missing = deps(() => new Response('{}', { status: 404 }))
    await expect(openTrackFeed({ fileId: 3, rung: 'original-fmp4', fromS: 0, signal: signal() }, missing.deps)).rejects.toBeInstanceOf(
      TrackUnavailable,
    )
    expect(missing.deps.retryAfter).not.toHaveBeenCalled()
  })

  it("takes a 502 from a server that answers its health check as the file's own failure", async () => {
    const { deps: d } = deps(() => new Response('{}', { status: 502 }))
    await expect(openTrackFeed({ fileId: 3, rung: 'aac160', fromS: 0, signal: signal() }, d)).rejects.toMatchObject({ status: 502 })
    expect(d.serverTrouble).toHaveBeenCalledTimes(1)
  })

  it('stops asking once the tape no longer wants the track', async () => {
    const controller = new AbortController()
    const { deps: d } = deps(
      () => {
        throw new TypeError('Failed to fetch')
      },
      {
        retryAfter: vi.fn(async () => {
          controller.abort()
          throw new DOMException('aborted', 'AbortError')
        }),
      },
    )
    await expect(openTrackFeed({ fileId: 3, rung: 'aac160', fromS: 0, signal: controller.signal }, d)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
