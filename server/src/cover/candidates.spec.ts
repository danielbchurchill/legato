import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mocked } from "../testing.js";
import * as mbClient from "../enrich/mbClient.js";
import type { MbGroupRelease } from "../enrich/mbClient.js";

// MusicBrainz is stubbed at the client, whose parsing mbClient.spec.ts covers
// against captured answers, so these don't wait out its one-a-second limit.
// The Cover Art Archive and Deezer are stubbed at fetch.
mock.module("../enrich/mbClient.js", () => ({
  USER_AGENT: "Legato/test",
  searchReleaseGroup: mock(),
  browseReleaseGroupReleases: mock(),
}));

const {
  candidateImageUrls,
  clearCandidateCaches,
  coverSubject,
  editionlessTitle,
  fetchCandidateImage,
  fetchCandidateThumb,
  frontsAndBacks,
  isSameAlbumTitle,
  listCandidates,
  pickDeezerAlbums,
  pickReleaseGroup,
} = await import("./candidates.js");

const GROUP = "416bb5e5-c7d1-3977-8fd7-7c9daf6c2be6";
const CD = "02ac7ce7-4f21-4010-8210-e682085c58ab";
const REMASTER = "02face5e-6a23-4402-b4d7-fa752d031a35";
const LP = "148e0546-7ce0-40b5-a3c9-365824ca3ea7";
const BARE = "0474591d-c366-44ee-b0e1-bc5ecd53e4d6";

function release(mbid: string, fields: Omit<Partial<MbGroupRelease>, "art"> & { art?: Partial<MbGroupRelease["art"]> }): MbGroupRelease {
  return {
    mbid,
    title: "Rumours",
    date: null,
    country: null,
    status: "Official",
    disambiguation: null,
    ...fields,
    art: { artwork: true, front: true, back: false, count: 1, darkened: false, ...fields.art },
  };
}

const RELEASES: MbGroupRelease[] = [
  release(CD, { date: "1990-10-25", country: "CA", art: { back: true, count: 4 } }),
  release(REMASTER, { date: "2011", country: "XW", disambiguation: "2001 remaster" }),
  release(LP, { date: "1977-02-04", country: "US", art: { back: true, count: 2 } }),
  release(BARE, { art: { artwork: false, front: false, count: 0 } }),
];

let db: Database;

function album(title: string, artist: string | null): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('release', ?) RETURNING id").get(title) as { id: number };
  let artistId: number | null = null;
  if (artist) {
    artistId = (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(artist) as { id: number }).id;
  }
  db.prepare("INSERT INTO albums (node_id, primary_artist_node_id) VALUES (?, ?)").run(node.id, artistId);
  return node.id;
}

function provenance(nodeId: number, field: string, value: string): void {
  db.prepare("INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, ?, ?, 'musicbrainz', 1)").run(
    nodeId,
    field,
    value,
  );
}

// fetch, answered by URL. Anything not listed is a 404.
type Answer = { status?: number; json?: unknown; body?: string; type?: string };
let answers: Map<string, Answer>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  db = openDb(":memory:");
  clearCandidateCaches();
  mocked(mbClient.searchReleaseGroup).mockReset();
  mocked(mbClient.browseReleaseGroupReleases).mockReset();
  mocked(mbClient.browseReleaseGroupReleases).mockResolvedValue(RELEASES);
  answers = new Map();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const answer = answers.get(url);
    if (!answer) return new Response("not found", { status: 404 });
    if (answer.json !== undefined) return Response.json(answer.json, { status: answer.status ?? 200 });
    return new Response(answer.body ?? "", { status: answer.status ?? 200, headers: { "Content-Type": answer.type ?? "image/jpeg" } });
  }) as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function fetchedUrls(): string[] {
  return fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
}

describe("editionlessTitle", () => {
  it("drops what an edition adds after the album's own title", () => {
    expect(editionlessTitle("Abbey Road (Remastered 2009)")).toBe("Abbey Road");
    expect(editionlessTitle("Rumours [2004 Deluxe Edition] (Disc 1)")).toBe("Rumours");
    expect(editionlessTitle("Fear of Music - 2021 Remaster")).toBe("Fear of Music");
  });

  it("keeps a title's own brackets, and a title that's only brackets", () => {
    expect(editionlessTitle("(What's the Story) Morning Glory?")).toBe("(What's the Story) Morning Glory?");
    expect(editionlessTitle("(Untitled)")).toBe("(Untitled)");
  });
});

describe("isSameAlbumTitle", () => {
  it("matches across editions, case and punctuation, and not a different record", () => {
    expect(isSameAlbumTitle("Rumours", "Rumours (Super Deluxe)")).toBe(true);
    expect(isSameAlbumTitle("rumours", "RUMOURS!")).toBe(true);
    expect(isSameAlbumTitle("Rumours", "Rumours Live")).toBe(false);
  });
});

