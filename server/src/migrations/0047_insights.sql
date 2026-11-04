-- #468: Insights. The cards that say how a library connects read who is tied
-- to whom, which comes from joining every credit edge to the performers on
-- the same recording and every album to its label. At 30,000 albums that's
-- over a second of work, so recompute does it (insights/recompute.ts) and
-- keeps the answer here. GET /insights then reads a few thousand rows.
--
-- insight_links: one row per tie between one of your artists and something
-- else, by kind. kind is what the other node is to the artist: 'with' (on a
-- track together), 'producer', 'engineer', 'mixer', 'performer', 'arranger',
-- 'conductor', 'remixer' or 'label'. weight is how many tracks carry the tie
-- (albums, for a label). witness_node_id is one recording that carries it
-- (an album, for a label), so "show on map" can light the tie. Band
-- membership isn't here: member_of edges arrive from enrichment one artist
-- at a time, with no recompute after, so GET /insights reads them live.
--
-- insight_similar_artists: each artist's closest few by the similarity
-- features (insights/similar.ts), with what they have in common. Comparing
-- every pair of artists is the slow part, so it's done here too.
--
-- insight_state: the newest edge id the links were read with. Credits that
-- MusicBrainz adds after it are joined live, so a card doesn't wait for the
-- next scan to see them.
--
-- No foreign keys to nodes, on purpose. The membership prune (enrich/
-- members.ts) treats a row in any table it doesn't know that references a
-- node as user data, and would keep an artist it should prune. Every row
-- here is rebuilt by the next recompute, and every read joins nodes, so a
-- node merged or deleted in between simply drops out of the cards.
CREATE TABLE insight_links (
  artist_node_id INTEGER NOT NULL,
  via_node_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  weight INTEGER NOT NULL,
  witness_node_id INTEGER,
  PRIMARY KEY (artist_node_id, via_node_id, kind)
) WITHOUT ROWID;

CREATE TABLE insight_similar_artists (
  artist_node_id INTEGER NOT NULL,
  other_node_id INTEGER NOT NULL,
  score REAL NOT NULL,
  shared TEXT NOT NULL,
  PRIMARY KEY (artist_node_id, other_node_id)
) WITHOUT ROWID;

CREATE TABLE insight_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  edge_watermark INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
