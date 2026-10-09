import { describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { computeArtistClusters } from "../similarity/features.js";
import {
  computeAlbumRelations,
  computeArtistAffinities,
  computeArtistCollaborations,
  ERA_NEIGHBOURS,
  recomputeCollaborationEdges,
  type AlbumForRelations,
} from "./collaboration.js";

describe("computeArtistCollaborations", () => {
  it("pairs every artist sharing a recording exactly once", () => {
    const performerEdges = [
      { fromNode: 1, toNode: 100 }, // recording 1: artists 100, 200, 300
      { fromNode: 1, toNode: 200 },
      { fromNode: 1, toNode: 300 },
      { fromNode: 2, toNode: 100 }, // recording 2: artists 100, 200 again
      { fromNode: 2, toNode: 200 },
    ];

    const edges = computeArtistCollaborations(performerEdges);
    const pairs = edges.map((e) => `${e.fromNode}-${e.toNode}`).sort();
    expect(pairs).toEqual(["100-200", "100-300", "200-300"]); // 100-200 not duplicated
    expect(edges.every((e) => e.type === "collaborated_with")).toBe(true);
  });

  it("produces nothing for a recording with a single performer", () => {
    expect(computeArtistCollaborations([{ fromNode: 1, toNode: 100 }])).toEqual([]);
  });
});

describe("computeAlbumRelations", () => {
  it("links albums sharing a primary artist via same_artist", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 500 },
      { nodeId: 12, primaryArtistNodeId: 600 },
    ];
    const edges = computeAlbumRelations(albums, new Map());
    expect(edges).toEqual([{ fromNode: 10, toNode: 11, type: "same_artist" }]);
  });

  it("links albums sharing a dominant label via same_label", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: null },
      { nodeId: 11, primaryArtistNodeId: null },
    ];
    const albumLabel = new Map([
      [10, 900],
      [11, 900],
    ]);
    const edges = computeAlbumRelations(albums, albumLabel);
    expect(edges).toEqual([{ fromNode: 10, toNode: 11, type: "same_label" }]);
  });

  it("produces both relations independently when albums share both", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 500 },
    ];
    const albumLabel = new Map([
      [10, 900],
      [11, 900],
    ]);
    const edges = computeAlbumRelations(albums, albumLabel);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.type).sort()).toEqual(["same_artist", "same_label"]);
  });
});

