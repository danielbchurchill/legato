import type Database from "better-sqlite3";
import { coverTargetNode, recordCover, resolveCover } from "../cover/extract.js";
import { storeCover } from "../cover/store.js";
import { computeFingerprint } from "../match/fingerprint.js";
import { broadcast } from "../ws.js";
import { ACOUSTID_API_KEY } from "../config.js";
import { lookupFingerprint } from "./acoustid.js";
import { looksLikeMultipleArtists, pickArtistMatch } from "./artistName.js";
import { fetchCaaFrontImage } from "./coverArchive.js";
import { fetchArtistImage } from "./deezer.js";
import { recordDescription } from "./descriptions.js";
import {
  fetchReleaseDetail,
  fetchUrlRelations,
  lookupReleaseGroupForRecording,
  searchArtist,
  searchRecording,
  searchRelease,
  type MbUrlRelation,
  type RecordingSearchInput,
} from "./mbClient.js";
import { fetchDescriptionFromRelations } from "./wikipedia.js";
import { applyCredits, recordIsrc, recordReleaseFields } from "./credits.js";
import { enqueueCoverArtLookupIfNeeded } from "./queue.js";
import { assignTracks, pickBestRelease, scoreReleaseCandidate, type LocalAlbumInput, type LocalTrack } from "./releaseMatch.js";
import { looksSuspicious } from "./sanityCheck.js";
import { pickBestMatch, scoreCandidate, type LocalMatchInput } from "./textSearch.js";

const MAX_BACKOFF_SECONDS = 5 * 60;
// AcoustID's own acoustic-match confidence (0-1), not textSearch.ts's
// weighted field score — provisional, same as the similarity feature
// weights, since this can't be tuned against real results in an
// environment with neither fpcalc nor a client key available (see
// enrich/acoustid.ts). AcoustID/Picard both treat scores below roughly
// this range as too weak to trust unattended.
const MIN_ACOUSTID_SCORE = 0.5;

// An artist MBID resolved from a name and MusicBrainz's own relevance ranking,
// and nothing else. Not 1: unlike recordReleaseFields' release-level facts
// (which MusicBrainz asserts about a release this library has already matched),
// this is the outcome of a search with one weak signal to go on. High enough to
// act on, low enough that a later stronger source should win.
const ARTIST_NAME_MATCH_CONFIDENCE = 0.8;

// Recorded on every descriptions row so a second provider can be added later
// without anything downstream having to guess where existing prose came from.
const DESCRIPTION_SOURCE = "wikipedia";

type EnrichJobType = "recording_lookup" | "cover_art_lookup" | "artist_image_lookup" | "description_lookup";

