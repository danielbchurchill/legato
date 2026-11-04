import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approveWrites, changesFor, discardWrites, InvalidValue, parseValues, proposeWrites, summarize } from './gapWrites'

describe('parseValues', () => {
  it('parses each field it can write, and leaves out empty ones', () => {
    expect(parseValues({ label: ' Columbia ', release_date: '1969-09', release_type: 'Album', bpm: '' })).toEqual({
      label: 'Columbia',
      release_date: '1969-09',
      release_type: 'album',
    })
    expect(parseValues({ bpm: '120.4' })).toEqual({ bpm: 120 })
  })

  it('throws the field whose text isn’t a value of its kind', () => {
    expect(() => parseValues({ release_date: 'last year' })).toThrow(InvalidValue)
    try {
      parseValues({ label: 'ok', bpm: 'fast' })
    } catch (err) {
      expect((err as InvalidValue).field).toBe('bpm')
    }
  })

  it('ignores "unmatched", which has no value', () => {
    expect(parseValues({ unmatched: 'x' })).toEqual({})
  })
})

describe('changesFor', () => {
  it('writes each value only to a file missing it', () => {
    const values = { label: 'Apple', release_date: '1969' }
    expect(changesFor(['label', 'release_date'], values)).toEqual({ label: 'Apple', releaseDate: '1969' })
    expect(changesFor(['release_date'], values)).toEqual({ releaseDate: '1969' })
    expect(changesFor(['release_type'], values)).toBeNull()
  })
})

describe('summarize', () => {
  it('says each change once, with how many files it goes to', () => {
    const diff = (field: string, newValue: string) => [{ field, oldValue: '', newValue }]
    expect(
      summarize([
        { id: 1, fileId: 1, diff: [...diff('label', 'Apple'), ...diff('releaseDate', '1969')] },
        { id: 2, fileId: 2, diff: diff('label', 'Apple') },
      ]),
    ).toEqual([
      { field: 'label', value: 'Apple', files: 2 },
      { field: 'releaseDate', value: '1969', files: 1 },
    ])
  })
})

describe('the tag-write requests', () => {
  const calls: { method: string; path: string; body: unknown }[] = []
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname.replace('/api/v1', '')
        const body = init?.body ? JSON.parse(init.body as string) : null
        calls.push({ method: init?.method ?? 'GET', path, body })
        const json = (status: number, value: unknown) => ({ ok: status < 300, status, json: async () => value }) as Response
        if (path === '/tag-writes') {
          const { fileId } = body as { fileId: number }
          if (fileId === 3) return json(200, { noop: true, diff: [] })
          if (fileId === 4) return json(400, { error: 'tag write-back only supports FLAC, MP3, and MP4/M4A files' })
          return json(200, { id: 100 + fileId, diff_json: JSON.stringify([{ field: 'label', oldValue: '', newValue: 'Apple' }]) })
        }
        if (path === '/tag-writes/102/approve') return json(500, { error: 'disk full' })
        return json(200, {})
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('proposes one dry run per file, through POST /tag-writes, and sorts out what came back', async () => {
    const targets = [1, 2, 3, 4].map((fileId) => ({ fileId, changes: { label: 'Apple' } }))
    const proposal = await proposeWrites(targets)
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual(targets.map((t) => ['POST', '/tag-writes', t]))
    expect(proposal.proposed.map((p) => p.id)).toEqual([101, 102])
    expect(proposal.unchanged).toBe(1)
    expect(proposal.failed).toEqual([{ fileId: 4, error: 'tag write-back only supports FLAC, MP3, and MP4/M4A files' }])
  })

  it('approves each in turn, counting progress and failures', async () => {
    const progress: number[] = []
    const result = await approveWrites([101, 102], (n) => progress.push(n))
    expect(calls.map((c) => c.path)).toEqual(['/tag-writes/101/approve', '/tag-writes/102/approve'])
    expect(progress).toEqual([1, 2])
    expect(result).toEqual({ written: 1, failed: [{ id: 102, error: 'disk full' }] })
  })

  it('discards each without writing', async () => {
    await discardWrites([101, 102])
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['DELETE', '/tag-writes/101'],
      ['DELETE', '/tag-writes/102'],
    ])
  })
})