describe("computeArtistAffinities — G-7's wider artist-graph signals", () => {
  it("connects two artists whose albums share a dominant label, even with no shared recording", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 600 },
    ];
    const albumLabel = new Map([
      [10, 900],
      [11, 900],
    ]);
    const edges = computeArtistAffinities(albums, albumLabel, new Map(), [], []);
    expect(edges).toEqual([{ fromNode: 500, toNode: 600, type: "collaborated_with", affinityReason: "same_label" }]);
  });

  it("connects two artists whose albums land in the same era (decade), even on different labels", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 600 },
    ];
    const albumYear = new Map([
      [10, 1962],
      [11, 1968],
    ]);
    const edges = computeArtistAffinities(albums, new Map(), albumYear, [], []);
    expect(edges).toEqual([{ fromNode: 500, toNode: 600, type: "collaborated_with", affinityReason: "same_era" }]);
  });

  it("does not connect artists whose albums land in different decades", () => {
    const albums = [
      { nodeId: 10, primaryArtistNodeId: 500 },
      { nodeId: 11, primaryArtistNodeId: 600 },
    ];
    const albumYear = new Map([
      [10, 1969],
      [11, 1970],
    ]);
    expect(computeArtistAffinities(albums, new Map(), albumYear, [], [])).toEqual([]);
  });

  // Issue #320.
  describe("the era tie, capped", () => {
    // One album each, artist 1000 + i in year 1960 + i % 10.
    function decadeOf(count: number) {
      const albums = Array.from({ length: count }, (_, i) => ({ nodeId: i, primaryArtistNodeId: 1000 + i }));
      const albumYear = new Map(albums.map((a, i) => [a.nodeId, 1960 + (i % 10)]));
      return { albums, albumYear };
    }
    const eraTies = (albums: AlbumForRelations[], albumYear: Map<number, number | null>) =>
      computeArtistAffinities(albums, new Map(), albumYear, [], []).filter((e) => e.affinityReason === "same_era");

    it("ties each artist only to its closest few in the decade by year, on either side", () => {
      const albums = [1965, 1961, 1969, 1963, 1967, 1960].map((_, i) => ({ nodeId: i, primaryArtistNodeId: 100 + i }));
      const albumYear = new Map(albums.map((a, i) => [a.nodeId, [1965, 1961, 1969, 1963, 1967, 1960][i]]));
      // In year order: 105 (1960), 101 (1961), 103 (1963), 100 (1965), 104 (1967), 102 (1969).
      const pairs = eraTies(albums, albumYear).map((e) => `${e.fromNode}-${e.toNode}`);

      expect(ERA_NEIGHBOURS).toBe(3);
      expect(pairs.sort()).toEqual(
        ["101-105", "103-105", "100-105", "101-103", "100-101", "101-104", "100-103", "103-104", "102-103", "100-104", "100-102", "102-104"].sort(),
      );
      // The two years furthest apart aren't tied.
      expect(pairs).not.toContain("102-105");
    });

    it("grows linearly with the number of artists, where every pair grew quadratically", () => {
      for (const count of [100, 1000, 3000]) {
        const { albums, albumYear } = decadeOf(count);
        const ties = eraTies(albums, albumYear);
        expect(ties).toHaveLength(ERA_NEIGHBOURS * count - (ERA_NEIGHBOURS * (ERA_NEIGHBOURS + 1)) / 2);
        const perArtist = new Map<number, number>();
        for (const e of ties) for (const n of [e.fromNode, e.toNode]) perArtist.set(n, (perArtist.get(n) ?? 0) + 1);
        expect(Math.max(...perArtist.values())).toBe(2 * ERA_NEIGHBOURS);
      }
    });

    it("keeps each decade one connected cluster, as every pair did", () => {
      const { albums, albumYear } = decadeOf(500);
      const clusters = computeArtistClusters(eraTies(albums, albumYear));
      expect(clusters.size).toBe(500);
      expect(new Set(clusters.values()).size).toBe(1);
    });

    it("pairs the same artists whatever order the albums come in, in every decade, breaking a tie in year by node id", () => {
      // Artists 1000–1059 with one album each over 1955–1974, three to a
      // year, and a second album for every third of 1000–1057 over
      // 1962–1974, so some sit in two decades and some have two albums in one.
      const albums: AlbumForRelations[] = Array.from({ length: 60 }, (_, i) => ({ nodeId: i, primaryArtistNodeId: 1000 + i }));
      const albumYear = new Map<number, number | null>(albums.map((a, i) => [a.nodeId, 1955 + (i % 20)]));
      for (let j = 0; j < 20; j++) {
        albums.push({ nodeId: 60 + j, primaryArtistNodeId: 1000 + 3 * j });
        albumYear.set(60 + j, 1962 + (j % 13));
      }
      const pairKeys = (list: AlbumForRelations[]) => new Set(eraTies(list, albumYear).map((e) => `${e.fromNode}-${e.toNode}`));
      const inOrder = pairKeys(albums);
      const scrambled = albums.map((album, i) => ({ album, key: (i * 37) % 83 })).sort((a, b) => a.key - b.key);

      expect(pairKeys([...albums].reverse())).toEqual(inOrder);
      expect(pairKeys(scrambled.map(({ album }) => album))).toEqual(inOrder);
      // Each of the three decades has ties: 1000 is only in the 1950s, 1010
      // only in the 1960s and 1016 only in the 1970s.
      for (const artist of ["1000", "1010", "1016"]) {
        expect([...inOrder].some((pair) => pair.split("-").includes(artist))).toBe(true);
      }
      // 1000, 1020 and 1040 share 1955, so in id order 1000's three
      // neighbours after it are 1020, 1040 and 1001 (1956), not 1021.
      expect(inOrder).toContain("1000-1020");
      expect(inOrder).toContain("1000-1040");
      expect(inOrder).toContain("1000-1001");
      expect(inOrder).not.toContain("1000-1021");
    });

    it("places an artist by its earliest album in each decade, and in every decade it has one", () => {
      // Artist 500 has albums in 1969, 1960 and 1972; 601–604 one each in the
      // 1960s, 700 one in the 1970s.
      const albums = [500, 500, 500, 601, 602, 603, 604, 700].map((artist, i) => ({ nodeId: i, primaryArtistNodeId: artist }));
      const albumYear = new Map([1969, 1960, 1972, 1962, 1964, 1966, 1968, 1975].map((year, i) => [i, year]));
      const pairs = eraTies(albums, albumYear).map((e) => `${e.fromNode}-${e.toNode}`);

      // At 1960 it's first, so its neighbours are the three after it, not 604.
      expect(pairs).toContain("500-601");
      expect(pairs).not.toContain("500-604");
      expect(pairs).toContain("500-700");
    });
  });

  it("connects two artists whose recordings share a producer, even on different albums/labels/eras", () => {
    const performerEdges = [
      { fromNode: 1, toNode: 500 }, // recording 1 (artist 500)
      { fromNode: 2, toNode: 600 }, // recording 2 (artist 600)
    ];
    const creditEdges = [
      { recordingNodeId: 1, creditNodeId: 999 },
      { recordingNodeId: 2, creditNodeId: 999 },
    ];
    const edges = computeArtistAffinities([], new Map(), new Map(), performerEdges, creditEdges);
    expect(edges).toEqual([{ fromNode: 500, toNode: 600, type: "collaborated_with", affinityReason: "same_credit" }]);
  });

  it("ignores a credit on a recording with no performer edge to join against", () => {
    const creditEdges = [{ recordingNodeId: 1, creditNodeId: 999 }];
    expect(computeArtistAffinities([], new Map(), new Map(), [], creditEdges)).toEqual([]);
  });

  it("skips albums with no primary artist", () => {
    const albums = [{ nodeId: 10, primaryArtistNodeId: null }];
    const albumLabel = new Map([[10, 900]]);
    expect(computeArtistAffinities(albums, albumLabel, new Map(), [], [])).toEqual([]);
  });
});

