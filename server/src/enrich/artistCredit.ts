import type { Database } from "../sqlite.js";
import { deriveRecordingEdges } from "../match/edges.js";
import { hasArtistCredit, recordArtistCredit } from "../match/evidence.js";
import { recompute } from "../recompute.js";
import { parseTags } from "../scan/tags.js";
import { broadcast } from "../ws.js";
import { fetchRecordingArtistCredit, type MbArtistCredit } from "./mbClient.js";
import { isEnrichmentEnabled } from "./queue.js";

// Issue #273: a credit line joined by "," or "&" splits only on evidence
// (match/evidence.ts), and a library scanned before this kept none of it.
// tags_raw dropped the ARTISTS values the credit mentions, and MusicBrainz's
// artist credit was used to pick a match and then thrown away. One
// 'artist_credit_lookup' job per recording that has such a line fills both
// gaps: it reads the file's ARTISTS tag again, and asks MusicBrainz for the
// credit when the recording is matched. Then it re-derives the recording's
// edges, which splits the line and retires the joined node.
//
// Each half records that it ran: tags_raw gains an `artists` key, null or
// not, and the credit is kept in field_provenance, null when MusicBrainz had
// none. A recording is queued while either half is outstanding and no job
// of this type is already waiting for it, so nothing is asked twice, and a
// recording matched later (by fingerprint, or from the maintenance view)
// is picked up at the next start.

const JOB_TYPE = "artist_credit_lookup";

// Ahead of the membership crawl, whose queue can run to six figures on a
// large library (#269): these are a few hundred requests that fix names
// the map is already showing wrong.
const PRIORITY = 1;

const JOINED_LINE = /[,&]/;

type CreditLines = {
  artist?: string | null;
  producer?: string[] | null;
  engineer?: string[] | null;
  artists?: unknown;
};

function parseTagsRaw(tagsRaw: string | null): CreditLines | null {
  if (!tagsRaw) return null;
  try {
    return JSON.parse(tagsRaw) as CreditLines;
  } catch {
    return null;
  }
}

function hasJoinedLine(tags: CreditLines): boolean {
  return [tags.artist, ...(tags.producer ?? []), ...(tags.engineer ?? [])].some(
    (line) => line && JOINED_LINE.test(line),
  );
}

/** Queues a lookup for every recording with a joined line and evidence
 *  still to gather. Called on every start (index.ts); a library already
 *  caught up queues nothing. Returns how many it queued. */
export function enqueueArtistCreditLookups(db: Database): number {
  if (!isEnrichmentEnabled(db)) return 0;

  const rows = db
    .prepare(
      `SELECT f.recording_node_id AS nodeId, f.tags_raw AS tagsRaw, n.mbid
         FROM files f JOIN nodes n ON n.id = f.recording_node_id
        WHERE f.missing_since IS NULL`,
    )
    .all() as { nodeId: number; tagsRaw: string | null; mbid: string | null }[];

  const recordings = new Map<number, { joined: boolean; unread: boolean; mbid: string | null }>();
  for (const row of rows) {
    const tags = parseTagsRaw(row.tagsRaw);
    if (!tags) continue;
    const recording = recordings.get(row.nodeId) ?? { joined: false, unread: false, mbid: row.mbid };
    recording.joined ||= hasJoinedLine(tags);
    recording.unread ||= !("artists" in tags);
    recordings.set(row.nodeId, recording);
  }

  const waiting = db.prepare(
    "SELECT 1 FROM enrich_jobs WHERE node_id = ? AND job_type = ? AND status IN ('queued','running','error')",
  );
  const insert = db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status, priority) VALUES (?, ?, 'queued', ?)");
  let queued = 0;
  db.transaction(() => {
    for (const [nodeId, { joined, unread, mbid }] of recordings) {
      if (!joined) continue;
      if (!unread && !(mbid && !hasArtistCredit(db, nodeId))) continue;
      if (waiting.get(nodeId, JOB_TYPE)) continue;
      insert.run(nodeId, JOB_TYPE, PRIORITY);
      queued++;
    }
  })();
  return queued;
}

