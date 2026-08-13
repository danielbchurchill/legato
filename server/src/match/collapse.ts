import type Database from "better-sqlite3";
import { computeFingerprint } from "./fingerprint.js";

type FileRow = {
  id: number;
  recording_node_id: number;
  file_path: string;
  tags_raw: string | null;
  match_source: string;
};

type ParsedTags = {
  mbRecordingId?: string | null;
  title?: string | null;
  artist?: string | null;
  durationMs?: number | null;
};

const FUZZY_DURATION_TOLERANCE_MS = 2000;

function parseTagsRaw(tagsRaw: string | null): ParsedTags | null {
  if (!tagsRaw) return null;
  try {
    return JSON.parse(tagsRaw) as ParsedTags;
  } catch {
    return null;
  }
}

function normalizeForFuzzyMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents left behind by NFKD
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function setMatch(
  db: Database.Database,
  fileId: number,
  recordingNodeId: number,
  matchSource: string,
  confidence: number,
  fuzzyCandidateNodeId: number | null = null,
): void {
  db.prepare(
    `UPDATE files SET recording_node_id = ?, match_source = ?, match_confidence = ?,
       fuzzy_candidate_node_id = ? WHERE id = ?`,
  ).run(recordingNodeId, matchSource, confidence, fuzzyCandidateNodeId, fileId);
}

// A forced split needs the file to have a node to itself. If it's already
// alone at its current node (e.g. a repeat re-scan after a previous split),
// this is a no-op — otherwise every re-scan would fork off a fresh orphaned
// node forever, since merge_overrides is checked unconditionally every time.
function ensureStandaloneNode(db: Database.Database, file: FileRow): number {
  const siblings = db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE recording_node_id = ? AND id != ?")
    .get(file.recording_node_id, file.id) as { n: number };
  if (siblings.n === 0) return file.recording_node_id;

  const title = parseTagsRaw(file.tags_raw)?.title ?? file.file_path;
  const node = db
    .prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id")
    .get(title) as { id: number };
  db.prepare(
    "INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, (SELECT duration_ms FROM files WHERE id = ?))",
  ).run(node.id, file.id);
  return node.id;
}

// The user layer always wins and is never re-evaluated by the tiers below —
// checked first, on every re-scan, per Legato's node-collapse design.
function applyOverrideIfPresent(db: Database.Database, file: FileRow): boolean {
  const override = db
    .prepare(
      "SELECT forced_recording_node_id FROM merge_overrides WHERE file_id = ? ORDER BY decided_at DESC LIMIT 1",
    )
    .get(file.id) as { forced_recording_node_id: number | null } | undefined;
  if (!override) return false;

  if (override.forced_recording_node_id != null) {
    setMatch(db, file.id, override.forced_recording_node_id, "manual", 1.0);
  } else {
    setMatch(db, file.id, ensureStandaloneNode(db, file), "manual", 1.0);
  }
  return true;
}

// Tier 1 — same MusicBrainz recording MBID, read from locally embedded tags
// only (a live MusicBrainz text-search lookup that assigns an MBID to an
// untagged file is M7's job, not this). High confidence: matched files only.
function tryMbidMatch(db: Database.Database, file: FileRow): boolean {
  const mbid = parseTagsRaw(file.tags_raw)?.mbRecordingId;
  if (!mbid) return false;

  const canonical = db
    .prepare("SELECT id FROM nodes WHERE type = 'recording' AND mbid = ? AND id != ?")
    .get(mbid, file.recording_node_id) as { id: number } | undefined;

  if (canonical) {
    setMatch(db, file.id, canonical.id, "mbid", 1.0);
  } else {
    // No canonical node for this mbid yet — this file's own node becomes it.
    db.prepare("UPDATE nodes SET mbid = ?, updated_at = datetime('now') WHERE id = ?").run(
      mbid,
      file.recording_node_id,
    );
    setMatch(db, file.id, file.recording_node_id, "mbid", 1.0);
  }
  return true;
}

