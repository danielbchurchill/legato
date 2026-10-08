import type { CSSProperties } from 'react'
import type { TrackSort } from './types'

/* The tracks table's columns, as LibraryStageV2 measures them: #, cover,
 * title, artist, album, time, format, added at `36px 40px 3fr 2fr 2fr 64px
 * 56px 92px`, 14px apart and 12px in from each end of a row.
 *
 * The frame draws the table on a 992px stage. Narrower, with both panels
 * open, the fixed columns would leave title, artist and album almost
 * nothing (about 30px between them at 1280), so the table gives way in a
 * set order, the way the player does (#293): added, then format, then
 * album, each only once the title column would otherwise drop under
 * TITLE_MIN. The column the table is sorted by never drops; the next one
 * in the order goes instead, so what the rows are sorted by stays on
 * screen. With every column, the title column reaches TITLE_MIN at a table
 * 760px wide (24 padding + 288 fixed + 98 gaps + 350 across the 7 fr);
 * without added at 654 (24 + 196 + 84 + 350), and without format as well
 * at 584 (24 + 140 + 70 + 350). Without album, it would reach it at 470,
 * and nothing drops after that. */

export type TrackColumnId = 'number' | 'cover' | 'title' | 'artist' | 'album' | 'time' | 'format' | 'added'

type TrackColumn = { id: TrackColumnId; width?: number; fr?: number; sort?: TrackSort }

export const TRACK_COLUMNS: readonly TrackColumn[] = [
  { id: 'number', width: 36 },
  { id: 'cover', width: 40 },
  { id: 'title', fr: 3, sort: 'title' },
  { id: 'artist', fr: 2, sort: 'artist' },
  { id: 'album', fr: 2, sort: 'album' },
  { id: 'time', width: 64, sort: 'duration' },
  { id: 'format', width: 56, sort: 'format' },
  { id: 'added', width: 92, sort: 'dateAdded' },
]

const COLUMN_GAP = 14
const ROW_PADDING = 12

/* The narrowest the title column gets before another column gives way:
 * about eighteen characters of a 14px 500 title. Artist and album, at 2fr
 * to its 3fr, are 100px then. */
export const TITLE_MIN = 150

const DROP_ORDER: readonly TrackColumnId[] = ['added', 'format', 'album']

export type TrackColumns = { ids: TrackColumnId[]; style: CSSProperties }

function titleWidth(columns: readonly TrackColumn[], width: number): number {
  const fixed = columns.reduce((sum, c) => sum + (c.width ?? 0), 0)
  const fr = columns.reduce((sum, c) => sum + (c.fr ?? 0), 0)
  const flexible = width - 2 * ROW_PADDING - fixed - COLUMN_GAP * (columns.length - 1)
  return (flexible * 3) / fr
}

/* The columns a table `width` wide shows, sorted by `sort`, and the grid
 * style that lays them out. The header, the rows and their placeholders
 * all take the same answer, so a label never sits over the wrong column. */
export function trackColumns(width: number, sort: TrackSort): TrackColumns {
  let columns = [...TRACK_COLUMNS]
  for (const id of DROP_ORDER) {
    if (titleWidth(columns, width) >= TITLE_MIN) break
    if (columns.find((c) => c.id === id)?.sort === sort) continue
    columns = columns.filter((c) => c.id !== id)
  }
  return {
    ids: columns.map((c) => c.id),
    style: {
      gridTemplateColumns: columns.map((c) => (c.width != null ? `${c.width}px` : `minmax(0, ${c.fr}fr)`)).join(' '),
      columnGap: COLUMN_GAP,
      paddingInline: ROW_PADDING,
    },
  }
}