type EnrichJob = { id: number; node_id: number; job_type: EnrichJobType; attempts: number };

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
// Exported for routes/hygiene.ts (M-5): resolving an ambiguous match from
// the maintenance view writes the chosen mbid through this exact path,
// not a separate one — a manually-resolved match should behave
// identically to a confident automatic one everywhere downstream.
export function applyMatch(db: Database.Database, nodeId: number, mbid: string, confidence: number): void {
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
  // Any candidates left over from a previous ambiguous attempt no longer
  // apply — this node has a real match now.
  db.prepare("DELETE FROM match_candidates WHERE node_id = ?").run(nodeId);

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

type SiblingFile = { fileId: number; nodeId: number; trackNo: number | null; discNo: number | null; durationMs: number | null };

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
      discNo?: number | null;
    };
    if (tags.album !== album) continue;
    if (albumartist && tags.albumartist && tags.albumartist !== albumartist) continue;
    siblings.push({
      fileId: row.fileId,
      nodeId: row.nodeId,
      trackNo: tags.trackNo ?? null,
      discNo: tags.discNo ?? null,
      durationMs: row.durationMs,
    });
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
    discNo: s.discNo,
    durationMs: s.durationMs,
  }));
  // Every recording MBID already sitting on a node for this album — the
  // files an earlier pass resolved, which are no longer siblings and so are
  // otherwise invisible to the assignment.
  const alreadyUsedMbids = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT n.mbid FROM nodes n
             JOIN files f ON f.recording_node_id = n.id
            WHERE n.type = 'recording' AND n.mbid IS NOT NULL AND f.missing_since IS NULL`,
        )
        .all() as { mbid: string }[]
    ).map((r) => r.mbid),
  );
  const assignments = assignTracks(localTracks, detail, alreadyUsedMbids);
  if (assignments.length === 0) return false;

  const confidence = scoreReleaseCandidate(localAlbum, best);
  const fileToNode = new Map(siblings.map((s) => [s.fileId, s.nodeId]));
  // M-8: the same fetchReleaseDetail call that resolves each track's
  // recording MBID already carries its credits/ISRC and the release's own
  // identifiers — join back to it by recording MBID rather than a second
  // request.
  const trackByMbid = new Map(detail.tracks.map((t) => [t.recordingMbid, t]));
  let matchedTarget = false;
  let releaseNodeId: number | null = null;
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

    const track = trackByMbid.get(recordingMbid);
    if (track) {
      applyCredits(db, nodeId, track.credits);
      recordIsrc(db, nodeId, track.isrc);
    }
    if (releaseNodeId == null) {
      const resolved = coverTargetNode(db, nodeId);
      if (resolved !== nodeId) releaseNodeId = resolved;
    }

    broadcast("hygiene:changed", { nodeId });
    if (nodeId === targetNodeId) matchedTarget = true;
  }

  if (releaseNodeId != null) recordReleaseFields(db, releaseNodeId, detail);

  return matchedTarget;
}

// M-9: text search's last resort. Reached whenever there was nothing
// useful to search with in the first place (no artist tag, a malformed
// one) or a real search came back with nothing — every case textSearch.ts
// structurally cannot fix, since there's no text signal to weigh. A
// fingerprint doesn't need one: it identifies the recording from the audio
// itself. Quietly returns false (never throws) whenever the tier isn't
// available at all — no local file, fpcalc missing, no duration to send
// AcoustID, no API key configured, or nothing scored high enough to trust.
export async function tryFingerprintMatch(db: Database.Database, nodeId: number): Promise<boolean> {
  const file = db
    .prepare("SELECT file_path FROM files WHERE recording_node_id = ? AND missing_since IS NULL ORDER BY id LIMIT 1")
    .get(nodeId) as { file_path: string } | undefined;
  if (!file) return false;

  const fingerprint = await computeFingerprint(file.file_path);
  if (!fingerprint) return false;

  const recording = db.prepare("SELECT canonical_duration_ms FROM recordings WHERE node_id = ?").get(nodeId) as
    | { canonical_duration_ms: number | null }
    | undefined;
  if (!recording?.canonical_duration_ms) return false; // AcoustID's lookup requires a duration

  const matches = await lookupFingerprint(ACOUSTID_API_KEY, fingerprint, recording.canonical_duration_ms / 1000);
  const best = matches[0];
  if (!best || best.score < MIN_ACOUSTID_SCORE) return false;

  applyMatch(db, nodeId, best.recordingMbid, best.score);
  return true;
}

async function processRecordingLookup(db: Database.Database, job: EnrichJob): Promise<void> {
  const input = getSearchInput(db, job.node_id);
  if (!input) {
    // No artist tag to search with at all — text search structurally can't
    // help, but the audio itself might still identify the file outright.
    if (!(await tryFingerprintMatch(db, job.node_id))) {
      recordProvenance(db, job.node_id, null, 0, "no local artist tag to search with");
    }
    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);
    broadcast("hygiene:changed", { nodeId: job.node_id });
    return;
  }

  if (looksSuspicious(input.title) || looksSuspicious(input.artist)) {
    if (!(await tryFingerprintMatch(db, job.node_id))) {
      recordProvenance(db, job.node_id, null, 0, "tag looks malformed — skipped search, needs a hygiene fix first");
    }
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

  // Any new attempt supersedes whatever a previous one left behind — a
  // stale candidate list from an earlier, worse-scoring attempt has no
  // business surviving next to this one.
  db.prepare("DELETE FROM match_candidates WHERE node_id = ?").run(job.node_id);

  if (result.outcome === "matched") {
    applyMatch(db, job.node_id, result.mbid, result.confidence);
  } else if (result.outcome === "ambiguous") {
    // M-5: candidates go in a real table the maintenance view can act on,
    // not just named in the note — the note keeps the count for the log
    // line, since the UUIDs themselves used to be dumped there too, and
    // the frontend was already trimming them back out client-side.
    recordProvenance(db, job.node_id, null, 0, `ambiguous — ${result.candidates.length} tied candidates, needs manual confirmation`);
    const insertCandidate = db.prepare(
      `INSERT INTO match_candidates (node_id, mbid, release_title, release_date, duration_ms, score)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const c of result.candidates) {
      const release = c.releases[0];
      // The weighted 0-1 confidence (textSearch.ts's own scoreCandidate),
      // not MusicBrainz's raw 0-100 relevance score — storing the raw
      // score here would both order the picker by exactly the flawed
      // signal M-3 exists to fix (every tied candidate scores 100) and
      // write a nonsense match_confidence if this candidate is later
      // resolved, since applyMatch's confidence parameter is a fraction
      // everywhere else in the app.
      insertCandidate.run(
        job.node_id,
        c.mbid,
        release?.title ?? null,
        release?.date ?? null,
        c.durationMs,
        scoreCandidate(input, c),
      );
    }
  } else if (!(await tryFingerprintMatch(db, job.node_id))) {
    // no_match, and the fingerprint fallback couldn't do any better either.
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

// Artist MBID, resolved by name and then remembered.
//
// Artist nodes are built from tag text (entities/aggregate.ts) and never carry
// an MBID — only recordings get one, from the match pipeline — so this is the
// hop every artist-level MusicBrainz question has to make first. Stored in
// field_provenance rather than nodes.mbid deliberately: nodes.mbid is identity
// (match/collapse.ts collapses on it), and an MBID resolved from nothing but a
// name is not strong enough to redefine which node a file belongs to. Same
// call recordReleaseFields already makes for release-level identifiers.
//
// Which of the artists sharing a name it actually is comes from
// pickArtistMatch (enrich/artistName.ts), not from taking the first result —
// the note records MusicBrainz's own disambiguation text for whichever one was
// chosen, so the decision is auditable rather than implicit.
async function resolveArtistMbid(db: Database.Database, nodeId: number, name: string): Promise<string | null> {
  const cached = db
    .prepare("SELECT value FROM field_provenance WHERE node_id = ? AND field = 'artist_mbid' ORDER BY id DESC LIMIT 1")
    .get(nodeId) as { value: string | null } | undefined;
  if (cached?.value) return cached.value;

  const match = pickArtistMatch(name, await searchArtist(name));
  if (!match) return null;

  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'artist_mbid', ?, 'musicbrainz', ?, ?)",
  ).run(nodeId, match.mbid, ARTIST_NAME_MATCH_CONFIDENCE, match.disambiguation);
  return match.mbid;
}

