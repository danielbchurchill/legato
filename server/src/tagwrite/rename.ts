import type { Database } from "../sqlite.js";
import { NODE_LOOKUP_SQL } from "../match/edges.js";
import { mergeNodeInto } from "../match/people.js";
import { normalName } from "./credits.js";

/* Issue #464: what an edit does to an artist's or an album's node.
 *
 * The scanner finds a node by its name (match/edges.ts), so files that now
 * say "The Beatles" re-derive onto whichever node is called that. Left to
 * itself, a rename would make a new node and strand the old one, along with
 * everything the listener gave it: the favourite, the map position, the
 * photo, the description, their own connections, a cover they chose. So the
 * node is renamed first, in place, and the files re-derive back onto it.
 *
 * When a node of the same kind already has the new name, the rename merges
 * into it with match/people.ts's mergeNodeInto, which keeps the survivor's
 * own where both have one and carries the rest across. For an album "the
 * same" is the same title and the same album artist, so one artist's
 * Greatest Hits never merges into another's.
 *
 * The rename happens when the first of an edit's writes is approved, and is
 * undone when the last one is reverted, so a node never carries a name none
 * of its files say for longer than a review takes. A merge isn't undone:
 * the review says so before it's approved. */

export type TagEditRow = {
  id: number;
  node_id: number | null;
  old_title: string | null;
  new_title: string | null;
  old_album_artist: string | null;
  new_album_artist: string | null;
  applied: "renamed" | "merged" | null;
};

type NodeRow = { id: number; type: string; title: string };

/** The album artist an album is known by: the ALBUMARTIST its files carry,
 *  or, without one, their artist line, whichever most of its present files
 *  say. Case and spacing don't count, as in the scanner's own lookup. */
export function albumArtistKey(db: Database, releaseId: number): string | null {
  const rows = db
    .prepare(
      `SELECT f.tags_raw FROM edges e JOIN files f ON f.recording_node_id = e.from_node
        WHERE e.to_node = ? AND e.type = 'appears_on' AND f.missing_since IS NULL`,
    )
    .all(releaseId) as { tags_raw: string | null }[];
  const counts = new Map<string, number>();
  for (const { tags_raw } of rows) {
    let tags: { albumartist?: string | null; artist?: string | null } = {};
    try {
      tags = tags_raw ? JSON.parse(tags_raw) : {};
    } catch {}
    const name = tags.albumartist?.trim() || tags.artist?.trim();
    if (!name) continue;
    const key = normalName(name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [key, count] of counts) if (best == null || count > counts.get(best)!) best = key;
  return best;
}

function nodeRow(db: Database, id: number | null): NodeRow | null {
  if (id == null) return null;
  return (db.prepare("SELECT id, type, title FROM nodes WHERE id = ?").get(id) as NodeRow | undefined) ?? null;
}

/** Another node of `node`'s kind already called `title` (and, for an album,
 *  by `albumArtist`), which a rename to that name would merge into. Found
 *  through the scanner's own name lookup, so it's the node the files would
 *  land on. */
export function existingNodeNamed(
  db: Database,
  node: { id: number; type: string },
  title: string,
  albumArtist: string | null,
): NodeRow | null {
  const named = db
    .prepare(`SELECT id, type, title FROM nodes WHERE id IN (${NODE_LOOKUP_SQL}) AND id != ? ORDER BY id`)
    .all(node.type, title, node.id) as NodeRow[];
  if (node.type !== "release") return named[0] ?? null;
  const wanted = albumArtist == null ? null : normalName(albumArtist);
  return named.find((other) => albumArtistKey(db, other.id) === wanted) ?? null;
}

/** Where an edit's node goes once it's approved: the node it merges into,
 *  or null when it keeps its own (renamed, or not renamed at all). */
export function mergeTarget(db: Database, edit: Omit<TagEditRow, "id" | "applied">): NodeRow | null {
  const node = nodeRow(db, edit.node_id);
  if (!node || (edit.new_title == null && edit.new_album_artist == null)) return null;
  const title = edit.new_title ?? node.title;
  const albumArtist = edit.new_album_artist ?? (node.type === "release" ? albumArtistKey(db, node.id) : null);
  return existingNodeNamed(db, node, title, albumArtist);
}

/** Carries the edit's node over to its new name, once: renamed in place, or
 *  merged into the node that already has the name. Returns the node the
 *  edit's files belong to now. */
export function applyNodeEdit(db: Database, editId: number): number | null {
  const edit = db.prepare("SELECT * FROM tag_edits WHERE id = ?").get(editId) as TagEditRow | undefined;
  if (!edit) return null;
  if (edit.applied) return edit.node_id;
  const node = nodeRow(db, edit.node_id);
  if (!node) return null;

  const target = mergeTarget(db, edit);
  db.transaction(() => {
    if (target) {
      // Moves this edit's node_id along with everything else.
      mergeNodeInto(db, node.id, target.id);
      db.prepare("UPDATE tag_edits SET applied = 'merged' WHERE id = ?").run(edit.id);
    } else if (edit.new_title != null && edit.new_title !== node.title) {
      db.prepare("UPDATE nodes SET title = ?, updated_at = datetime('now') WHERE id = ?").run(edit.new_title, node.id);
      db.prepare("UPDATE tag_edits SET applied = 'renamed' WHERE id = ?").run(edit.id);
    }
  })();
  return target?.id ?? node.id;
}

/** Puts a renamed node back under its old name, once none of the edit's
 *  files say the new one. Files already reverted re-derived onto a node of
 *  the old name, made fresh; that node folds back into this one, which
 *  keeps its id and everything on it. */
export function undoNodeEdit(db: Database, editId: number): void {
  const edit = db.prepare("SELECT * FROM tag_edits WHERE id = ?").get(editId) as TagEditRow | undefined;
  if (!edit || edit.applied !== "renamed" || edit.old_title == null) return;
  const node = nodeRow(db, edit.node_id);
  if (!node) return;

  const albumArtist = node.type === "release" ? (edit.old_album_artist ?? albumArtistKey(db, node.id)) : null;
  db.transaction(() => {
    for (;;) {
      const other = existingNodeNamed(db, node, edit.old_title!, albumArtist);
      if (!other) break;
      mergeNodeInto(db, other.id, node.id);
    }
    db.prepare("UPDATE nodes SET title = ?, updated_at = datetime('now') WHERE id = ?").run(edit.old_title, node.id);
    db.prepare("UPDATE tag_edits SET applied = NULL WHERE id = ?").run(edit.id);
  })();
}
