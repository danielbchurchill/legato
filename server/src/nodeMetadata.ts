import type { Database } from "./sqlite.js";

/* The details panel's Metadata tab (src/panels/NodeDetails.tsx): release
 * date, release type, label and MBID, each with where it came from.
 *
 * A file's own tags win, because the tab is where they're edited and
 * written back. Where a tag is empty, the value MusicBrainz matched to the
 * record (field_provenance, written by enrich/) fills in, marked as such so
 * it never reads as something the files already say.
 *
 * Before this the tab read only the node's own files. A record has none
 * (files belong to its tracks), so every album showed "–" for all four,
 * even with its MusicBrainz release and label already stored.
 */

export type MetadataSource = "tags" | "musicbrainz";
export type MetadataValue = { value: string; source: MetadataSource };
export type NodeMetadata = {
  releaseDate: MetadataValue | null;
  releaseType: MetadataValue | null;
  label: MetadataValue | null;
  mbid: MetadataValue | null;
};

type FileTags = { release_date: string | null; release_type: string | null; label: string | null };

// The file a record's or a track's tags are read from, the same one the
// tab's edit flow starts from (src/panels/useTagEdit.ts): a track's first
// file, or a record's first track's first file in album order.
function representativeFile(db: Database, nodeId: number, type: string): FileTags | null {
  if (type === "recording") {
    return (
      (db
        .prepare("SELECT release_date, release_type, label FROM files WHERE recording_node_id = ? ORDER BY id LIMIT 1")
        .get(nodeId) as FileTags | undefined) ?? null
    );
  }
  if (type === "release") {
    return (
      (db
        .prepare(
          `SELECT f.release_date, f.release_type, f.label
           FROM edges e JOIN files f ON f.recording_node_id = e.from_node
           WHERE e.to_node = ? AND e.type = 'appears_on'
           ORDER BY f.disc_no, f.track_no, f.id
           LIMIT 1`,
        )
        .get(nodeId) as FileTags | undefined) ?? null
    );
  }
  return null;
}

// The record a track's MusicBrainz release details hang off.
function releaseOf(db: Database, recordingId: number): number | null {
  const row = db
    .prepare("SELECT to_node AS id FROM edges WHERE from_node = ? AND type = 'appears_on' ORDER BY id LIMIT 1")
    .get(recordingId) as { id: number } | undefined;
  return row?.id ?? null;
}

// The active MusicBrainz value of one field on one node. Lookups can store
// the same value more than once; the most confident, most recent row wins.
function musicbrainz(db: Database, nodeId: number | null, field: string): string | null {
  if (nodeId == null) return null;
  const row = db
    .prepare(
      `SELECT value FROM field_provenance
       WHERE node_id = ? AND field = ? AND source = 'musicbrainz' AND is_active = 1
         AND value IS NOT NULL AND trim(value) != ''
       ORDER BY confidence DESC, updated_at DESC, id DESC
       LIMIT 1`,
    )
    .get(nodeId, field) as { value: string } | undefined;
  return row?.value ?? null;
}

function pick(tag: string | null | undefined, fallback: string | null): MetadataValue | null {
  if (tag != null && tag.trim() !== "") return { value: tag, source: "tags" };
  if (fallback != null) return { value: fallback, source: "musicbrainz" };
  return null;
}

export function nodeMetadata(db: Database, nodeId: number): NodeMetadata | null {
  const node = db.prepare("SELECT type, mbid FROM nodes WHERE id = ?").get(nodeId) as
    { type: string; mbid: string | null } | undefined;
  if (!node) return null;

  const file = representativeFile(db, nodeId, node.type);
  const release = node.type === "release" ? nodeId : node.type === "recording" ? releaseOf(db, nodeId) : null;
  const ownMbid =
    node.type === "release"
      ? musicbrainz(db, nodeId, "release_mbid")
      : node.type === "artist"
        ? musicbrainz(db, nodeId, "artist_mbid")
        : null;

  return {
    releaseDate: pick(file?.release_date, musicbrainz(db, release, "first_release_date")),
    // MusicBrainz's lookups don't store a release type, so this is tags only.
    releaseType: pick(file?.release_type, null),
    label: pick(file?.label, musicbrainz(db, release, "label_name")),
    // nodes.mbid is set by matching (a track's recording MBID), not read
    // from a tag, so it counts as MusicBrainz's either way.
    mbid: pick(null, node.mbid ?? ownMbid),
  };
}
