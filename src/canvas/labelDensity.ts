/* Which map labels get drawn.
 *
 * Every label the map could draw (an artist, a credit, a focused cluster's
 * records) is a candidate with a box on screen. Labels are placed greedily
 * in rank order, and one whose box would overlap a label already placed is
 * skipped, so the map stays legible at every zoom and zooming in reveals the
 * rest.
 *
 * The desktop ranks by what's focused, then kind, then dot size, and has no
 * cap. A phone (the Legato Mobile v2 handoff's open item) draws labels at
 * PHONE_LABEL_SCALE of the desktop size, never under PHONE_LABEL_MIN_PX, and
 * at most PHONE_LABEL_CAP of them: the selected or centred node first, then
 * its focused cluster, then artists by their number of records and then
 * tracks. A 390px screen holds a dozen labels before it reads as a list. */

export const PHONE_LABEL_SCALE = 0.8
export const PHONE_LABEL_MIN_PX = 11
export const PHONE_LABEL_CAP = 12

/** A desktop label size, in px, as a phone draws it. */
export function phoneLabelSize(desktopPx: number): number {
  return Math.max(PHONE_LABEL_MIN_PX, desktopPx * PHONE_LABEL_SCALE)
}

export type LabelBox = { left: number; top: number; right: number; bottom: number }

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** Places labels in the order given, skipping any whose box overlaps one
 * already placed, until `cap` are placed. Returns the placed keys. */
export function placeGreedily(ranked: Iterable<{ key: string; box: LabelBox }>, cap = Infinity): Set<string> {
  const placed = new Set<string>()
  const boxes: LabelBox[] = []
  for (const candidate of ranked) {
    if (placed.size >= cap) break
    if (boxes.some((box) => overlaps(candidate.box, box))) continue
    boxes.push(candidate.box)
    placed.add(candidate.key)
  }
  return placed
}

/* What a phone ranks a label by. `pinned` is the selected node, or the node
 * the camera last centred; `kindRank` orders artists before credits before
 * records; `records` and `tracks` are an artist's (a record's tracks, a
 * credit's connections go in `tracks`). */
export type LabelRank = {
  pinned: boolean
  focused: boolean
  kindRank: number
  records: number
  tracks: number
  title: string
}

export function compareLabelRank(a: LabelRank, b: LabelRank): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    Number(b.focused) - Number(a.focused) ||
    a.kindRank - b.kindRank ||
    b.records - a.records ||
    b.tracks - a.tracks ||
    a.title.localeCompare(b.title)
  )
}

/** The phone's density rule: rank, then place at most PHONE_LABEL_CAP. */
export function choosePhoneLabels(candidates: readonly { key: string; box: LabelBox; rank: LabelRank }[], cap = PHONE_LABEL_CAP): Set<string> {
  return placeGreedily(
    [...candidates].sort((a, b) => compareLabelRank(a.rank, b.rank)),
    cap,
  )
}