describe("recomputeCollaborationEdges", () => {
  function makeNode(db: Database, type: string, title: string): number {
    const row = db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as {
      id: number;
    };
    return row.id;
  }

  it("derives real collaboration/relation edges from real edges and album aggregates", () => {
    const db = openDb(":memory:");

    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const release = makeNode(db, "release", "Split EP");
    const label = makeNode(db, "label", "Some Label");
    const recording = makeNode(db, "recording", "Duet");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      recording,
      release,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      recording,
      label,
    );
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count, total_duration_ms) VALUES (?, ?, 1, 0)",
    ).run(release, artistA);

    recomputeCollaborationEdges(db);

    const collab = db
      .prepare("SELECT from_node, to_node FROM edges WHERE type = 'collaborated_with'")
      .all() as { from_node: number; to_node: number }[];
    expect(collab).toHaveLength(1);
    expect([collab[0].from_node, collab[0].to_node].sort((a, b) => a - b)).toEqual(
      [artistA, artistB].sort((a, b) => a - b),
    );
  });

  it("is idempotent — re-running with no data change doesn't accumulate duplicate edges", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const recording = makeNode(db, "recording", "Duet");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );

    recomputeCollaborationEdges(db);
    recomputeCollaborationEdges(db);

    const count = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'collaborated_with'").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("connects two artists via a shared producer credit end to end, with no shared recording", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const producer = makeNode(db, "credit", "Some Producer");
    const trackA = makeNode(db, "recording", "Track A");
    const trackB = makeNode(db, "recording", "Track B");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      trackA,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      trackB,
      artistB,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'produced_by', 'musicbrainz')").run(
      trackA,
      producer,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'produced_by', 'musicbrainz')").run(
      trackB,
      producer,
    );

    recomputeCollaborationEdges(db);

    const edge = db
      .prepare("SELECT 1 FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistB);
    expect(edge).toBeDefined();
  });

  it("produces exactly one edge for a pair connected by both direct collaboration and a shared label", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const recording = makeNode(db, "recording", "Duet");
    const releaseA = makeNode(db, "release", "Solo Album A");
    const releaseB = makeNode(db, "release", "Solo Album B");
    const label = makeNode(db, "label", "Shared Label");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)",
    ).run(releaseA, artistA);
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)",
    ).run(releaseB, artistB);
    const soloA = makeNode(db, "recording", "Solo A Track");
    const soloB = makeNode(db, "recording", "Solo B Track");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloA,
      releaseA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloB,
      releaseB,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloA,
      label,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloB,
      label,
    );

    recomputeCollaborationEdges(db);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistB) as { n: number };
    expect(count.n).toBe(1);
  });

  it("persists affinityReason as the edge's label column, real ties as null", () => {
    const db = openDb(":memory:");
    const artistA = makeNode(db, "artist", "Artist A");
    const artistB = makeNode(db, "artist", "Artist B");
    const artistC = makeNode(db, "artist", "Artist C");
    const recording = makeNode(db, "recording", "Duet");
    const releaseA = makeNode(db, "release", "Solo Album A");
    const releaseC = makeNode(db, "release", "Solo Album C");
    const label = makeNode(db, "label", "Shared Label");

    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artistA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(
      recording,
      artistB,
    );
    db.prepare("INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)").run(
      releaseA,
      artistA,
    );
    db.prepare("INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, 1)").run(
      releaseC,
      artistC,
    );
    const soloA = makeNode(db, "recording", "Solo A Track");
    const soloC = makeNode(db, "recording", "Solo C Track");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloA,
      releaseA,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(
      soloC,
      releaseC,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloA,
      label,
    );
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'released_on', 'local')").run(
      soloC,
      label,
    );

    recomputeCollaborationEdges(db);

    const real = db
      .prepare("SELECT label FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistB) as { label: string | null };
    expect(real.label).toBeNull();

    const affinityOnly = db
      .prepare("SELECT label FROM edges WHERE type = 'collaborated_with' AND from_node = ? AND to_node = ?")
      .get(artistA, artistC) as { label: string | null };
    expect(affinityOnly.label).toBe("same_label");
  });

  it("never touches deriveLocalEdges's own source='local' rows for recording nodes", () => {
    const db = openDb(":memory:");
    const artist = makeNode(db, "artist", "Artist A");
    const recording = makeNode(db, "recording", "Solo Track");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      recording,
      artist,
    );

    recomputeCollaborationEdges(db);

    const stillThere = db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE from_node = ? AND type = 'performed_by'")
      .get(recording) as { n: number };
    expect(stillThere.n).toBe(1);
  });
});

