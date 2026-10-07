import type { Database } from "../sqlite.js";
import type { MbArtistCredit } from "../enrich/mbClient.js";

// Issue #273: the names that let splitArtistCredit (scan/artist-credit.ts)
// split a credit line joined by "," or "&". The separators can't tell
// "Cage The Elephant, Alison Mosshart" from "Crosby, Stills & Nash". These
// can, because each source names artists one at a time.

/** Keeps MusicBrainz's artist credit for a matched recording in
 *  field_provenance, where every other fact MusicBrainz reports about a
 *  recording goes. A null credit is still written: it records that
 *  MusicBrainz was asked and had none, so enrich/artistCredit.ts doesn't
 *  ask again. */
export function recordArtistCredit(db: Database, recordingNodeId: number, credit: MbArtistCredit | null): void {
  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'artist_credit', ?, 'musicbrainz', 1)",
  ).run(recordingNodeId, credit ? JSON.stringify(credit) : null);
}

export function hasArtistCredit(db: Database, recordingNodeId: number): boolean {
  return (
    db.prepare("SELECT 1 FROM field_provenance WHERE node_id = ? AND field = 'artist_credit'").get(recordingNodeId) !=
    null
  );
}

function artistCreditNames(db: Database, recordingNodeId: number): string[] {
  const row = db
    .prepare(
      "SELECT value FROM field_provenance WHERE node_id = ? AND field = 'artist_credit' ORDER BY id DESC LIMIT 1",
    )
    .get(recordingNodeId) as { value: string | null } | undefined;
  if (!row?.value) return [];
  try {
    return (JSON.parse(row.value) as MbArtistCredit).flatMap((entry) => [entry.name, entry.artist]);
  } catch {
    return [];
  }
}

type EvidenceTags = { artists?: string[] | null; featuredArtists?: string[] | null };

/** Names that can split this recording's performer line: the file's ARTISTS
 *  values and MusicBrainz's artist credit. featuredArtists is included
 *  because a library scanned before scan/artist-credit.ts existed stored
 *  the whole ARTISTS list there. */
export function performerEvidence(db: Database, recordingNodeId: number, tags: EvidenceTags): string[] {
  return [...(tags.artists ?? []), ...(tags.featuredArtists ?? []), ...artistCreditNames(db, recordingNodeId)];
}

/** Names that can split a producer or engineer line: the performer
 *  evidence, plus everyone MusicBrainz's relations credit on this recording
 *  one by one (enrich/credits.ts). The Fiona Apple production credit on
 *  Fetch the Bolt Cutters is four producer relations there. The relations
 *  aren't used for the performer line, where a duo's members are credited
 *  the same way ("Daryl Hall & John Oates" lists both as vocalists) and
 *  would split the act. */
export function creditEvidence(db: Database, recordingNodeId: number, performers: string[]): string[] {
  const related = db
    .prepare(
      `SELECT DISTINCT n.title FROM edges e JOIN nodes n ON n.id = e.to_node
        WHERE e.from_node = ? AND e.source = 'musicbrainz'`,
    )
    .all(recordingNodeId) as { title: string }[];
  return [...performers, ...related.map((r) => r.title)];
}
