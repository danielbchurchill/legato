import type { Database } from "../sqlite.js";
import { findOrCreatePerson } from "../match/edges.js";
import { markBoundMayHaveShrunk } from "./members.js";
import type { MbCredit, MbReleaseDetail } from "./mbClient.js";

// M-8: producer/engineer/mix/mastering/conductor/arranger/remixer/DJ-mixer
// map onto edge types the same way match/edges.ts's local-tag-derived
// produced_by/engineered_by already do (that module owns the local-source
// versions of the first two; this one owns the wider musicbrainz-source
// set). vocal/instrument/performer relations carry the actual part in
// MbCredit.attributes ("electric guitar"), which no single edge type can
// express — those share one edge type instead, with the attribute as the
// edge's own label.
const CREDIT_EDGE_TYPE: Record<string, string> = {
  producer: "produced_by",
  engineer: "engineered_by",
  mix: "mixed_by",
  mastering: "mastered_by",
  arranger: "arranged_by",
  "instrument arranger": "arranged_by",
  "vocal arranger": "arranged_by",
  conductor: "conducted_by",
  remixer: "remixed_by",
  "DJ-mixer": "dj_mixed_by",
};
const PERFORMED_CREDIT_TYPES = new Set(["vocal", "instrument", "performer"]);

// Re-derives from scratch, the same idempotency idiom match/edges.ts's
// deriveLocalEdges uses for source='local' edges: this recording's own
// source='musicbrainz' edges are deleted first, then reinserted, so
// reprocessing (a re-match after a bad one, say) never accumulates
// duplicate credit edges.
//
// MusicBrainz's own relation data isn't itself free of exact duplicates —
// confirmed live against a real release (The Beatles' "Please Please Me"):
// "producer / George Martin" and "engineer / Norman Smith" each listed
// twice, identical type/artist/attributes, evidently two overlapping
// relationship edits recording the same fact. Deduping here rather than
// trusting the source, since "Produced by George Martin" showing twice in
// the UI is a real defect regardless of which side introduced it.
//
// Issue #321: a person credited before and not now may have left the
// membership bound, so the next start prunes.
export function applyCredits(db: Database, recordingNodeId: number, credits: MbCredit[]): void {
  const before = db
    .prepare("DELETE FROM edges WHERE from_node = ? AND source = 'musicbrainz' RETURNING to_node")
    .all(recordingNodeId) as { to_node: number }[];
  const after = new Set<number>();

  const insertPerformed = db.prepare(
    "INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, 'performed_credit', 'musicbrainz', ?)",
  );
  const insertRole = db.prepare(
    "INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'musicbrainz')",
  );

  const seen = new Set<string>();
  for (const credit of credits) {
    const key = `${credit.type}\0${credit.artistName}\0${credit.attributes.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // The same person-node lookup match/edges.ts uses for local tags, so a
    // producer credited both ways lands on one node, and (issue #273) a
    // credit for someone who is also an artist lands on the artist.
    const creditNodeId = findOrCreatePerson(db, "credit", credit.artistName);
    if (PERFORMED_CREDIT_TYPES.has(credit.type)) {
      insertPerformed.run(recordingNodeId, creditNodeId, credit.attributes[0] ?? credit.type);
      after.add(creditNodeId);
      continue;
    }
    const edgeType = CREDIT_EDGE_TYPE[credit.type];
    if (!edgeType) continue; // an MB relation type this product has no use for yet
    insertRole.run(recordingNodeId, creditNodeId, edgeType);
    after.add(creditNodeId);
  }

  if (before.some(({ to_node }) => !after.has(to_node))) markBoundMayHaveShrunk(db);
}

// M-8: release-level identifiers and facts, written through field_provenance
// on the release node — mirrors worker.ts's recordProvenance for the
// recording mbid, just against whichever field actually has a value rather
// than the hardcoded 'mbid' one. Confidence is fixed at 1: these are facts
// MusicBrainz reports about the release itself, not a fuzzy match outcome.
export function recordReleaseFields(db: Database, releaseNodeId: number, detail: MbReleaseDetail): void {
  const insert = db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, ?, ?, 'musicbrainz', 1)",
  );
  const fields: [string, string | null][] = [
    ["release_mbid", detail.mbid],
    ["release_group_mbid", detail.releaseGroupMbid],
    ["status", detail.status],
    ["country", detail.country],
    ["barcode", detail.barcode],
    ["asin", detail.asin],
    ["disambiguation", detail.disambiguation],
    ["language", detail.language],
    ["script", detail.script],
    ["format", detail.format],
    ["label_name", detail.labelName],
    ["catalog_number", detail.catalogNumber],
    ["first_release_date", detail.firstReleaseDate],
  ];
  for (const [field, value] of fields) {
    if (value == null) continue;
    insert.run(releaseNodeId, field, value);
  }
}

export function recordIsrc(db: Database, recordingNodeId: number, isrc: string | null): void {
  if (!isrc) return;
  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'isrc', ?, 'musicbrainz', 1)",
  ).run(recordingNodeId, isrc);
}