// Tier 2 — same local Chromaprint fingerprint among files with no mbid tag.
// Medium confidence: catches untagged/mistagged rips no text match would.
// Fingerprinting is local-only (see fingerprint.ts); if fpcalc isn't
// installed this tier silently never matches, which is fine — it degrades
// to relying on tier 3, it doesn't break anything.
async function tryAcoustidMatch(db: Database.Database, file: FileRow): Promise<boolean> {
  let fingerprint = (
    db.prepare("SELECT acoustid FROM recordings WHERE node_id = ?").get(file.recording_node_id) as
      | { acoustid: string | null }
      | undefined
  )?.acoustid ?? null;

  if (!fingerprint) {
    fingerprint = await computeFingerprint(file.file_path);
    if (fingerprint) {
      db.prepare("UPDATE recordings SET acoustid = ? WHERE node_id = ?").run(
        fingerprint,
        file.recording_node_id,
      );
    }
  }
  if (!fingerprint) return false;

  const canonical = db
    .prepare(
      `SELECT n.id FROM nodes n JOIN recordings r ON r.node_id = n.id
       WHERE n.type = 'recording' AND n.mbid IS NULL AND r.acoustid = ? AND n.id != ?`,
    )
    .get(fingerprint, file.recording_node_id) as { id: number } | undefined;

  if (!canonical) return false;
  setMatch(db, file.id, canonical.id, "acoustid", 0.85);
  return true;
}

// Tier 3 — fuzzy artist+title+duration among still-unmatched files. Low
// confidence: flags a candidate but never merges silently — confirmation
// happens via POST /api/v1/merge-overrides against GET /merge-suggestions.
function tryFuzzyMatch(db: Database.Database, file: FileRow): boolean {
  const tags = parseTagsRaw(file.tags_raw);
  if (!tags?.title || !tags?.artist) return false;

  const normTitle = normalizeForFuzzyMatch(tags.title);
  const normArtist = normalizeForFuzzyMatch(tags.artist);

  const candidates = db
    .prepare(
      `SELECT f.id AS file_id, f.recording_node_id, f.tags_raw
       FROM files f
       JOIN nodes n ON n.id = f.recording_node_id
       WHERE n.type = 'recording' AND n.mbid IS NULL
         AND f.match_source IN ('unmatched', 'fuzzy_pending')
         AND f.id != ?`,
    )
    .all(file.id) as { file_id: number; recording_node_id: number; tags_raw: string | null }[];

  for (const candidate of candidates) {
    const candidateTags = parseTagsRaw(candidate.tags_raw);
    if (!candidateTags?.title || !candidateTags?.artist) continue;
    if (normalizeForFuzzyMatch(candidateTags.title) !== normTitle) continue;
    if (normalizeForFuzzyMatch(candidateTags.artist) !== normArtist) continue;
    if (tags.durationMs != null && candidateTags.durationMs != null) {
      if (Math.abs(tags.durationMs - candidateTags.durationMs) > FUZZY_DURATION_TOLERANCE_MS) continue;
    }

    db.prepare(
      "UPDATE files SET match_source = 'fuzzy_pending', fuzzy_candidate_node_id = ? WHERE id = ?",
    ).run(candidate.recording_node_id, file.id);
    return true;
  }
  return false;
}

export async function collapseFile(db: Database.Database, fileId: number): Promise<void> {
  const file = db
    .prepare("SELECT id, recording_node_id, file_path, tags_raw, match_source FROM files WHERE id = ?")
    .get(fileId) as FileRow | undefined;
  if (!file) return;

  if (applyOverrideIfPresent(db, file)) return;
  if (tryMbidMatch(db, file)) return;
  if (await tryAcoustidMatch(db, file)) return;
  tryFuzzyMatch(db, file);
  // Otherwise stays 'unmatched' — no evidence yet, not an error.
}