describe("pickReleaseGroup", () => {
  it("takes the best scored group with the album's title and artist", () => {
    const match = pickReleaseGroup({ title: "Rumours (Remastered)", artist: "Fleetwood Mac" }, [
      { mbid: "outtakes", score: 100, title: "Rumours Outtakes", artist: "Fleetwood Mac" },
      { mbid: "cover-version", score: 100, title: "Rumours", artist: "Vitamin String Quartet" },
      { mbid: GROUP, score: 98, title: "Rumours", artist: "Fleetwood Mac" },
    ]);
    expect(match).toEqual({ mbid: GROUP, title: "Rumours", artist: "Fleetwood Mac" });
  });

  it("finds nothing rather than a near miss", () => {
    expect(pickReleaseGroup({ title: "Rumours", artist: "Fleetwood Mac" }, [{ mbid: "x", score: 100, title: "Tusk", artist: "Fleetwood Mac" }])).toBe(
      null,
    );
  });

  it("looks a compilation with no artist up as Various Artists", () => {
    const match = pickReleaseGroup({ title: "Pulp Fiction", artist: null }, [{ mbid: "ost", score: 100, title: "Pulp Fiction", artist: "Various Artists" }]);
    expect(match?.mbid).toBe("ost");
  });
});

describe("frontsAndBacks", () => {
  it("lists every edition's front, then every back, own edition first and then oldest first", () => {
    const subject = { nodeId: 1, title: "Rumours", artist: "Fleetwood Mac", releaseGroupMbid: GROUP, releaseMbid: REMASTER };
    const { candidates, more } = frontsAndBacks(subject, RELEASES);
    expect(candidates.map((c) => [c.id, c.kind, c.edition])).toEqual([
      [`caa:${REMASTER}:front`, "front", "2011 · XW · 2001 remaster"],
      [`caa:${LP}:front`, "front", "1977 · US"],
      [`caa:${CD}:front`, "front", "1990 · CA"],
      [`caa:${LP}:back`, "back", "1977 · US"],
      [`caa:${CD}:back`, "back", "1990 · CA"],
    ]);
    // The CD's 4 images less its front and back, none on the others.
    expect(more).toBe(2);
  });

  it("leaves out an edition whose art is hidden for copyright", () => {
    const subject = { nodeId: 1, title: "Rumours", artist: null, releaseGroupMbid: GROUP, releaseMbid: null };
    const { candidates } = frontsAndBacks(subject, [release(CD, { art: { darkened: true } })]);
    expect(candidates).toEqual([]);
  });
});

describe("pickDeezerAlbums", () => {
  it("keeps one candidate per edition of this album by this artist", () => {
    const albums = [
      { id: 1, title: "Rumours", artist: "Fleetwood Mac", md5: "a".repeat(32), recordType: "album", tracks: 11 },
      { id: 2, title: "Rumours (Super Deluxe)", artist: "Fleetwood Mac", md5: "b".repeat(32), recordType: "album", tracks: 58 },
      { id: 3, title: "Rumours", artist: "Grey Orton", md5: "c".repeat(32), recordType: "single", tracks: 2 },
      { id: 4, title: "Rumours Live", artist: "Fleetwood Mac", md5: "d".repeat(32), recordType: "album", tracks: 18 },
      // The same image under another edition is the same candidate.
      { id: 5, title: "Rumours (Remastered)", artist: "Fleetwood Mac", md5: "a".repeat(32), recordType: "album", tracks: 11 },
    ];
    expect(pickDeezerAlbums({ title: "Rumours", artist: "Fleetwood Mac" }, albums).map((a) => a.id)).toEqual([1, 2]);
  });
});

describe("coverSubject", () => {
  it("is an album's title, primary artist and stored MusicBrainz ids", () => {
    const id = album("Rumours", "Fleetwood Mac");
    provenance(id, "release_group_mbid", GROUP);
    provenance(id, "release_mbid", CD);
    expect(coverSubject(db, id)).toEqual({ nodeId: id, title: "Rumours", artist: "Fleetwood Mac", releaseGroupMbid: GROUP, releaseMbid: CD });
  });

  it("is nothing for a track or an artist", () => {
    const track = (db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'Dreams') RETURNING id").get() as { id: number }).id;
    expect(coverSubject(db, track)).toBeNull();
  });
});