// The release-group an album belongs to, which is what carries an album's
// external links (a release is one edition; the article is about the record).
// M-8's album-first match already stores this when it ran, so the common case
// is a table read; otherwise it costs the same recording -> release-group hop
// the Cover Art Archive lookup makes, and is written back so it only ever
// happens once per album.
async function resolveReleaseGroupMbid(db: Database.Database, releaseNodeId: number): Promise<string | null> {
  const cached = db
    .prepare(
      "SELECT value FROM field_provenance WHERE node_id = ? AND field = 'release_group_mbid' ORDER BY id DESC LIMIT 1",
    )
    .get(releaseNodeId) as { value: string | null } | undefined;
  if (cached?.value) return cached.value;

  const recording = db
    .prepare(
      `SELECT n.mbid AS mbid
       FROM edges e JOIN nodes n ON n.id = e.from_node
       WHERE e.to_node = ? AND e.type = 'appears_on' AND n.mbid IS NOT NULL
       LIMIT 1`,
    )
    .get(releaseNodeId) as { mbid: string } | undefined;
  if (!recording) return null;

  const releaseGroupMbid = await lookupReleaseGroupForRecording(recording.mbid);
  if (!releaseGroupMbid) return null;

  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'release_group_mbid', ?, 'musicbrainz', 1)",
  ).run(releaseNodeId, releaseGroupMbid);
  return releaseGroupMbid;
}