// The people this recording's tags credit, to tell whether a lookup moved
// anything.
function personEdges(db: Database, recordingNodeId: number): string {
  return JSON.stringify(
    db
      .prepare(
        `SELECT to_node, type FROM edges WHERE from_node = ? AND source = 'local'
          AND type IN ('performed_by', 'featured_artist', 'produced_by', 'engineered_by') ORDER BY to_node, type`,
      )
      .all(recordingNodeId),
  );
}

// An artist that a split creates has no map position or artists-table row
// until the next recompute. Running one per job would recompute a whole
// library hundreds of times, so it runs once, when the last queued lookup
// finishes having changed something. A restart in between loses this
// flag, and the next scan's recompute does the same work.
let changedSinceRecompute = false;

/** One recording's lookup. A file that can't be reached (an unmounted
 *  drive) throws, so the worker retries it with back-off. A file that can
 *  be read but not parsed has no ARTISTS tag to give, and is marked read. */
export async function processArtistCreditLookup(db: Database, job: { id: number; node_id: number }): Promise<void> {
  const files = db
    .prepare(
      "SELECT id, file_path, tags_raw FROM files WHERE recording_node_id = ? AND missing_since IS NULL ORDER BY id",
    )
    .all(job.node_id) as { id: number; file_path: string; tags_raw: string | null }[];

  for (const file of files) {
    const tags = parseTagsRaw(file.tags_raw);
    if (!tags || "artists" in tags) continue;
    let artists: string[] | null = null;
    try {
      artists = (await parseTags(file.file_path)).tags.artists;
    } catch (err) {
      if (typeof (err as NodeJS.ErrnoException).code === "string") throw err;
    }
    // Only the new field is merged in. The rest of tags_raw stays what the
    // last scan wrote, and a file edited since is read in full by the next.
    db.prepare("UPDATE files SET tags_raw = ? WHERE id = ?").run(JSON.stringify({ ...tags, artists }), file.id);
  }

  const node = db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(job.node_id) as
    { mbid: string | null } | undefined;
  if (node?.mbid && !hasArtistCredit(db, job.node_id)) {
    recordArtistCredit(db, job.node_id, await fetchRecordingArtistCredit(node.mbid));
  }

  const before = personEdges(db, job.node_id);
  deriveRecordingEdges(db, job.node_id);
  if (personEdges(db, job.node_id) !== before) changedSinceRecompute = true;

  db.prepare("UPDATE enrich_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(job.id);

  const more = db.prepare("SELECT 1 FROM enrich_jobs WHERE job_type = ? AND status = 'queued'").get(JOB_TYPE);
  if (!more && changedSinceRecompute) {
    changedSinceRecompute = false;
    recompute(db);
    // What the canvas already refetches on (src/canvas/useGraphData.ts).
    broadcast("enrich:applied", { kind: "artist_credit" });
  }
}

/** For a recording that has just been matched: keeps the artist credit the
 *  match came with, so it never has to be fetched again, and re-derives the
 *  recording's edges against it and against the MusicBrainz credits just
 *  applied. A joined line splits as soon as MusicBrainz says how; a
 *  recording without one has nothing the evidence can change, and is left
 *  as the scan derived it. The recording is whichever node holds `mbid`
 *  now, since applyMatch (worker.ts) moves files onto an existing node for
 *  the same recording. */
export function applyMatchedArtistCredit(db: Database, mbid: string, credit: MbArtistCredit | null | undefined): void {
  const node = db.prepare("SELECT id FROM nodes WHERE type = 'recording' AND mbid = ?").get(mbid) as
    { id: number } | undefined;
  if (!node) return;
  if (credit) recordArtistCredit(db, node.id, credit);

  const lines = db
    .prepare("SELECT tags_raw FROM files WHERE recording_node_id = ? AND missing_since IS NULL")
    .all(node.id) as { tags_raw: string | null }[];
  if (lines.some((file) => hasJoinedLine(parseTagsRaw(file.tags_raw) ?? {}))) deriveRecordingEdges(db, node.id);
}
