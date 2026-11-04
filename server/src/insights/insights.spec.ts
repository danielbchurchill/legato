import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { libraryChanged } from "../libraryRevision.js";
import {
  bandFamilies,
  bridges,
  connect,
  findArtists,
  islands,
  mostConnected,
  pathSuggestion,
  recordedTogether,
  sharedLabels,
  sharedPeople,
  soundsAlike,
  topLabels,
  web,
} from "./cards.js";
import { computeLinks } from "./links.js";
import { careers, decades, listening } from "./listening.js";
import { loadModel } from "./model.js";
import { insightsComputed, recomputeInsights } from "./recompute.js";
import { computeSimilarArtists, MIN_SCORE, NEIGHBOURS, type TrackFeatures } from "./similar.js";
import { TestLibrary, wilburysLibrary } from "./testLibrary.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  // Each spec's model is its own: the cache is keyed by the library's
  // revision, which a recompute bumps.
  libraryChanged();
});

const titles = (refs: { title: string }[]) => refs.map((r) => r.title);

function ready(): ReturnType<typeof wilburysLibrary> {
  const library = wilburysLibrary(db);
  recomputeInsights(db);
  libraryChanged();
  return library;
}

describe("computeLinks", () => {
  it("ties a credited person to the artist of each track they're on", () => {
    const { id } = wilburysLibrary(db);
    const links = computeLinks(db);
    const lynne = links.filter((l) => l.via === id("Jeff Lynne") && l.kind === "producer");
    expect(lynne.map((l) => l.artist).sort((a, b) => a - b)).toEqual(
      [id("George Harrison"), id("Traveling Wilburys"), id("Tom Petty")].sort((a, b) => a - b),
    );
    // Two tracks on Full Moon Fever, so two tracks carry the tie.
    expect(lynne.find((l) => l.artist === id("Tom Petty"))?.weight).toBe(2);
  });

  it("ties two artists on one track to each other, and a featured guest to the artist, but not a credit to the guest", () => {
    const lib = new TestLibrary(db);
    lib.album("Artist", "Record", {
      tracks: 1,
      with: ["Partner"],
      featuring: ["Guest"],
      credits: { produced_by: ["Producer"] },
    });
    lib.album("Partner", "Their Own", { tracks: 1 });
    lib.aggregate();
    const links = computeLinks(db);
    const has = (artist: string, via: string, kind: string) =>
      links.some((l) => l.artist === lib.artist(artist) && l.via === lib.person(via) && l.kind === kind);
    expect(has("Artist", "Partner", "with")).toBe(true);
    expect(has("Partner", "Artist", "with")).toBe(true);
    expect(has("Artist", "Guest", "with")).toBe(true);
    expect(has("Artist", "Producer", "producer")).toBe(true);
    // Guest has no album of its own, so isn't one of your artists.
    expect(links.some((l) => l.artist === lib.artist("Guest"))).toBe(false);
  });

  it("ties an artist to the label most of an album's tracks name", () => {
    const lib = new TestLibrary(db);
    const album = lib.album("Artist", "Record", { tracks: 3, label: "Main" });
    lib.edge(album.tracks[0]!, lib.node("label", "Other"), "released_on");
    lib.aggregate();
    const labels = computeLinks(db).filter((l) => l.kind === "label");
    expect(labels).toEqual([
      { artist: lib.artist("Artist"), via: lib.node("label", "Main"), kind: "label", weight: 1, witness: album.id },
    ]);
  });

  it("leaves out mastering, which would link a whole label to itself", () => {
    const lib = new TestLibrary(db);
    lib.album("One", "A", { credits: { mastered_by: ["Mastering House"] } });
    lib.album("Two", "B", { credits: { mastered_by: ["Mastering House"] } });
    lib.aggregate();
    expect(computeLinks(db).filter((l) => l.via === lib.person("Mastering House"))).toEqual([]);
  });
});

