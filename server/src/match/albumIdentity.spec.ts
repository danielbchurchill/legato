import { describe, expect, it } from "bun:test";
import { albumFolder, albumFolderOf, albumIdentities, stripDiscSuffix, type AlbumFile } from "./albumIdentity.js";

describe("stripDiscSuffix", () => {
  it.each([
    ["Amchitka-The 1970 Concert That Launched Greenpeace CD1", "Amchitka-The 1970 Concert That Launched Greenpeace", 1],
    ["Amchitka-The 1970 Concert That Launched Greenpeace CD2", "Amchitka-The 1970 Concert That Launched Greenpeace", 2],
    ["Farewells & Fantasies (disc 1)", "Farewells & Fantasies", 1],
    ["Farewells & Fantasies (disc 3)", "Farewells & Fantasies", 3],
    ["The Best Of The Doors [CD1]", "The Best Of The Doors", 1],
    ["The Best Of The Doors [CD2]", "The Best Of The Doors", 2],
    ["Live at Leeds Disc 2", "Live at Leeds", 2],
    ["Live at Leeds - Disc 1", "Live at Leeds", 1],
    ["Live at Leeds (Disc 1 of 2)", "Live at Leeds", 1],
    ["Live at Leeds [Disc 2 of 2]", "Live at Leeds", 2],
    ["Live at Leeds, Disc 2", "Live at Leeds", 2],
    ["Live at Leeds: CD 2", "Live at Leeds", 2],
    ["Live at Leeds_CD1", "Live at Leeds", 1],
    ["Live at Leeds CD-2", "Live at Leeds", 2],
    ["Live at Leeds CD01", "Live at Leeds", 1],
    ["Live at Leeds (CD 2/2)", "Live at Leeds", 2],
    ["Live at Leeds {cd 1}", "Live at Leeds", 1],
    ["Live at Leeds (Disk 2)", "Live at Leeds", 2],
    ["Live at Leeds (Disc Two)", "Live at Leeds", 2],
    ["live at leeds disc 1", "live at leeds", 1],
    ["LIVE AT LEEDS (DISC 2)", "LIVE AT LEEDS", 2],
    ["Live at Leeds  [CD2]  ", "Live at Leeds", 2],
  ])("%s is %s, disc %d", (input, title, disc) => {
    expect(stripDiscSuffix(input)).toEqual({ title, disc });
  });

  it.each([
    "The Traveling Wilburys Collection [2CD]",
    "The Pretender [DCC GZS-1047]",
    "Greatest Hits 2CD",
    "Abbey Road",
    "Discovery",
    "ABCD1",
    "Live at Budokan CD 1978",
    "Disc 1: The Early Years",
  ])("leaves %s alone", (input) => {
    expect(stripDiscSuffix(input)).toEqual({ title: input, disc: null });
  });

  it("leaves a title that is nothing but a disc suffix whole", () => {
    expect(stripDiscSuffix("CD1")).toEqual({ title: "CD1", disc: null });
    expect(stripDiscSuffix("(Disc 2)")).toEqual({ title: "(Disc 2)", disc: null });
  });
});

describe("albumFolder", () => {
  it("is the file's folder", () => {
    expect(albumFolder("/music/Neil Young/Harvest/01 Out on the Weekend.flac")).toBe("/music/Neil Young/Harvest");
  });

  it.each(["CD1", "CD 2", "cd2", "Disc 1", "disc 02", "Disk 3", "(Disc 1)", "[CD2]"])(
    "counts a disc subfolder named %s as its parent",
    (name) => {
      expect(albumFolder(`/music/The Doors/The Best Of The Doors/${name}/01.flac`)).toBe(
        "/music/The Doors/The Best Of The Doors",
      );
    },
  );

  it("counts a folder named after one disc of the album as the album's folder", () => {
    const one = albumFolder("/music/Various/Amchitka CD1/01.flac");
    const two = albumFolder("/music/Various/Amchitka CD2/01.flac");
    expect(one).toBe("/music/Various/Amchitka");
    expect(two).toBe(one);
    expect(albumFolder("/music/Various/Amchitka (Disc 2)/01.flac")).toBe(one);
  });

  it("leaves a folder whose name only looks like a set marker alone", () => {
    expect(albumFolder("/music/Traveling Wilburys/Collection [2CD]/01.flac")).toBe(
      "/music/Traveling Wilburys/Collection [2CD]",
    );
  });

  it("copes with a file at the top of the file system", () => {
    expect(albumFolder("/01.flac")).toBe("/");
  });
});

