import { File as TagLibFile } from "node-taglib-sharp";
import type { Database } from "../sqlite.js";
import { creditEvidence, performerEvidence } from "../match/evidence.js";
import { normalName, renameCredits, type CreditFields } from "./credits.js";
import { computeDiff, type FieldDiff } from "./diff.js";
import { detectFormat, readFields, unwritableReason, type TagFields } from "./fields.js";
import { albumArtistKey } from "./rename.js";

/* Issue #464: an edit to a track, an album or an artist, as the tag writes
 * it takes. A track's fields go to its own files, an album's to every file
 * on it, and an artist's name to every file that credits them, rewritten
 * line by line (credits.ts). Files the writer can't write, or can't read,
 * are left out with the reason, and the rest of the edit goes ahead. */

export type NodeEditChanges = TagFields & { name?: string };

type EditableKey = keyof NodeEditChanges;

// What each kind of node's Metadata tab edits (src/panels/useTagEdit.ts).
// "year or release date" is releaseDate: it takes a bare year too, and it's
// the date the scanner reads first (scan/tags.ts).
export const EDITABLE: Record<string, readonly EditableKey[]> = {
  recording: [
    "title",
    "artist",
    "album",
    "albumArtist",
    "releaseDate",
    "trackNo",
    "discNo",
    "genre",
    "bpm",
    "label",
    "releaseType",
  ],
  release: ["album", "albumArtist", "releaseDate", "genre", "label", "releaseType"],
  artist: ["name"],
};

const TEXT_KEYS = new Set<EditableKey>(["title", "artist", "album", "albumArtist", "label", "releaseType", "name"]);
const NUMBER_KEYS = new Set<EditableKey>(["trackNo", "discNo", "bpm"]);
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** The request's changes, checked against what this kind of node edits, or
 *  why they can't be used. */
export function validateChanges(type: string, raw: unknown): { changes: NodeEditChanges } | { error: string } {
  const editable = EDITABLE[type];
  if (!editable) return { error: `a ${type} node has no tags to edit` };
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { error: "changes must be an object" };

  const changes: NodeEditChanges = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = key as EditableKey;
    if (!editable.includes(field)) return { error: `can't edit ${key} on a ${type}` };
    if (TEXT_KEYS.has(field) || field === "releaseDate") {
      if (typeof value !== "string" || value.trim() === "") return { error: `${key} must be text` };
      if (field === "releaseDate" && !DATE.test(value.trim())) return { error: "releaseDate must be YYYY, YYYY-MM or YYYY-MM-DD" };
      (changes as Record<string, unknown>)[field] = value.trim();
    } else if (NUMBER_KEYS.has(field)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 9999) {
        return { error: `${key} must be a whole number from 1 to 9999` };
      }
      (changes as Record<string, unknown>)[field] = value;
    } else if (field === "genre") {
      if (!Array.isArray(value) || value.some((g) => typeof g !== "string") || value.length === 0) {
        return { error: "genre must be a list of names" };
      }
      const genres = (value as string[]).map((g) => g.trim()).filter((g) => g !== "");
      if (genres.length === 0) return { error: "genre must be a list of names" };
      changes.genre = genres;
    }
  }
  if (Object.keys(changes).length === 0) return { error: "nothing to change" };
  return { changes };
}

type NodeRow = { id: number; type: string; title: string };
type FileRow = {
  id: number;
  file_path: string;
  recording_node_id: number;
  missing_since: string | null;
  tags_raw: string | null;
  /** For an artist: whether the file's track has an edge to them. */
  linked?: number;
};

export type PlannedWrite = { fileId: number; filePath: string; diff: FieldDiff[] };
export type SkippedFile = { fileId: number; path: string; reason: string };
export type RenamePlan = {
  oldTitle: string | null;
  newTitle: string | null;
  oldAlbumArtist: string | null;
  newAlbumArtist: string | null;
};
export type NodeEditPlan = { writes: PlannedWrite[]; skipped: SkippedFile[]; rename: RenamePlan | null };

const FILE_COLUMNS = "f.id, f.file_path, f.recording_node_id, f.missing_since, f.tags_raw";
const PERSON_EDGES = "('performed_by', 'featured_artist', 'produced_by', 'engineered_by')";

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Every file an edit to `node` writes to, in album order for an album. An
 *  artist's are the files whose tracks credit them, and any other whose
 *  tags carry the name, an ALBUMARTIST credit on someone else's track. */