describe("recomputeInsights", () => {
  it("fills the tables and marks them computed", () => {
    wilburysLibrary(db);
    expect(insightsComputed(db)).toBe(false);
    recomputeInsights(db);
    expect(insightsComputed(db)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM insight_links").get() as { n: number }).n).toBeGreaterThan(0);
  });

  it("writes nothing but its watermark when nothing changed", () => {
    wilburysLibrary(db);
    recomputeInsights(db);
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    recomputeInsights(db);
    const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after - before).toBe(1);
  });

  it("drops a tie whose edge has gone, and only that", () => {
    const { lib, id } = wilburysLibrary(db);
    recomputeInsights(db);
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM insight_links").get() as { n: number }).n;
    const had = count();
    db.prepare("DELETE FROM edges WHERE to_node = ? AND type = 'produced_by'").run(lib.person("Phil Spector"));
    recomputeInsights(db);
    expect(count()).toBe(had - 1);
    expect(
      db
        .prepare("SELECT 1 FROM insight_links WHERE artist_node_id = ? AND via_node_id = ?")
        .get(id("George Harrison"), lib.person("Phil Spector")),
    ).toBeUndefined();
  });
});

describe("the model", () => {
  it("reads band membership live, so a member lookup shows without a recompute", () => {
    const { lib, id } = ready();
    expect(bridges(loadModel(db)).some((b) => b.person.title === "Ringo Starr")).toBe(false);
    lib.member("Ringo Starr", "The Beatles");
    lib.member("Ringo Starr", "Traveling Wilburys");
    const ringo = bridges(loadModel(db)).find((b) => b.person.title === "Ringo Starr");
    expect(ringo?.artists.map((a) => a.id).sort((a, b) => a - b)).toEqual(
      [id("The Beatles"), id("Traveling Wilburys")].sort((a, b) => a - b),
    );
  });

  it("joins credits enrichment added after the recompute", () => {
    const { lib, albums, id } = ready();
    // MusicBrainz names an engineer on Pink Moon and Diamond Day.
    lib.edge(albums.pinkMoon.tracks[0]!, lib.person("John Wood"), "engineered_by", "musicbrainz");
    lib.edge(albums.diamondDay.tracks[0]!, lib.person("John Wood"), "engineered_by", "musicbrainz");
    const wood = bridges(loadModel(db)).find((b) => b.person.title === "John Wood");
    expect(wood?.roles).toEqual(["producer", "engineer"]);
    expect(titles(wood!.artists).sort()).toEqual(["Nick Drake", "Vashti Bunyan"]);
    expect(islands(loadModel(db))).toBeNull();
    void id;
  });

  it("leaves out a tie to an artist that is no longer yours", () => {
    const { id } = ready();
    db.prepare("DELETE FROM albums WHERE primary_artist_node_id = ?").run(id("Tom Petty"));
    libraryChanged();
    const model = loadModel(db);
    expect(model.artists.has(id("Tom Petty"))).toBe(false);
    expect(model.links.some((l) => l.artist === id("Tom Petty"))).toBe(false);
  });
});

describe("Bridges", () => {
  it("names the people who link the most of your artists, most first", () => {
    ready();
    const rows = bridges(loadModel(db));
    expect(rows[0]).toMatchObject({
      person: { title: "Jeff Lynne" },
      roles: ["member", "producer"],
      total: 3,
      ownRecords: false,
    });
    expect(titles(rows[0]!.artists).sort()).toEqual(["George Harrison", "Tom Petty", "Traveling Wilburys"]);
  });

  it("says George Harrison links The Beatles and the Traveling Wilburys, and has records of his own", () => {
    ready();
    const harrison = bridges(loadModel(db)).find((b) => b.person.title === "George Harrison");
    expect(titles(harrison!.artists).sort()).toEqual(["The Beatles", "Traveling Wilburys"]);
    expect(harrison!.ownRecords).toBe(true);
  });

  it("leaves out someone tied to one artist, and focuses the map on the person and who they link", () => {
    const { id } = ready();
    const rows = bridges(loadModel(db));
    expect(rows.some((b) => b.person.title === "George Martin")).toBe(false);
    const lynne = rows[0]!;
    expect(lynne.focus.slice(0, 1)).toEqual([id("Jeff Lynne")]);
    expect(lynne.focus).toEqual(
      expect.arrayContaining([id("George Harrison"), id("Tom Petty"), id("Traveling Wilburys")]),
    );
  });
});