describe("albumFolderOf", () => {
  it("gives the disc a disc folder's name says", () => {
    expect(albumFolderOf("/m/Doors/Best Of/CD2/01.flac")).toEqual({ folder: "/m/Doors/Best Of", disc: 2 });
    expect(albumFolderOf("/m/Various/Amchitka CD2/01.flac")).toEqual({ folder: "/m/Various/Amchitka", disc: 2 });
    expect(albumFolderOf("/m/Neil Young/Harvest/01.flac")).toEqual({ folder: "/m/Neil Young/Harvest", disc: null });
  });

  it("reads a path with backslashes the same way", () => {
    expect(albumFolderOf("C:\\Music\\Doors\\Best Of\\CD1\\01.flac")).toEqual({
      folder: "C:\\Music\\Doors\\Best Of",
      disc: 1,
    });
  });
});

let nextId = 1;
function file(path: string, tags: Partial<Omit<AlbumFile, "id" | "path">>): AlbumFile {
  return {
    id: nextId++,
    path,
    album: null,
    albumartist: null,
    artist: null,
    discNo: null,
    trackNo: null,
    ...tags,
  };
}

/** The identity of each file, in the order given. */
function identities(...files: AlbumFile[]) {
  const all = albumIdentities(files);
  return files.map((f) => all.get(f.id) ?? null);
}

/** How many albums the files make, by the key each lands on. */
function albumCount(...files: AlbumFile[]): number {
  return new Set(identities(...files).map((i) => i && (i.artistKey ?? i.folderKey))).size;
}

