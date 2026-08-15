import type Database from "better-sqlite3";
import { coverTargetNode, recordCover, resolveCover } from "../cover/extract.js";
import { storeCover } from "../cover/store.js";
import { broadcast } from "../ws.js";
import { fetchCaaFrontImage } from "./coverArchive.js";
import {
  fetchReleaseDetail,
  lookupReleaseGroupForRecording,
  searchRecording,
  searchRelease,
  type RecordingSearchInput,
} from "./mbClient.js";
import { enqueueCoverArtLookupIfNeeded } from "./queue.js";
import { assignTracks, pickBestRelease, scoreReleaseCandidate, type LocalAlbumInput, type LocalTrack } from "./releaseMatch.js";
import { looksSuspicious } from "./sanityCheck.js";
import { pickBestMatch, type LocalMatchInput } from "./textSearch.js";

const MAX_BACKOFF_SECONDS = 5 * 60;

type EnrichJob = { id: number; node_id: number; job_type: "recording_lookup" | "cover_art_lookup"; attempts: number };

function getNextDueJob(db: Database.Database): EnrichJob | undefined {
  return db
    .prepare(
      `SELECT id, node_id, job_type, attempts FROM enrich_jobs
       WHERE status IN ('queued','error') AND next_attempt_at <= datetime('now')
       ORDER BY priority DESC, id ASC
       LIMIT 1`,
    )
    .get() as EnrichJob | undefined;
}

type SearchInput = LocalMatchInput & RecordingSearchInput & { albumartist: string | null };

// M-2: everything the local tags already hold, not just title/artist —
// album, track number, total tracks and date all feed the widened
// MusicBrainz query and, for whatever comes back, M-3's weighted scorer.
// albumartist feeds M-6's release search specifically — the *track*
// artist (a featured guest, say) isn't necessarily who the album search
// should be scoped to.
function getSearchInput(db: Database.Database, nodeId: number): SearchInput | null {
  const node = db.prepare("SELECT title FROM nodes WHERE id = ?").get(nodeId) as { title: string } | undefined;
  if (!node) return null;

  const file = db
    .prepare("SELECT tags_raw FROM files WHERE recording_node_id = ? ORDER BY id LIMIT 1")
    .get(nodeId) as { tags_raw: string | null } | undefined;
  const tags = file?.tags_raw
    ? (JSON.parse(file.tags_raw) as {
        artist?: string | null;
        album?: string | null;
        albumartist?: string | null;
        trackNo?: number | null;
        totalTracks?: number | null;
        releaseDate?: string | null;
      })
    : null;
  if (!tags?.artist) return null;

  const recording = db.prepare("SELECT canonical_duration_ms FROM recordings WHERE node_id = ?").get(nodeId) as
    | { canonical_duration_ms: number | null }
    | undefined;

  return {
    title: node.title,
    artist: tags.artist,
    albumartist: tags.albumartist ?? null,
    album: tags.album ?? null,
    trackNo: tags.trackNo ?? null,
    totalTracks: tags.totalTracks ?? null,
    date: tags.releaseDate ?? null,
    durationMs: recording?.canonical_duration_ms ?? null,
  };
}

function recordProvenance(
  db: Database.Database,
  nodeId: number,
  value: string | null,
  confidence: number,
  note: string | null,
): void {
  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', ?, 'musicbrainz', ?, ?)",
  ).run(nodeId, value, confidence, note);
}

// Mirrors tier 1's local-mbid collapse (match/collapse.ts) but keyed by an
// enrichment-discovered mbid instead of one already embedded in tags: if a
// node already canonical for this mbid exists, repoint every file
// currently on this node to it; otherwise this node becomes canonical.
function applyMatch(db: Database.Database, nodeId: number, mbid: string, confidence: number): void {
  const canonical = db
    .prepare("SELECT id FROM nodes WHERE type = 'recording' AND mbid = ? AND id != ?")
    .get(mbid, nodeId) as { id: number } | undefined;

  if (canonical) {
    db.prepare(
      "UPDATE files SET recording_node_id = ?, match_source = 'mbid', match_confidence = ? WHERE recording_node_id = ?",
    ).run(canonical.id, confidence, nodeId);
  } else {
    db.prepare("UPDATE nodes SET mbid = ?, updated_at = datetime('now') WHERE id = ?").run(mbid, nodeId);
    db.prepare("UPDATE files SET match_source = 'mbid', match_confidence = ? WHERE recording_node_id = ?").run(
      confidence,
      nodeId,
    );
  }

  recordProvenance(db, nodeId, mbid, confidence, null);

  // A confident mbid on the recording is the only thing that makes a
  // Cover Art Archive lookup possible at all (it resolves through the
  // release the recording belongs to) — only worth queuing when that
  // release doesn't already have art from a faster source (embedded,
  // folder, or a manual override).
  const releaseNodeId = coverTargetNode(db, nodeId);
  if (releaseNodeId !== nodeId && !resolveCover(db, releaseNodeId)) {
    enqueueCoverArtLookupIfNeeded(db, releaseNodeId);
  }
}