describe("Shared producers", () => {
  it("pairs artists who share a producer or engineer, and says who", () => {
    ready();
    const rows = sharedPeople(loadModel(db));
    expect(rows.length).toBe(3);
    for (const row of rows)
      expect(row.people).toEqual([{ person: expect.objectContaining({ title: "Jeff Lynne" }), roles: ["producer"] }]);
    expect(rows.map((r) => titles(r.artists).sort().join(" & ")).sort()).toEqual([
      "George Harrison & Tom Petty",
      "George Harrison & Traveling Wilburys",
      "Tom Petty & Traveling Wilburys",
    ]);
  });

  it("ranks a pair sharing two people over a pair sharing one", () => {
    const lib = new TestLibrary(db);
    lib.album("A", "A1", { credits: { produced_by: ["P"], engineered_by: ["E"] } });
    lib.album("B", "B1", { credits: { produced_by: ["P"], engineered_by: ["E"] } });
    lib.album("C", "C1", { credits: { produced_by: ["P"] } });
    lib.aggregate();
    recomputeInsights(db);
    libraryChanged();
    const [top] = sharedPeople(loadModel(db));
    expect(titles(top!.artists)).toEqual(["A", "B"]);
    expect(top!.people.map((p) => p.person.title)).toEqual(["E", "P"]);
  });
});

describe("Shared labels", () => {
  it("lists labels with two or more of your artists, the biggest first", () => {
    ready();
    const rows = sharedLabels(loadModel(db));
    expect(rows.map((r) => [r.label.title, titles(r.artists), r.albums])).toEqual([
      ["Columbia", ["Bob Dylan", "Johnny Cash"], 4],
      ["Apple", ["George Harrison", "The Beatles"], 2],
    ]);
  });

  it("counts each label's albums for Library shape", () => {
    ready();
    expect(topLabels(loadModel(db), 2).map((l) => [l.label.title, l.albums])).toEqual([
      ["Columbia", 4],
      ["Apple", 2],
    ]);
  });
});

describe("Band families", () => {
  it("joins groups and solo artists through membership", () => {
    ready();
    const [family] = bandFamilies(loadModel(db));
    expect(titles(family!.artists).sort()).toEqual([
      "Bob Dylan",
      "George Harrison",
      "The Beatles",
      "Tom Petty",
      "Traveling Wilburys",
    ]);
    expect(family!.total).toBe(5);
  });

  it("names the band that joins them when the band itself isn't yours", () => {
    const lib = new TestLibrary(db);
    lib.album("Bob Dylan", "Blonde on Blonde");
    lib.album("Tom Petty", "Full Moon Fever");
    lib.member("Bob Dylan", "Traveling Wilburys");
    lib.member("Tom Petty", "Traveling Wilburys");
    lib.aggregate();
    recomputeInsights(db);
    libraryChanged();
    const [family] = bandFamilies(loadModel(db));
    expect(titles(family!.artists).sort()).toEqual(["Bob Dylan", "Tom Petty"]);
    expect(titles(family!.through)).toEqual(["Traveling Wilburys"]);
  });
});

describe("Most connected, islands and the web", () => {
  it("ranks artists by how many others they share someone with", () => {
    ready();
    const [top] = mostConnected(loadModel(db));
    expect(top).toMatchObject({ artist: { title: "Traveling Wilburys" }, artists: 5 });
  });

  it("lists the artists nothing ties to anyone else; a shared label doesn't count", () => {
    ready();
    expect(islands(loadModel(db))).toEqual({
      artists: [expect.objectContaining({ title: "Nick Drake" }), expect.objectContaining({ title: "Vashti Bunyan" })],
      total: 2,
    });
  });

  it("says how much of the library is one web", () => {
    ready();
    expect(web(loadModel(db))).toEqual({ artists: 8, connected: 6, largest: 6, groups: 1 });
  });

  it("says nothing about connections when nothing is connected", () => {
    const lib = new TestLibrary(db);
    lib.album("A", "A1");
    lib.album("B", "B1");
    lib.aggregate();
    recomputeInsights(db);
    libraryChanged();
    const model = loadModel(db);
    expect(mostConnected(model)).toEqual([]);
    expect(islands(model)).toBeNull();
    expect(web(model).connected).toBe(0);
  });
});

describe("Recorded together", () => {
  it("pairs your artists on the same tracks, with how many", () => {
    ready();
    expect(recordedTogether(loadModel(db)).map((r) => [titles(r.artists).sort(), r.tracks])).toEqual([
      [["Bob Dylan", "Johnny Cash"], 1],
    ]);
  });
});

