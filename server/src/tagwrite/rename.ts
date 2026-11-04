import type { Database } from "../sqlite.js";
import { albumIdentity, type AlbumIdentity } from "../match/albumIdentity.js";
import { artistMbidOf, artistsByKeyQuery, isSameSpelling } from "../match/artistLookup.js";
import { mergeNodeInto } from "../match/people.js";
import { findOrCreateRelease, findRelease } from "../match/releases.js";
import type { FieldDiff } from "./diff.js";

/* Issue #464: what an edit does to an artist's or an album's node.
 *
 * The scanner finds the node a file belongs to from its tags: an artist by
 * name (match/artistLookup.ts, #466), an album by its identity
 * (match/albumIdentity.ts, #465), through the keys match/releases.ts keeps
 * for it. Left to itself, a rename would make a new node and strand the old
 * one, along with everything the listener gave it: the favourite, the map
 * position, the photo, the description, their own connections, a cover they
 * chose. So before the renamed files are derived again, the node is made
 * the one their new tags lead to:
 *
 * - an artist is renamed in place, and the name lookup finds it;
 * - an album gets the keys of the identity its renamed files will have.
 *   findOrCreateRelease makes them, on a node of their own, and that node is
 *   folded into the album with mergeNodeInto, so the keys are exactly the
 *   ones the scanner makes and this file keeps no copy of the rule. The
 *   files' old keys stay on the album too, which keeps a file the writer
 *   couldn't write on it.
 *
 * When the new tags already lead to another node, the edit merges into it
 * instead, with mergeNodeInto, which keeps the survivor's own where both
 * have one and carries the rest across. That's asked of the scanner's own
 * lookups: otherArtistNamed below for an artist, and findRelease on each
 * renamed file's new identity for an album. So one artist's Greatest Hits
 * never merges into another's, nor two same-titled albums without an album
 * artist in different folders, because the scanner keeps those apart too.
 *
 * The rename happens when the first of an edit's writes is approved, and is
 * undone when the last one is reverted. A merge isn't undone: the review
 * says so before it's approved. */

export type TagEditRow = {
  id: number;
  node_id: number | null;
  old_title: string | null;
  new_title: string | null;
  claimed_keys: string | null;
  applied: "renamed" | "merged" | null;
};

type NodeRow = { id: number; type: string; title: string };

/** One file an edit writes, as the identity of its album is worked out
 *  from: its path, its tags as the last scan read them, and what the edit
 *  changes in them. */
export type EditedFile = { filePath: string; tagsRaw: string | null; diff: FieldDiff[] };

function nodeRow(db: Database, id: number | null): NodeRow | null {
  if (id == null) return null;
  return (db.prepare("SELECT id, type, title FROM nodes WHERE id = ?").get(id) as NodeRow | undefined) ?? null;
}

/** The albums the edited files will be on, by #465's albumIdentity, each
 *  once. */
export function identitiesAfter(files: EditedFile[]): AlbumIdentity[] {
  const identities = new Map<string, AlbumIdentity>();
  for (const file of files) {
    let tags: { album?: string | null; albumartist?: string | null } = {};
    try {
      tags = file.tagsRaw ? JSON.parse(file.tagsRaw) : {};
    } catch {}
    const written = (field: string) => {
      const value = file.diff.find((d) => d.field === field)?.newValue;
      return typeof value === "string" ? value : undefined;
    };
    const identity = albumIdentity(
      { album: written("album") ?? tags.album, albumartist: written("albumArtist") ?? tags.albumartist },
      file.filePath,
    );
    if (identity) identities.set(JSON.stringify([identity.artistKey, identity.folderKey]), identity);
  }
  return [...identities.values()];
}

function editedFiles(db: Database, editId: number): EditedFile[] {
  return (
    db
      .prepare(
        `SELECT f.file_path, f.tags_raw, w.diff_json FROM tag_writes w JOIN files f ON f.id = w.file_id
          WHERE w.edit_id = ? AND w.status IN ('pending_review', 'written')`,
      )
      .all(editId) as { file_path: string; tags_raw: string | null; diff_json: string }[]
  ).map((row) => ({ filePath: row.file_path, tagsRaw: row.tags_raw, diff: JSON.parse(row.diff_json) as FieldDiff[] }));
}

// Another artist the scanner's lookup takes `name` to mean: one spelled
// the same, else one that differs only by a leading "The", unless both have
// MusicBrainz ids and they differ.
function otherArtistNamed(db: Database, nodeId: number, name: string): NodeRow | null {
  const { sql, params } = artistsByKeyQuery(name);
  const others = (db.prepare(sql).all(...params) as { id: number }[])
    .map((row) => nodeRow(db, row.id)!)
    .filter((other) => other.id !== nodeId);
  const exact = others.find((other) => isSameSpelling(other.title, name));
  if (exact) return exact;
  const own = artistMbidOf(db, nodeId);
  return others.find((other) => own == null || [own, null].includes(artistMbidOf(db, other.id))) ?? null;
}

