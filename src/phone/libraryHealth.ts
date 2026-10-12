import type { WorklistKind } from '../shell/panels'
import type { DbInspectorSnapshot } from '../panels/DatabaseInspector'
import { useGapRows, useTagWrites, useWorklist, type GapField, type TagWrite, type WorklistItem } from '../panels/healthData'

/* What the phone's Library health page and Settings' Library health row say
 * (#389, Legato Mobile v2's screens 8 and 9), worked out from the data the
 * desktop's Library health panel already fetches (panels/healthData.ts). */

export type AttentionStatus = 'bad' | 'warn' | 'ok'

export type AttentionRow = {
  list: WorklistKind
  /** The gaps list's field, for the one row that opens it. */
  field?: GapField
  title: string
  /** One line on what the row means, under its title. */
  explanation: string
  status: AttentionStatus
  count: number
}

export type HealthData = {
  worklist: WorklistItem[] | null
  tagWrites: TagWrite[] | null
  /** Tracks with no MusicBrainz match: the gaps list's "unmatched". */
  unmatched: number | null
}

/** The rows the "needs attention" card lists, in the handoff's order: what's
 * wrong before what's waiting, each only while it has something in it. Null
 * until every source has answered, so a count never arrives row by row. */
export function attentionRows({ worklist, tagWrites, unmatched }: HealthData): AttentionRow[] | null {
  if (worklist == null || tagWrites == null || unmatched == null) return null
  const count = (...types: WorklistItem['type'][]) => worklist.filter((item) => types.includes(item.type)).length
  const rows: AttentionRow[] = [
    {
      list: 'gaps',
      field: 'unmatched',
      title: 'Unmatched tracks',
      explanation: 'No release found for these yet',
      status: 'bad',
      count: unmatched,
    },
    {
      list: 'missing',
      title: 'Missing files',
      explanation: "Moved, deleted or can't be read",
      status: 'bad',
      count: count('missing_file', 'wont_decode'),
    },
    {
      list: 'duplicates',
      title: 'Possible duplicates',
      explanation: 'Same recording, different files',
      status: 'warn',
      count: count('fuzzy_pending'),
    },
    {
      list: 'enrichment',
      title: 'Enrichment to confirm',
      explanation: "MusicBrainz couldn't match these alone",
      status: 'warn',
      count: count('enrichment_flag'),
    },
    {
      list: 'tag-writes',
      title: 'Tag writes to review',
      explanation: 'Edits waiting to be written',
      status: 'ok',
      count: pendingFixes(tagWrites),
    },
  ]
  return rows.filter((row) => row.count > 0)
}

/** The rows needing attention and the fixes waiting, live: each source
 * fetches again on the server events that change it (healthData.ts). */
export function useAttention(): { rows: AttentionRow[] | null; fixes: number | null } {
  const { data: worklist } = useWorklist()
  const { data: tagWrites } = useTagWrites()
  const { data: unmatched } = useGapRows('unmatched')
  return {
    rows: attentionRows({ worklist, tagWrites, unmatched: unmatched?.length ?? null }),
    fixes: tagWrites ? pendingFixes(tagWrites) : null,
  }
}

/** Fixes waiting for review: tag writes, the only changes Legato proposes
 * to make to the files themselves. */
export function pendingFixes(tagWrites: TagWrite[]): number {
  return tagWrites.filter((write) => write.status === 'pending_review').length
}

/** The worst status among the rows, for Settings' one dot. */
export function worstStatus(rows: AttentionRow[]): AttentionStatus {
  if (rows.some((row) => row.status === 'bad')) return 'bad'
  if (rows.some((row) => row.status === 'warn')) return 'warn'
  return 'ok'
}

/* Matched means a file has a recording behind it on MusicBrainz: by its
 * tags' MBID, by fingerprint, or set by hand. Tags alone, and a fuzzy match
 * still to confirm, don't count. */
const MATCHED = new Set(['mbid', 'acoustid', 'manual'])

export type MatchSummary = { matched: number; files: number; percent: number }

/** The summary card's figure: how many of the library's files are matched,
 * from the same per-source counts as the desktop's match quality bar. */
export function matchSummary(quality: DbInspectorSnapshot['matchQuality']): MatchSummary {
  const files = quality.reduce((n, row) => n + row.count, 0)
  const matched = quality.filter((row) => MATCHED.has(row.source)).reduce((n, row) => n + row.count, 0)
  // Floored, so a library with one file left over never reads 100%.
  return { matched, files, percent: files > 0 ? Math.floor((matched / files) * 100) : 0 }
}