describe("Sounds alike", () => {
  it("pairs artists the similarity features put close, with nothing between them, and says what they share", () => {
    ready();
    const rows = soundsAlike(db, loadModel(db));
    expect(rows[0]).toMatchObject({ shared: ["folk", "1970s"] });
    expect(titles(rows[0]!.artists).sort()).toEqual(["Nick Drake", "Vashti Bunyan"]);
  });

  it("never pairs artists who are already connected", () => {
    const { id } = ready();
    const model = loadModel(db);
    const connected = new Set([`${id("George Harrison")}`, `${id("The Beatles")}`]);
    for (const row of soundsAlike(db, model)) expect(row.artists.every((a) => connected.has(`${a.id}`))).toBe(false);
  });

  it("needs a shared genre", () => {
    const tracks: TrackFeatures[] = [
      { artist: 1, genres: [], label: null, releaseType: null, year: 1970, durationMs: 200_000, bpm: null },
      { artist: 2, genres: [], label: null, releaseType: null, year: 1970, durationMs: 200_000, bpm: null },
    ];
    expect(computeSimilarArtists(tracks)).toEqual([]);
  });

  it("keeps each artist's closest few, at the threshold or above", () => {
    const tracks: TrackFeatures[] = Array.from({ length: 10 }, (_, i) => ({
      artist: i + 1,
      genres: ["folk"],
      label: null,
      releaseType: null,
      year: 1970,
      durationMs: null,
      bpm: null,
    }));
    const pairs = computeSimilarArtists(tracks);
    for (let artist = 1; artist <= 10; artist++)
      expect(pairs.filter((p) => p.artist === artist).length).toBe(NEIGHBOURS);
    expect(pairs.every((p) => p.score >= MIN_SCORE)).toBe(true);
  });
});

describe("How are these connected?", () => {
  it("finds the shortest way from one artist to another, each step named", () => {
    const { id } = ready();
    const path = connect(loadModel(db), id("The Beatles"), id("Johnny Cash"));
    expect(titles(path!.nodes)).toEqual([
      "The Beatles",
      "George Harrison",
      "Traveling Wilburys",
      "Bob Dylan",
      "Johnny Cash",
    ]);
    expect(path!.links.map((l) => l.kind)).toEqual(["member", "member", "member", "with"]);
    // The Beatles have George Harrison as a member; he's a member of the
    // Wilburys, not the other way round.
    expect(path!.links.map((l) => l.artistFirst)).toEqual([true, false, true, true]);
  });

  it("goes through people before a label", () => {
    const lib = new TestLibrary(db);
    lib.album("A", "A1", { label: "Same", credits: { produced_by: ["P"] } });
    lib.album("B", "B1", { label: "Same", credits: { produced_by: ["P"] } });
    lib.album("C", "C1", { label: "Same" });
    lib.aggregate();
    recomputeInsights(db);
    libraryChanged();
    const model = loadModel(db);
    expect(titles(connect(model, lib.artist("A"), lib.artist("B"))!.nodes)).toEqual(["A", "P", "B"]);
    expect(titles(connect(model, lib.artist("A"), lib.artist("C"))!.nodes)).toEqual(["A", "Same", "C"]);
  });

  it("is null when nothing joins them", () => {
    const { id } = ready();
    expect(connect(loadModel(db), id("Nick Drake"), id("Bob Dylan"))).toBeNull();
  });

  it("suggests two artists far apart to start with", () => {
    ready();
    const suggestion = pathSuggestion(loadModel(db));
    expect([suggestion!.from.title, suggestion!.to.title].sort()).toEqual(["Johnny Cash", "The Beatles"]);
  });

  it("finds your artists by name, ignoring case and accents", () => {
    const lib = new TestLibrary(db);
    lib.album("Ólafur Arnalds", "Re:member");
    lib.album("Olivia Rodrigo", "Sour");
    lib.aggregate();
    libraryChanged();
    expect(titles(findArtists(loadModel(db), "olaf", 10))).toEqual(["Ólafur Arnalds"]);
    expect(titles(findArtists(loadModel(db), "", 10))).toEqual(["Ólafur Arnalds", "Olivia Rodrigo"]);
  });
});