describe("listCandidates from the Cover Art Archive", () => {
  it("browses the stored release group's editions without searching", async () => {
    const id = album("Rumours", "Fleetwood Mac");
    provenance(id, "release_group_mbid", GROUP);
    const list = await listCandidates(coverSubject(db, id)!, "caa");
    expect(mbClient.searchReleaseGroup).not.toHaveBeenCalled();
    expect(mbClient.browseReleaseGroupReleases).toHaveBeenCalledWith(GROUP);
    expect(list.match).toEqual({ title: "Rumours", artist: "Fleetwood Mac" });
    expect(list.candidates.map((c) => c.id)).toEqual([
      `caa:${LP}:front`,
      `caa:${CD}:front`,
      `caa:${REMASTER}:front`,
      `caa:${LP}:back`,
      `caa:${CD}:back`,
    ]);
    expect(list.more).toBe(2);
    // Fronts and backs come from MusicBrainz's browse: nothing asked of CAA.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("searches MusicBrainz by artist and title for an album with no release group", async () => {
    const id = album("Rumours (Remastered)", "Fleetwood Mac");
    mocked(mbClient.searchReleaseGroup).mockResolvedValue([
      { mbid: GROUP, score: 100, title: "Rumours", artist: "Fleetwood Mac", primaryType: "Album", firstReleaseDate: "1977-02-04" },
    ]);
    const list = await listCandidates(coverSubject(db, id)!, "caa");
    expect(mbClient.searchReleaseGroup).toHaveBeenCalledWith("Rumours", "Fleetwood Mac");
    expect(list.match?.title).toBe("Rumours");
    expect(list.candidates.length).toBe(5);
  });

  it("says nothing matched when the search finds no such record", async () => {
    const id = album("Home Tapes", "Nobody Famous");
    mocked(mbClient.searchReleaseGroup).mockResolvedValue([]);
    const list = await listCandidates(coverSubject(db, id)!, "caa");
    expect(list).toEqual({ source: "caa", match: null, candidates: [], more: 0 });
    expect(mbClient.browseReleaseGroupReleases).not.toHaveBeenCalled();
  });

  it("lists every image of every edition when asked, fronts first", async () => {
    const id = album("Rumours", "Fleetwood Mac");
    provenance(id, "release_group_mbid", GROUP);
    answers.set(`https://coverartarchive.org/release/${CD}`, {
      json: {
        images: [
          { id: "1", types: ["Front"], front: true, back: false },
          { id: "2", types: ["Back"], front: false, back: true },
          { id: "3", types: ["Medium"], front: false, back: false },
          { id: "4", types: ["Booklet"], front: false, back: false },
        ],
      },
    });
    const list = await listCandidates(coverSubject(db, id)!, "caa", { everything: true });
    expect(list.candidates.slice(5).map((c) => [c.id, c.kind])).toEqual([
      [`caa:${CD}:4`, "booklet"],
      [`caa:${CD}:3`, "medium"],
    ]);
    expect(list.more).toBe(0);
    // Only the edition with more than a front and a back was listed.
    expect(fetchedUrls()).toEqual([`https://coverartarchive.org/release/${CD}`]);
  });

  it("asks nobody twice for the same album", async () => {
    const id = album("Rumours", "Fleetwood Mac");
    mocked(mbClient.searchReleaseGroup).mockResolvedValue([
      { mbid: GROUP, score: 100, title: "Rumours", artist: "Fleetwood Mac", primaryType: "Album", firstReleaseDate: null },
    ]);
    await listCandidates(coverSubject(db, id)!, "caa");
    await listCandidates(coverSubject(db, id)!, "caa");
    expect(mbClient.searchReleaseGroup).toHaveBeenCalledTimes(1);
    expect(mbClient.browseReleaseGroupReleases).toHaveBeenCalledTimes(1);
  });
});