// The album the most renamed files' identities already lead to, other than
// this one, by findRelease.
function otherRelease(db: Database, nodeId: number, identities: AlbumIdentity[]): NodeRow | null {
  const counts = new Map<number, number>();
  for (const identity of identities) {
    const found = findRelease(db, identity);
    if (found !== null && found !== nodeId) counts.set(found, (counts.get(found) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [id, count] of counts) if (best === null || count > counts.get(best)!) best = id;
  return nodeRow(db, best);
}

/** The node an edit to `node` merges into once it's approved, or null when
 *  it keeps its own. `newTitle` is an artist's new name; `identities` are an
 *  album's renamed files' (identitiesAfter). */
export function mergeTarget(db: Database, node: NodeRow, newTitle: string | null, identities: AlbumIdentity[]): NodeRow | null {
  if (node.type === "artist") return newTitle == null ? null : otherArtistNamed(db, node.id, newTitle);
  if (node.type === "release") return otherRelease(db, node.id, identities);
  return null;
}

// Points the keys of every identity that leads nowhere yet at the album, by
// letting findOrCreateRelease make them on a node of its own and folding
// that node in. Returns the keys it added, which undoNodeEdit takes back.
function claimIdentities(db: Database, nodeId: number, identities: AlbumIdentity[]): string[] {
  const claimed: string[] = [];
  for (const identity of identities) {
    if (findRelease(db, identity) !== null) continue;
    const made = findOrCreateRelease(db, identity);
    const keys = db.prepare("SELECT key FROM release_keys WHERE node_id = ?").all(made) as { key: string }[];
    mergeNodeInto(db, made, nodeId);
    claimed.push(...keys.map((k) => k.key));
  }
  return claimed;
}

/** Carries the edit's node over to its new name, once: renamed in place, or
 *  merged into the node the new name leads to. Returns the node the edit's
 *  files belong to now. Runs before the written files are derived again
 *  (tagwrite/refresh.ts), so they land on it. */
export function applyNodeEdit(db: Database, editId: number): number | null {
  const edit = db.prepare("SELECT * FROM tag_edits WHERE id = ?").get(editId) as TagEditRow | undefined;
  if (!edit) return null;
  if (edit.applied) return edit.node_id;
  const node = nodeRow(db, edit.node_id);
  if (!node) return null;

  const identities = node.type === "release" ? identitiesAfter(editedFiles(db, edit.id)) : [];
  const target = mergeTarget(db, node, edit.new_title, identities);
  db.transaction(() => {
    if (target) {
      // Moves this edit's node_id along with everything else.
      mergeNodeInto(db, node.id, target.id);
      db.prepare("UPDATE tag_edits SET applied = 'merged' WHERE id = ?").run(edit.id);
      return;
    }
    const claimed = node.type === "release" ? claimIdentities(db, node.id, identities) : [];
    const retitled = edit.new_title != null && edit.new_title !== node.title;
    if (retitled) {
      db.prepare("UPDATE nodes SET title = ?, updated_at = datetime('now') WHERE id = ?").run(edit.new_title, node.id);
    }
    if (retitled || claimed.length > 0) {
      db.prepare("UPDATE tag_edits SET applied = 'renamed', claimed_keys = ? WHERE id = ?").run(JSON.stringify(claimed), edit.id);
    }
  })();
  return target?.id ?? node.id;
}

/** Puts a renamed node back under its old name, once none of the edit's
 *  files say the new one, and takes back the album keys the rename added.
 *  An album's reverted files find it again by their old keys. An artist's
 *  went to a node of the old name, made fresh; that node folds back into
 *  this one, which keeps its id and everything on it. */
export function undoNodeEdit(db: Database, editId: number): void {
  const edit = db.prepare("SELECT * FROM tag_edits WHERE id = ?").get(editId) as TagEditRow | undefined;
  if (!edit || edit.applied !== "renamed") return;
  const node = nodeRow(db, edit.node_id);
  if (!node) return;

  db.transaction(() => {
    if (node.type === "artist" && edit.old_title != null) {
      const { sql, params } = artistsByKeyQuery(edit.old_title);
      for (const { id } of db.prepare(sql).all(...params) as { id: number }[]) {
        const other = nodeRow(db, id)!;
        if (other.id !== node.id && isSameSpelling(other.title, edit.old_title)) mergeNodeInto(db, other.id, node.id);
      }
    }
    const claimed = edit.claimed_keys ? (JSON.parse(edit.claimed_keys) as string[]) : [];
    const forget = db.prepare("DELETE FROM release_keys WHERE key = ? AND node_id = ?");
    for (const key of claimed) forget.run(key, node.id);
    if (edit.old_title != null) {
      db.prepare("UPDATE nodes SET title = ?, updated_at = datetime('now') WHERE id = ?").run(edit.old_title, node.id);
    }
    db.prepare("UPDATE tag_edits SET applied = NULL, claimed_keys = NULL WHERE id = ?").run(edit.id);
  })();
}
