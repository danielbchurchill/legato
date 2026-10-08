import { describe, expect, it } from 'vitest'
import { TITLE_MIN, trackColumns } from './trackColumns'

const ALL = ['number', 'cover', 'title', 'artist', 'album', 'time', 'format', 'added']

describe('trackColumns', () => {
  it("is the frame's eight columns when there's room", () => {
    const { ids, style } = trackColumns(1308, 'title')
    expect(ids).toEqual(ALL)
    expect(style.gridTemplateColumns).toBe('36px 40px minmax(0, 3fr) minmax(0, 2fr) minmax(0, 2fr) 64px 56px 92px')
    expect(style.columnGap).toBe(14)
    expect(style.paddingInline).toBe(12)
  })

  // Each drop point is where the title column would go under TITLE_MIN:
  // padding 24, then the fixed columns and gaps that are left, then 7 or 5
  // fr units of which the title takes 3.
  const dropPoint = (fixed: number, gaps: number, fr: number) => 24 + fixed + gaps * 14 + (TITLE_MIN / 3) * fr

  it('drops added, then format, then album, at the widths the frame and TITLE_MIN give', () => {
    expect(dropPoint(36 + 40 + 64 + 56 + 92, 7, 7)).toBe(760)
    expect(dropPoint(36 + 40 + 64 + 56, 6, 7)).toBe(654)
    expect(dropPoint(36 + 40 + 64, 5, 7)).toBe(584)

    expect(trackColumns(760, 'title').ids).toEqual(ALL)
    expect(trackColumns(759, 'title').ids).toEqual(ALL.filter((id) => id !== 'added'))
    expect(trackColumns(654, 'title').ids).toEqual(ALL.filter((id) => id !== 'added'))
    expect(trackColumns(653, 'title').ids).toEqual(['number', 'cover', 'title', 'artist', 'album', 'time'])
    expect(trackColumns(584, 'title').ids).toEqual(['number', 'cover', 'title', 'artist', 'album', 'time'])
    expect(trackColumns(583, 'title').ids).toEqual(['number', 'cover', 'title', 'artist', 'time'])
    expect(trackColumns(583, 'title').style.gridTemplateColumns).toBe('36px 40px minmax(0, 3fr) minmax(0, 2fr) 64px')
  })

  it('stops dropping once only title, artist and time are left', () => {
    expect(trackColumns(300, 'title').ids).toEqual(['number', 'cover', 'title', 'artist', 'time'])
  })

  it('keeps the column the table is sorted by, and drops the next one instead', () => {
    expect(trackColumns(700, 'dateAdded').ids).toEqual(['number', 'cover', 'title', 'artist', 'album', 'time', 'added'])
    expect(trackColumns(440, 'dateAdded').ids).toEqual(['number', 'cover', 'title', 'artist', 'time', 'added'])
    expect(trackColumns(440, 'format').ids).toEqual(['number', 'cover', 'title', 'artist', 'time', 'format'])
    expect(trackColumns(440, 'album').ids).toEqual(['number', 'cover', 'title', 'artist', 'album', 'time'])
    expect(trackColumns(440, 'duration').ids).toEqual(['number', 'cover', 'title', 'artist', 'time'])
  })
})