describe("listening", () => {
  it("counts the most played artists, albums and tracks", () => {
    const { lib, albums } = ready();
    lib.play(albums.pinkMoon.tracks[0]!, 4);
    lib.play(albums.pinkMoon.tracks[1]!, 2);
    lib.play(albums.abbeyRoad.tracks[0]!, 3);
    const { mostPlayed } = listening(db);
    expect(mostPlayed.artists.map((r) => [r.node.title, r.plays])).toEqual([
      ["Nick Drake", 6],
      ["The Beatles", 3],
    ]);
    expect(mostPlayed.albums.map((r) => [r.node.title, r.plays, r.by?.title])).toEqual([
      ["Pink Moon", 6, "Nick Drake"],
      ["Abbey Road", 3, "The Beatles"],
    ]);
    expect(mostPlayed.tracks.map((r) => [r.node.title, r.plays, r.by?.title])).toEqual([
      ["Pink Moon 1", 4, "Nick Drake"],
      ["Abbey Road 1", 3, "The Beatles"],
      ["Pink Moon 2", 2, "Nick Drake"],
    ]);
  });

  it("is empty with nothing played", () => {
    ready();
    const { mostPlayed, onRepeat, rediscover } = listening(db);
    expect([mostPlayed.artists, mostPlayed.albums, mostPlayed.tracks, onRepeat, rediscover]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it("finds artists played a lot and not for months", () => {
    const { lib, albums } = ready();
    lib.play(albums.blonde.tracks[0]!, 6, 200);
    lib.play(albums.folsom.tracks[0]!, 6, 10);
    lib.play(albums.abbeyRoad.tracks[0]!, 2, 300);
    const rows = listening(db).rediscover;
    expect(rows.map((r) => [r.artist.title, r.plays])).toEqual([["Bob Dylan", 6]]);
    expect(Date.now() - Date.parse(rows[0]!.lastPlayed)).toBeGreaterThan(199 * 86_400_000);
  });

  it("finds tracks on repeat in the last month", () => {
    const { lib, albums } = ready();
    lib.play(albums.folsom.tracks[0]!, 3, 5);
    lib.play(albums.folsom.tracks[1]!, 2, 5);
    lib.play(albums.abbeyRoad.tracks[0]!, 5, 60);
    expect(listening(db).onRepeat.map((r) => [r.node.title, r.plays])).toEqual([["At Folsom Prison 1", 3]]);
  });

  it("lists albums never played, newest added first", () => {
    const lib = new TestLibrary(db);
    const old = lib.album("A", "Old", { addedAt: "2024-01-01 00:00:00" });
    lib.album("B", "Middle", { addedAt: "2025-01-01 00:00:00" });
    const recent = lib.album("C", "Newest", { addedAt: "2026-01-01 00:00:00" });
    lib.aggregate();
    lib.play(recent.tracks[1]!);
    const { waiting } = listening(db);
    expect(waiting.albums.map((r) => r.album.title)).toEqual(["Middle", "Old"]);
    expect(waiting.total).toBe(2);
    void old;
  });

  it("reads plays again once one lands", () => {
    const { lib, albums } = ready();
    expect(listening(db).mostPlayed.tracks).toEqual([]);
    lib.play(albums.folsom.tracks[0]!);
    expect(listening(db).mostPlayed.tracks.map((r) => r.node.title)).toEqual(["At Folsom Prison 1"]);
  });
});

describe("Library shape and careers", () => {
  it("counts albums by decade, and the undated apart", () => {
    const lib = new TestLibrary(db);
    lib.album("A", "Sixties", { year: 1966 });
    lib.album("A", "Also Sixties", { year: 1969 });
    lib.album("B", "Nineties", { year: 1997 });
    lib.album("B", "Undated");
    lib.aggregate();
    expect(decades(db)).toEqual({
      decades: [
        { decade: 1960, albums: 2 },
        { decade: 1990, albums: 1 },
      ],
      undated: 1,
    });
  });

  it("finds the artists whose albums span ten years or more, longest first", () => {
    ready();
    expect(careers(db).map((c) => [c.artist.title, c.first, c.last])).toEqual([
      ["Bob Dylan", 1966, 1997],
      ["George Harrison", 1970, 1987],
    ]);
  });
});
