import { describe, expect, it } from 'vitest'
import type { TagWrite, WorklistItem } from '../panels/healthData'
import { attentionRows, matchSummary, pendingFixes, worstStatus, type AttentionRow } from './libraryHealth'

const duplicate: WorklistItem = {
  type: 'fuzzy_pending',
  fileId: 1,
  filePath: '/music/a.flac',
  nodeId: 2,
  nodeTitle: 'Tidewater',
  candidateNodeId: 3,
  candidateTitle: 'Tidewater',
}
const missing: WorklistItem = { type: 'missing_file', fileId: 4, filePath: '/music/b.flac', nodeId: 5, nodeTitle: 'Gone', missingSince: '' }
const unreadable: WorklistItem = {
  type: 'wont_decode',
  fileId: 6,
  filePath: '/music/c.flac',
  nodeId: 7,
  nodeTitle: 'Broken',
  error: '',
  updatedAt: '',
}

function tagWrite(id: number, status: TagWrite['status']): TagWrite {
  return { id, file_id: id, status, diff_json: '[]', requested_at: '', written_at: null, reverted_at: null, error_message: null }
}

describe('attentionRows', () => {
  it("waits for every source, so the rows don't arrive one by one", () => {
    expect(attentionRows({ worklist: [], tagWrites: [], unmatched: null })).toBeNull()
    expect(attentionRows({ worklist: null, tagWrites: [], unmatched: 0 })).toBeNull()
    expect(attentionRows({ worklist: [], tagWrites: null, unmatched: 0 })).toBeNull()
  })

  it('lists only what has something in it', () => {
    expect(attentionRows({ worklist: [], tagWrites: [tagWrite(1, 'written')], unmatched: 0 })).toEqual([])
  })

  it("puts what's wrong before what's waiting, each with its count and the list it opens", () => {
    const rows = attentionRows({
      worklist: [duplicate, missing, unreadable],
      tagWrites: [tagWrite(1, 'pending_review'), tagWrite(2, 'pending_review'), tagWrite(3, 'written')],
      unmatched: 7,
    })
    expect(rows?.map((row) => [row.title, row.status, row.count, row.list, row.field])).toEqual([
      ['Unmatched tracks', 'bad', 7, 'gaps', 'unmatched'],
      // A file that won't decode is missing as far as playing it goes.
      ['Missing files', 'bad', 2, 'missing', undefined],
      ['Possible duplicates', 'warn', 1, 'duplicates', undefined],
      ['Tag writes to review', 'ok', 2, 'tag-writes', undefined],
    ])
  })
})

describe('pendingFixes', () => {
  it('counts the tag writes waiting for review, not the ones written or reverted', () => {
    expect(
      pendingFixes([tagWrite(1, 'pending_review'), tagWrite(2, 'written'), tagWrite(3, 'reverted'), tagWrite(4, 'pending_review')]),
    ).toBe(2)
  })
})

describe('worstStatus', () => {
  const row = (status: AttentionRow['status']): AttentionRow => ({ list: 'missing', title: '', explanation: '', status, count: 1 })

  it('is the worst of the rows, and ok with none', () => {
    expect(worstStatus([row('ok'), row('warn')])).toBe('warn')
    expect(worstStatus([row('warn'), row('bad'), row('ok')])).toBe('bad')
    expect(worstStatus([])).toBe('ok')
  })
})

describe('matchSummary', () => {
  it('counts files matched by MBID, fingerprint or by hand, out of every file', () => {
    expect(
      matchSummary([
        { source: 'mbid', count: 12, share: 0 },
        { source: 'acoustid', count: 1, share: 0 },
        { source: 'manual', count: 1, share: 0 },
        { source: 'fuzzy_pending', count: 1, share: 0 },
        { source: 'unmatched', count: 5, share: 0 },
      ]),
    ).toEqual({ matched: 14, files: 20, percent: 70 })
  })

  it('never rounds a library with one file left over up to 100%', () => {
    expect(
      matchSummary([
        { source: 'mbid', count: 999, share: 0 },
        { source: 'unmatched', count: 1, share: 0 },
      ]).percent,
    ).toBe(99)
  })

  it('reads 0% for an empty library rather than dividing by nothing', () => {
    expect(matchSummary([])).toEqual({ matched: 0, files: 0, percent: 0 })
  })
})