type SiblingFile = { fileId: number; nodeId: number; trackNo: number | null; durationMs: number | null };

// Every currently-unmatched file sharing this album (and, when both sides
// have one, this album artist) — the group M-6's single release lookup
// resolves at once instead of issuing one independent search per file.
// Filtered in JS rather than a json_extract() WHERE clause: this library
// runs to hundreds of files, not enough for the difference to matter, and
// it keeps this working the same way regardless of whether the SQLite
// build has JSON1 compiled in.
function findUnmatchedAlbumSiblings(db: Database.Database, album: string, albumartist: string | null): SiblingFile[] {
  const rows = db
    .prepare(
      `SELECT f.id AS fileId, f.recording_node_id AS nodeId, f.tags_raw AS tagsRaw,
              r.canonical_duration_ms AS durationMs
       FROM files f JOIN recordings r ON r.node_id = f.recording_node_id
       WHERE f.match_source != 'mbid' AND f.missing_since IS NULL`,
    )
    .all() as { fileId: number; nodeId: number; tagsRaw: string | null; durationMs: number | null }[];

  const siblings: SiblingFile[] = [];
  for (const row of rows) {
    if (!row.tagsRaw) continue;
    const tags = JSON.parse(row.tagsRaw) as {
      album?: string | null;
      albumartist?: string | null;
      trackNo?: number | null;
    };
    if (tags.album !== album) continue;
    if (albumartist && tags.albumartist && tags.albumartist !== albumartist) continue;
    siblings.push({ fileId: row.fileId, nodeId: row.nodeId, trackNo: tags.trackNo ?? null, durationMs: row.durationMs });
  }
  return siblings;
}

// M-6: one release lookup instead of N per-recording ones. Only attempted
// when there's an album tag to group on; returns whether the *triggering*
// job's own node got matched this way, so the caller knows whether to
// fall through to the per-recording search still below it. Every sibling
// this resolves along the way (not just the one job that happened to run
// first) gets applied and its own pending job marked done — the actual
// point of grouping by album at all.
async function tryAlbumMatch(db: Database.Database, targetNodeId: number, input: SearchInput): Promise<boolean> {
  if (!input.album) return false;

  const siblings = findUnmatchedAlbumSiblings(db, input.album, input.albumartist);
  if (siblings.length === 0) return false;

  const releaseCandidates = await searchRelease({
    album: input.album,
    albumartist: input.albumartist ?? input.artist,
    totalTracks: input.totalTracks,
    date: input.date,
  });
  const localAlbum: LocalAlbumInput = {
    album: input.album,
    albumartist: input.albumartist ?? input.artist,
    totalTracks: input.totalTracks,
    releaseType: null,
    date: input.date,
  };
  const best = pickBestRelease(localAlbum, releaseCandidates);
  if (!best) return false;

  const detail = await fetchReleaseDetail(best.mbid);
  if (!detail || detail.tracks.length === 0) return false;

  const localTracks: LocalTrack[] = siblings.map((s) => ({
    fileId: s.fileId,
    trackNo: s.trackNo,
    durationMs: s.durationMs,
  }));
  const assignments = assignTracks(localTracks, detail);
  if (assignments.length === 0) return false;

  const confidence = scoreReleaseCandidate(localAlbum, best);
  const fileToNode = new Map(siblings.map((s) => [s.fileId, s.nodeId]));
  let matchedTarget = false;
  for (const { fileId, recordingMbid } of assignments) {
    const nodeId = fileToNode.get(fileId);
    if (nodeId == null) continue;
    applyMatch(db, nodeId, recordingMbid, confidence);
    // Resolved via this album lookup, not its own per-recording search —
    // don't let its own queued job redo the work.
    db.prepare(
      `UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now')
       WHERE node_id = ? AND job_type = 'recording_lookup' AND status IN ('queued','running')`,
    ).run(nodeId);
    broadcast("hygiene:changed", { nodeId });
    if (nodeId === targetNodeId) matchedTarget = true;
  }

  return matchedTarget;
}