// Issue #281: written as a diff, so recompute's worker holds the write lock
// only for what changed.
describe("recomputeCollaborationEdges — writing only what changed", () => {
  function makeNode(db: Database, type: string, title: string): number {
    return (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
  }
  const collaborations = (db: Database) =>
    db
      .prepare("SELECT id, from_node AS fromNode, to_node AS toNode, source, label FROM edges WHERE type = 'collaborated_with' ORDER BY id")
      .all();

  it("keeps an unchanged edge's row, and removes one that's no longer true, a duplicate or another source's", () => {
    const db = openDb(":memory:");
    const a = makeNode(db, "artist", "A");
    const b = makeNode(db, "artist", "B");
    const c = makeNode(db, "artist", "C");
    const recording = makeNode(db, "recording", "Duet");
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(recording, a);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'featured_artist', 'local')").run(recording, b);

    recomputeCollaborationEdges(db);
    const first = collaborations(db);
    expect(first).toHaveLength(1);

    const insert = db.prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, 'collaborated_with', ?, NULL)");
    insert.run(a, b, "local"); // a duplicate
    insert.run(a, c, "local"); // no longer true
    insert.run(b, c, "manual"); // what the wholesale delete always removed too
    recomputeCollaborationEdges(db);

    expect(collaborations(db)).toEqual(first);
  });

  // Issue #320: a database from before the cap holds every pair in a decade.
  it("removes the era ties past the cap, and leaves the rows of the ones within it alone", () => {
    const db = openDb(":memory:");
    const artists = Array.from({ length: 8 }, (_, i) => makeNode(db, "artist", `Artist ${i}`));
    artists.forEach((artist, i) => {
      const release = makeNode(db, "release", `Album ${i}`);
      db.prepare("INSERT INTO albums (node_id, primary_artist_node_id, track_count, year_min) VALUES (?, ?, 1, ?)").run(
        release,
        artist,
        1960 + i,
      );
    });
    const insert = db.prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, 'collaborated_with', 'local', 'same_era')");
    for (let i = 0; i < artists.length; i++) for (let j = i + 1; j < artists.length; j++) insert.run(artists[i], artists[j]);
    type Row = { id: number; fromNode: number; toNode: number; source: string; label: string };
    const before = collaborations(db) as Row[];
    expect(before).toHaveLength(28);

    recomputeCollaborationEdges(db);

    const after = collaborations(db) as Row[];
    expect(after).toHaveLength(ERA_NEIGHBOURS * 8 - (ERA_NEIGHBOURS * (ERA_NEIGHBOURS + 1)) / 2);
    // Every tie within the cap was already there, so each is its old row,
    // id and all: nothing was deleted and written again.
    const beforeByPair = new Map(before.map((e) => [`${e.fromNode}-${e.toNode}`, e]));
    for (const e of after) expect(e).toEqual(beforeByPair.get(`${e.fromNode}-${e.toNode}`)!);
  });
});