// job.node_id is an *artist* node here. Every outcome marks the job done:
// a tag that names two artists will still name two artists tomorrow, and
// Deezer not having a photo is an answer, not a failure. Only a thrown
// network error reaches the retry/backoff path below.
async function processArtistImageLookup(db: Database.Database, job: EnrichJob): Promise<void> {
  const finish = () =>
    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);

  const node = db.prepare("SELECT title FROM nodes WHERE id = ? AND type = 'artist'").get(job.node_id) as
    | { title: string }
    | undefined;
  if (!node) {
    finish();
    return;
  }

  // Art of its own already — a photo from an earlier run, or a manual
  // override, which must never be displaced (cover/extract.ts's PRECEDENCE).
  // The inherited album-art fallback doesn't count: replacing that with a real
  // photograph is the entire point of this job.
  if (resolveCover(db, job.node_id)) {
    finish();
    return;
  }

  if (looksLikeMultipleArtists(node.title)) {
    // Not a failure and not retryable: "Pussy Riot; Slayyyter" is a credit
    // line, and no name search can resolve it to one artist. Recorded so the
    // maintenance view can show why this node has no photo.
    recordProvenance(db, job.node_id, null, 0, "artist tag names more than one artist — no photo looked up");
    finish();
    return;
  }

  const image = await fetchArtistImage(node.title);
  if (image) {
    const hash = await storeCover(image.bytes);
    recordCover(db, {
      nodeId: job.node_id,
      source: "artist_image",
      hash,
      mime: image.mime,
      originPath: image.sourceUrl,
    });
    // The canvas is already on screen when this lands, minutes into a queue
    // drain — without an event it would keep drawing the borrowed album cover
    // until the next reload.
    broadcast("enrich:applied", { nodeId: job.node_id, kind: "artist_image" });
  }

  finish();
}

// job.node_id is an artist or release node. Same terminal-outcome policy as
// the artist image above, with the miss written to descriptions (found = 0) so
// nothing re-asks on the next scan.
async function processDescriptionLookup(db: Database.Database, job: EnrichJob): Promise<void> {
  const finish = () =>
    db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);

  const node = db.prepare("SELECT type, title FROM nodes WHERE id = ?").get(job.node_id) as
    | { type: string; title: string }
    | undefined;
  if (!node) {
    finish();
    return;
  }

  let relations: MbUrlRelation[] = [];
  if (node.type === "artist") {
    if (looksLikeMultipleArtists(node.title)) {
      recordDescription(db, job.node_id, DESCRIPTION_SOURCE, null);
      finish();
      return;
    }
    const artistMbid = await resolveArtistMbid(db, job.node_id, node.title);
    if (artistMbid) relations = await fetchUrlRelations("artist", artistMbid);
  } else if (node.type === "release") {
    const releaseGroupMbid = await resolveReleaseGroupMbid(db, job.node_id);
    if (releaseGroupMbid) relations = await fetchUrlRelations("release-group", releaseGroupMbid);
  } else {
    // Recordings, labels, credits and years get no description: a per-track
    // encyclopedia article rarely exists, and where one does it repeats the
    // album's. Left as an explicit branch rather than a filter at the enqueue
    // site so a job created by hand for the wrong node type does nothing
    // instead of something strange.
    finish();
    return;
  }

  const description = relations.length > 0 ? await fetchDescriptionFromRelations(relations) : null;
  recordDescription(db, job.node_id, DESCRIPTION_SOURCE, description);
  if (description) broadcast("enrich:applied", { nodeId: job.node_id, kind: "description" });

  finish();
}

async function processJob(db: Database.Database, job: EnrichJob): Promise<void> {
  db.prepare("UPDATE enrich_jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(job.id);

  try {
    if (job.job_type === "cover_art_lookup") {
      await processCoverArtLookup(db, job);
    } else if (job.job_type === "artist_image_lookup") {
      await processArtistImageLookup(db, job);
    } else if (job.job_type === "description_lookup") {
      await processDescriptionLookup(db, job);
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
