import type { Database } from "../sqlite.js";
import { artistNameKey } from "./artistLookup.js";
import { mergeNodeInto } from "./people.js";

// Issue #466: artist lookups ignore a leading "The" now (artistLookup.ts),
// but the duplicates the old exact-name lookups made are still there. On
// the reference library, node 802 "The Traveling Wilburys" has the files
// and the place on the map, and node 1007 "Traveling Wilburys", made from
// MusicBrainz's band-membership answer, has the MusicBrainz id and every
// member's edge. This folds each such set into one node, once, at the
// first start after migration 0048 (index.ts), with no step for anyone to
// run. The lookups keep new ones from being made, so it never needs to run
// again.
//
// Artists whose names differ only by case, outer spaces or a leading "The"
// are one artist, unless they have MusicBrainz ids and the ids differ: then
// each id's nodes fold together, and a node with no id goes with the one
// that would survive the whole set.

type ArtistNode = { id: number; title: string };
type Candidate = ArtistNode & { hasFiles: boolean; hasPosition: boolean; fromRecordings: boolean; mbid: string | null };

/** What a fold did. `recomputeAfter` is set when a node it folded away had
 *  tracks of its own: the survivor's counts, its albums and the map's layout
 *  then need a recompute, which index.ts runs once the server listens. */
export type ArtistFold = { merged: number; recomputeAfter: boolean };

// The survivor is the node with files, then the one with a place on the
// map, then the oldest: on the reference library, the tag's "The Traveling
// Wilburys", which keeps its title, favourite, photo and position.
function survivorOf(candidates: Candidate[]): Candidate {
  return [...candidates].sort(
    (a, b) => Number(b.hasFiles) - Number(a.hasFiles) || Number(b.hasPosition) - Number(a.hasPosition) || a.id - b.id,
  )[0]!;
}

// Which node each node in a set of name variants folds into.
function foldsOf(candidates: Candidate[]): [Candidate, Candidate][] {
  const ids = new Set(candidates.flatMap((c) => (c.mbid ? [c.mbid] : [])));
  if (ids.size <= 1) {
    const survivor = survivorOf(candidates);
    return candidates.filter((c) => c !== survivor).map((c) => [c, survivor]);
  }
  const folds: [Candidate, Candidate][] = [];
  const survivors: Candidate[] = [];
  for (const mbid of ids) {
    const same = candidates.filter((c) => c.mbid === mbid);
    const survivor = survivorOf(same);
    survivors.push(survivor);
    for (const c of same) if (c !== survivor) folds.push([c, survivor]);
  }
  const overall = survivorOf(survivors);
  for (const c of candidates) if (c.mbid === null) folds.push([c, overall]);
  return folds;
}

/** Folds every set of artist nodes whose names differ only by case, outer
 *  spaces or a leading "The" into one, with match/people.ts's mergeNodeInto:
 *  the survivor keeps its own edges, favourite, photo and position, and takes
 *  whatever of the others' it doesn't have. Returns what it did. */
export function foldArtistNameVariants(db: Database): ArtistFold {
  const artists = db.prepare("SELECT id, title FROM nodes WHERE type = 'artist' ORDER BY id").all() as ArtistNode[];
  const byKey = new Map<string, ArtistNode[]>();
  for (const artist of artists) {
    const key = artistNameKey(artist.title);
    byKey.set(key, [...(byKey.get(key) ?? []), artist]);
  }
  const sets = [...byKey.values()].filter((set) => set.length > 1);
  if (sets.length === 0) return { merged: 0, recomputeAfter: false };

  const describe = db.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM edges e JOIN files f ON f.recording_node_id = e.from_node
                WHERE e.to_node = ?1 AND e.type IN ('performed_by', 'featured_artist')) AS hasFiles,
       EXISTS (SELECT 1 FROM positions WHERE node_id = ?1) AS hasPosition,
       EXISTS (SELECT 1 FROM edges e JOIN nodes r ON r.id = e.from_node AND r.type = 'recording'
                WHERE e.to_node = ?1) AS fromRecordings,
       (SELECT value FROM field_provenance WHERE node_id = ?1 AND field = 'artist_mbid' ORDER BY id DESC LIMIT 1) AS mbid`,
  );
  let merged = 0;
  let recomputeAfter = false;
  db.transaction(() => {
    for (const set of sets) {
      const candidates = set.map((artist) => {
        const row = describe.get(artist.id) as {
          hasFiles: number;
          hasPosition: number;
          fromRecordings: number;
          mbid: string | null;
        };
        return {
          ...artist,
          hasFiles: row.hasFiles === 1,
          hasPosition: row.hasPosition === 1,
          fromRecordings: row.fromRecordings === 1,
          mbid: row.mbid,
        };
      });
      for (const [from, into] of foldsOf(candidates)) {
        mergeNodeInto(db, from.id, into.id);
        merged += 1;
        if (from.fromRecordings) recomputeAfter = true;
      }
    }
  })();
  return { merged, recomputeAfter };
}

/** index.ts's call, on every start before the server listens. Reads one row
 *  and returns null, unless migration 0048's fold hasn't run on this
 *  database yet. Then it folds and records that it has, in one transaction,
 *  so a fold that fails leaves nothing recorded and the next start tries
 *  again. It logs what it did. */
export function foldArtistNameVariantsIfDue(
  db: Database,
  log: (level: "info" | "error", message: string) => void,
): ArtistFold | null {
  const state = db.prepare("SELECT folded_at FROM artist_name_fold WHERE id = 1").get() as
    | { folded_at: string | null }
    | undefined;
  if (!state || state.folded_at !== null) return null;

  let fold: ArtistFold;
  try {
    fold = db.transaction(() => {
      const result = foldArtistNameVariants(db);
      db.prepare("UPDATE artist_name_fold SET folded_at = datetime('now') WHERE id = 1").run();
      return result;
    })();
  } catch (err) {
    log("error", `artists: couldn't fold artists whose names differ only by "The": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  log(
    "info",
    fold.merged > 0
      ? `artists: folded ${fold.merged} artist node(s) into another whose name differs only by case, spaces or "The"`
      : `artists: no artist names differ only by case, spaces or "The"`,
  );
  return fold;
}