async function processRecordingLookup(db: Database.Database, job: EnrichJob): Promise<void> {
  const input = getSearchInput(db, job.node_id);
  if (!input) {
    // No artist tag to search with at all — not a transient failure,
    // nothing will change on retry.
    recordProvenance(db, job.node_id, null, 0, "no local artist tag to search with");
    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
    broadcast("hygiene:changed", { nodeId: job.node_id });
    return;
  }

  if (looksSuspicious(input.title) || looksSuspicious(input.artist)) {
    recordProvenance(db, job.node_id, null, 0, "tag looks malformed — skipped search, needs a hygiene fix first");
    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
    broadcast("hygiene:changed", { nodeId: job.node_id });
    return;
  }

  if (await tryAlbumMatch(db, job.node_id, input)) {
    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
    return;
  }

  const candidates = await searchRecording(input);
  const result = pickBestMatch(candidates, input);

  if (result.outcome === "matched") {
    applyMatch(db, job.node_id, result.mbid, result.confidence);
  } else if (result.outcome === "ambiguous") {
    recordProvenance(
      db,
      job.node_id,
      null,
      0,
      `ambiguous — ${result.candidates.length} tied candidates, needs manual confirmation: ${result.candidates
        .map((c) => c.mbid)
        .join(", ")}`,
    );
  } else {
    recordProvenance(db, job.node_id, null, 0, "no MusicBrainz match found");
  }

  db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
  broadcast("hygiene:changed", { nodeId: job.node_id });
}

// job.node_id is a *release* node here, not a recording — see 0014's
// migration note on enrich_jobs.node_id's job_type-dependent meaning.
// Every outcome (already has art, no matched recording to hang a lookup
// off of, no release-group found, CAA has nothing for it) marks the job
// done rather than an error: none of them are transient, so nothing would
// change on a retry.
async function processCoverArtLookup(db: Database.Database, job: EnrichJob): Promise<void> {
  const releaseNodeId = job.node_id;

  if (resolveCover(db, releaseNodeId)) {
    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
    return;
  }

  const recording = db
    .prepare(
      `SELECT n.mbid AS mbid
       FROM edges e JOIN nodes n ON n.id = e.from_node
       WHERE e.to_node = ? AND e.type = 'appears_on' AND n.mbid IS NOT NULL
       LIMIT 1`,
    )
    .get(releaseNodeId) as { mbid: string } | undefined;

  const releaseGroupMbid = recording ? await lookupReleaseGroupForRecording(recording.mbid) : null;
  const image = releaseGroupMbid ? await fetchCaaFrontImage(releaseGroupMbid) : null;

  if (image) {
    const hash = await storeCover(image.bytes);
    recordCover(db, { nodeId: releaseNodeId, source: "caa", hash, mime: image.mime });
    broadcast("hygiene:changed", { nodeId: releaseNodeId });
  }

  db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
}

async function processJob(db: Database.Database, job: EnrichJob): Promise<void> {
  db.prepare("UPDATE enrich_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(job.id);

  try {
    if (job.job_type === "cover_art_lookup") {
      await processCoverArtLookup(db, job);
    } else {
      await processRecordingLookup(db, job);
    }
  } catch (err) {
    // Network/API failures are transient — back off and retry, unlike the
    // terminal outcomes above (suspicious/ambiguous/no_match are real
    // answers, not errors).
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    const backoffSeconds = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);
    // Computed via SQLite's own datetime() rather than JS's toISOString()
    // — the latter produces "2026-01-01T00:00:00.000Z" while SQLite's
    // datetime('now') (used in the due-job WHERE clause) produces
    // "2026-01-01 00:00:00". Those don't compare correctly as TEXT: 'T'
    // (0x54) sorts after a space, so next_attempt_at <= datetime('now')
    // was silently always false and retries never fired. Real bug, caught
    // by actually waiting for a live retry rather than trusting the code.
    db.prepare(
      `UPDATE enrich_jobs SET status = 'error', attempts = ?,
         next_attempt_at = datetime('now', ? || ' seconds'),
         last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(attempts, `+${backoffSeconds}`, message, job.id);
  }
}

let running = false;

// Drains every currently-due job, one at a time (mbClient's own throttle
// enforces the 1req/sec spacing). Safe to call repeatedly/concurrently —
// the `running` guard means overlapping calls (e.g. a poller tick landing
// mid-drain) just no-op instead of double-processing.
export async function runDueJobs(db: Database.Database): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = getNextDueJob(db);
      if (!job) break;
      await processJob(db, job);
    }
  } finally {
    running = false;
  }
}