export function filesForNode(db: Database, node: NodeRow): FileRow[] {
  if (node.type === "recording") {
    return db.prepare(`SELECT ${FILE_COLUMNS} FROM files f WHERE f.recording_node_id = ? ORDER BY f.id`).all(node.id) as FileRow[];
  }
  if (node.type === "release") {
    return db
      .prepare(
        `SELECT DISTINCT ${FILE_COLUMNS} FROM edges e JOIN files f ON f.recording_node_id = e.from_node
          WHERE e.to_node = ? AND e.type = 'appears_on'
          ORDER BY f.disc_no, f.track_no, f.id`,
      )
      .all(node.id) as FileRow[];
  }
  if (node.type === "artist") {
    return db
      .prepare(
        `SELECT ${FILE_COLUMNS}, f.recording_node_id IN (SELECT from_node FROM edges WHERE to_node = ? AND type IN ${PERSON_EDGES}) AS linked
           FROM files f
          WHERE linked OR f.tags_raw LIKE ? ESCAPE '\\'
          ORDER BY f.id`,
      )
      .all(node.id, likePattern(node.title)) as FileRow[];
  }
  return [];
}

type RawTags = {
  artist?: string | null;
  albumartist?: string | null;
  artists?: string[] | null;
  featuredArtists?: string[] | null;
  producer?: string[] | null;
  engineer?: string[] | null;
};

function rawTags(file: FileRow): RawTags {
  try {
    return file.tags_raw ? (JSON.parse(file.tags_raw) as RawTags) : {};
  } catch {
    return {};
  }
}

// What a file credits, from its tags on disk, or from what the last scan
// read when the writer can't open it.
function creditsOnDisk(filePath: string): CreditFields {
  const format = detectFormat(filePath);
  const file = TagLibFile.createFromPath(filePath);
  try {
    const { performers, artists, albumArtist, producer, engineer } = readFields(file.tag, format);
    return { performers, artists, albumArtist, producer, engineer };
  } finally {
    file.dispose();
  }
}

function creditsScanned(tags: RawTags): CreditFields {
  return {
    performers: tags.artist ? [tags.artist] : [],
    artists: tags.artists ?? [],
    albumArtist: tags.albumartist ?? "",
    producer: tags.producer ?? [],
    engineer: tags.engineer ?? [],
  };
}

function renameFor(db: Database, file: FileRow, credits: CreditFields, from: string, to: string): TagFields {
  const tags = rawTags(file);
  const performers = performerEvidence(db, file.recording_node_id, tags);
  return renameCredits(credits, from, to, performers, creditEvidence(db, file.recording_node_id, performers));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The writes an edit takes, file by file, with only what differs from each
 *  file's tags on disk, and the files left out. */
export function planNodeEdit(db: Database, node: NodeRow, changes: NodeEditChanges): NodeEditPlan {
  const { name, ...fields } = changes;
  const writes: PlannedWrite[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of filesForNode(db, node)) {
    const unwritable = unwritableReason(file.file_path);
    if (node.type === "artist" && name != null) {
      // The name search also finds it inside other names and titles ("Low"
      // in "Below"). Going by what the last scan read, a file that doesn't
      // credit them is passed over without opening it, unless its track is
      // linked to them; one the writer can't open only counts if it does.
      const credits = Object.keys(renameFor(db, file, creditsScanned(rawTags(file)), node.title, name)).length > 0;
      if (!credits && (!file.linked || unwritable || file.missing_since)) continue;
    }
    if (file.missing_since) {
      skipped.push({ fileId: file.id, path: file.file_path, reason: "The file is missing" });
      continue;
    }
    if (unwritable) {
      skipped.push({ fileId: file.id, path: file.file_path, reason: unwritable });
      continue;
    }
    try {
      const wanted = node.type === "artist" && name != null ? renameFor(db, file, creditsOnDisk(file.file_path), node.title, name) : fields;
      if (Object.keys(wanted).length === 0) continue;
      const diff = computeDiff(file.file_path, wanted);
      if (diff.length > 0) writes.push({ fileId: file.id, filePath: file.file_path, diff });
    } catch (err) {
      skipped.push({ fileId: file.id, path: file.file_path, reason: `Its tags couldn't be read: ${message(err)}` });
    }
  }

  return { writes, skipped, rename: renamePlan(db, node, changes) };
}

// An artist's new name and an album's new title rename the node itself; an
// album artist is part of an album's identity (rename.ts), so it counts too.
function renamePlan(db: Database, node: NodeRow, changes: NodeEditChanges): RenamePlan | null {
  if (node.type === "artist" && changes.name != null && changes.name !== node.title) {
    return { oldTitle: node.title, newTitle: changes.name, oldAlbumArtist: null, newAlbumArtist: null };
  }
  if (node.type !== "release") return null;
  const newTitle = changes.album != null && changes.album !== node.title ? changes.album : null;
  const oldAlbumArtist = albumArtistKey(db, node.id);
  const newAlbumArtist =
    changes.albumArtist != null && normalName(changes.albumArtist) !== oldAlbumArtist ? changes.albumArtist : null;
  if (newTitle == null && newAlbumArtist == null) return null;
  return { oldTitle: node.title, newTitle, oldAlbumArtist, newAlbumArtist };
}