describe("albumIdentities", () => {
  it("has no album without an ALBUM tag", () => {
    expect(identities(file("/m/a.flac", {}), file("/m/b.flac", { album: "   " }))).toEqual([null, null]);
  });

  it("files a set's discs under one title and one key, with the suffix's disc", () => {
    const [one, three] = identities(
      file("/m/Ochs/F&F/01.flac", { album: "Farewells & Fantasies (disc 1)", albumartist: "Phil Ochs" }),
      file("/m/Ochs/F&F/40.flac", { album: "Farewells & Fantasies (disc 3)", albumartist: "Phil Ochs" }),
    );
    expect(one).toMatchObject({ title: "Farewells & Fantasies", disc: 1 });
    expect(three).toMatchObject({ title: "Farewells & Fantasies", disc: 3 });
    expect(three!.artistKey).toBe(one!.artistKey);
  });

  // The reference library's Amchitka: a live compilation whose ALBUMARTIST
  // is each track's performer.
  it("keeps a compilation tagged with each performer as ALBUMARTIST as one album", () => {
    const base = "/m/Various Artists/Amchitka-The 1970 Concert That Launched Greenpeace CD1";
    const amchitka = (sub: string, n: number, albumartist: string, disc: number) =>
      file(`${base}/${sub}/${String(n).padStart(2, "0")} - ${albumartist}.flac`, {
        album: `Amchitka-The 1970 Concert That Launched Greenpeace ${sub}`,
        albumartist,
        artist: albumartist,
        discNo: disc,
        trackNo: n,
      });
    const all = identities(
      amchitka("CD1", 1, "Phil Ochs", 1),
      amchitka("CD1", 12, "James Taylor", 1),
      amchitka("CD2", 1, "Joni Mitchell", 2),
    );
    expect(new Set(all.map((i) => JSON.stringify([i!.artistKey, i!.folderKey]))).size).toBe(1);
    expect(all[0]).toMatchObject({ title: "Amchitka-The 1970 Concert That Launched Greenpeace", artistKey: null });
    expect(all.map((i) => i!.disc)).toEqual([1, 1, 2]);
  });

  it("puts one artist's album tagged with ALBUMARTIST in one folder and only ARTIST in another together", () => {
    const [tagged, untagged] = identities(
      file("/m/Phil Ochs/I Ain't Marching Anymore/01.flac", {
        album: "I Ain't Marching Anymore",
        albumartist: "Phil Ochs",
        artist: "Phil Ochs",
        trackNo: 1,
      }),
      file("/m/Phil Ochs/All News That's Fit to Sing/CD2/01.flac", {
        album: "I Ain't Marching Anymore",
        artist: "Phil Ochs",
        discNo: 2,
        trackNo: 1,
      }),
    );
    expect(tagged!.artistKey).not.toBeNull();
    expect(untagged!.artistKey).toBe(tagged!.artistKey);
  });

  it("keeps two artists' Greatest Hits in one folder apart when their track numbers collide", () => {
    const hits = (n: number, artist: string, albumartist: string | null) =>
      file(`/m/Hits/${artist}${n}.flac`, { album: "Greatest Hits", artist, albumartist, trackNo: n });
    expect(albumCount(hits(1, "Queen", "Queen"), hits(2, "Queen", "Queen"), hits(1, "ABBA", "ABBA"))).toBe(2);
    expect(albumCount(hits(1, "Queen", null), hits(2, "Queen", null), hits(1, "ABBA", null))).toBe(2);
    // One tagged and one not.
    expect(albumCount(hits(1, "Queen", "Queen"), hits(1, "ABBA", null), hits(2, "ABBA", null))).toBe(2);
  });

  it("keeps two artists' Greatest Hits in two folders apart", () => {
    expect(
      albumCount(
        file("/m/Queen/Greatest Hits/01.flac", { album: "Greatest Hits", albumartist: "Queen", trackNo: 1 }),
        file("/m/ABBA/Greatest Hits/01.flac", { album: "Greatest Hits", albumartist: "ABBA", trackNo: 1 }),
      ),
    ).toBe(2);
    expect(
      albumCount(
        file("/m/Queen/Greatest Hits/01.flac", { album: "Greatest Hits", artist: "Queen", trackNo: 1 }),
        file("/m/ABBA/Greatest Hits/01.flac", { album: "Greatest Hits", artist: "ABBA", trackNo: 1 }),
      ),
    ).toBe(2);
  });

  it("keeps ALBUMARTISTs that disagree apart unless every file is numbered", () => {
    expect(
      albumCount(
        file("/m/Hits/q.flac", { album: "Greatest Hits", albumartist: "Queen" }),
        file("/m/Hits/a.flac", { album: "Greatest Hits", albumartist: "ABBA" }),
      ),
    ).toBe(2);
  });

  it("keeps a compilation without ALBUMARTIST in one folder as one album, by folder", () => {
    const all = identities(
      file("/m/Comp/Nuggets/01.flac", { album: "Nuggets", artist: "The Electric Prunes", trackNo: 1 }),
      file("/m/Comp/Nuggets/02.flac", { album: "Nuggets", artist: "The Standells", trackNo: 2 }),
      file("/m/Comp/Nuggets/03.flac", { album: "Nuggets" }),
    );
    expect(all.map((i) => i!.artistKey)).toEqual([null, null, null]);
    expect(new Set(all.map((i) => i!.folderKey)).size).toBe(1);
  });

  it("counts disc folders when telling a compilation's places apart", () => {
    expect(
      albumCount(
        file("/m/Comp/Live/CD1/01.flac", { album: "Live", albumartist: "A", trackNo: 1 }),
        file("/m/Comp/Live/CD2/01.flac", { album: "Live", albumartist: "B", trackNo: 1 }),
      ),
    ).toBe(1);
  });

  it("doesn't count two copies of one artist's track as a collision", () => {
    expect(
      albumCount(
        file("/m/Comp/Mix/01.flac", { album: "Mix", artist: "A", trackNo: 1 }),
        file("/m/Comp/Mix/01b.flac", { album: "Mix", artist: "A", trackNo: 1 }),
        file("/m/Comp/Mix/02.flac", { album: "Mix", artist: "B", trackNo: 2 }),
      ),
    ).toBe(1);
  });

  it("takes an album's artist from the first name of its ARTIST line, and folds names as artists are", () => {
    const [plain, featuring, the] = identities(
      file("/m/Queen/A/01.flac", { album: "Live", artist: "Queen" }),
      file("/m/Queen/B/02.flac", { album: "Live", artist: "Queen feat. David Bowie" }),
      file("/m/Doors/C/01.flac", { album: "Live", albumartist: "The Queen" }),
    );
    expect(featuring!.artistKey).toBe(plain!.artistKey);
    expect(the!.artistKey).toBe(plain!.artistKey);
  });

  it("keeps an album where only some tracks have ALBUMARTIST as that artist's", () => {
    const [tagged, untagged] = identities(
      file("/m/Wings/Band on the Run/01.flac", { album: "Band on the Run", albumartist: "Wings", trackNo: 1 }),
      file("/m/Wings/Band on the Run/02.flac", {
        album: "Band on the Run",
        artist: "Paul McCartney & Wings",
        trackNo: 2,
      }),
    );
    expect(untagged!.artistKey).toBe(tagged!.artistKey);
  });
});