describe("listCandidates from Deezer", () => {
  const search = (q: string) => `https://api.deezer.com/search/album?${new URLSearchParams({ q, limit: "25" })}`;

  it("searches by artist and album and lists each matching edition at its largest", async () => {
    const id = album("Rumours", "Fleetwood Mac");
    answers.set(search('artist:"Fleetwood Mac" album:"Rumours"'), {
      json: {
        data: [
          { id: 219408102, title: "Rumours", md5_image: "4c9e7ad02a8e74dfb10984fe6034701a", artist: { name: "Grey Orton" }, nb_tracks: 2 },
          { id: 6237061, title: "Rumours", md5_image: "9732751ce91d786dcf30069853697078", artist: { name: "Fleetwood Mac" }, nb_tracks: 11 },
          { id: 6612817, title: "Rumours (Super Deluxe)", md5_image: "0199f3f00d23ed0916cf748d9b5d5030", artist: { name: "Fleetwood Mac" }, nb_tracks: 58 },
        ],
      },
    });
    const list = await listCandidates(coverSubject(db, id)!, "deezer");
    expect(list.match).toEqual({ title: "Rumours", artist: "Fleetwood Mac" });
    expect(list.candidates).toEqual([
      { id: "deezer:9732751ce91d786dcf30069853697078", source: "deezer", kind: "front", edition: "Rumours · 11 tracks" },
      { id: "deezer:0199f3f00d23ed0916cf748d9b5d5030", source: "deezer", kind: "front", edition: "Rumours (Super Deluxe) · 58 tracks" },
    ]);
    expect(candidateImageUrls(list.candidates[0].id, "full")).toEqual([
      "https://cdn-images.dzcdn.net/images/cover/9732751ce91d786dcf30069853697078/1000x1000-000000-80-0-0.jpg",
    ]);
  });

  it("falls back to a plain search, then says nothing matched", async () => {
    const id = album("Tusk", "Fleetwood Mac");
    answers.set(search('artist:"Fleetwood Mac" album:"Tusk"'), { json: { data: [] } });
    answers.set(search("Fleetwood Mac Tusk"), { json: { data: [] } });
    const list = await listCandidates(coverSubject(db, id)!, "deezer");
    expect(list.match).toBeNull();
    expect(fetchedUrls()).toEqual([search('artist:"Fleetwood Mac" album:"Tusk"'), search("Fleetwood Mac Tusk")]);
  });

  it("fails when Deezer refuses, rather than reading it as no albums", async () => {
    const id = album("Rumours", "Fleetwood Mac");
    answers.set(search('artist:"Fleetwood Mac" album:"Rumours"'), { json: { error: { message: "Quota limit exceeded" } } });
    await expect(listCandidates(coverSubject(db, id)!, "deezer")).rejects.toThrow("Quota limit exceeded");
  });
});

describe("candidate images", () => {
  it("only names images on the Cover Art Archive and Deezer, by ids this server makes", () => {
    expect(candidateImageUrls(`caa:${CD}:front`, "thumb")).toEqual([`https://coverartarchive.org/release/${CD}/front-250.jpg`]);
    expect(candidateImageUrls(`caa:${CD}:4647807254`, "full")).toEqual([
      `https://coverartarchive.org/release/${CD}/4647807254-1200.jpg`,
      `https://coverartarchive.org/release/${CD}/4647807254.jpg`,
      `https://coverartarchive.org/release/${CD}/4647807254-500.jpg`,
    ]);
    for (const bad of ["https://example.com/x.jpg", `caa:${CD}:../x`, "caa:not-an-mbid:front", "deezer:xyz", `caa:${CD}:front/../../`]) {
      expect(candidateImageUrls(bad, "thumb")).toBeNull();
    }
  });

  it("falls back to the original when an image has no 1200px copy", async () => {
    answers.set(`https://coverartarchive.org/release/${CD}/7.jpg`, { body: "jpeg bytes" });
    const image = await fetchCandidateImage(`caa:${CD}:7`);
    expect(image?.url).toBe(`https://coverartarchive.org/release/${CD}/7.jpg`);
    expect(image?.bytes.toString()).toBe("jpeg bytes");
  });

  // archive.org's storage nodes answer 500 now and then for an image that's
  // there a moment later.
  it("asks again after a server error, then tries the next size", async () => {
    let thumbTries = 0;
    fetchSpy.mockImplementation((async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("front-250.jpg")) {
        thumbTries += 1;
        return thumbTries === 1 ? new Response("", { status: 500 }) : new Response("thumb", { headers: { "Content-Type": "image/jpeg" } });
      }
      if (url.endsWith("front-1200.jpg")) return new Response("", { status: 503 });
      if (url.endsWith("front.jpg")) return new Response("original", { headers: { "Content-Type": "image/jpeg" } });
      return new Response("", { status: 404 });
    }) as typeof fetch);
    expect((await fetchCandidateThumb(`caa:${CD}:front`))?.bytes.toString()).toBe("thumb");
    expect((await fetchCandidateImage(`caa:${CD}:front`))?.bytes.toString()).toBe("original");
  });

  it("refuses something that isn't an image", async () => {
    answers.set(`https://coverartarchive.org/release/${CD}/front-250.jpg`, { body: "<html>", type: "text/html" });
    await expect(fetchCandidateThumb(`caa:${CD}:front`)).rejects.toThrow("isn't an image");
  });

  it("keeps a thumbnail it has fetched", async () => {
    answers.set(`https://coverartarchive.org/release/${CD}/front-250.jpg`, { body: "thumb" });
    await fetchCandidateThumb(`caa:${CD}:front`);
    const again = await fetchCandidateThumb(`caa:${CD}:front`);
    expect(again?.bytes.toString()).toBe("thumb");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
