import { describe, expect, it } from "bun:test";
import { albumFolder, albumIdentity, stripDiscSuffix } from "./albumIdentity.js";

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

describe("albumIdentity", () => {
  it("has no album without an ALBUM tag", () => {
    expect(albumIdentity({ album: null }, "/m/a.flac")).toBeNull();
    expect(albumIdentity({}, "/m/a.flac")).toBeNull();
    expect(albumIdentity({ album: "   " }, "/m/a.flac")).toBeNull();
  });

  it("files a set's discs under one title and one key", () => {
    const one = albumIdentity({ album: "Farewells & Fantasies (disc 1)" }, "/m/Ochs/F&F/01.flac")!;
    const three = albumIdentity({ album: "Farewells & Fantasies (disc 3)" }, "/m/Ochs/F&F/40.flac")!;
    expect(one.title).toBe("Farewells & Fantasies");
    expect(one.disc).toBe(1);
    expect(three.disc).toBe(3);
    expect(three.folderKey).toBe(one.folderKey);
  });

  it("keys by album artist, ignoring case and outer spaces, wherever the files are", () => {
    const a = albumIdentity({ album: "Greatest Hits", albumartist: "Queen" }, "/m/Queen/GH/01.flac")!;
    const b = albumIdentity({ album: "greatest hits ", albumartist: " queen" }, "/elsewhere/01.flac")!;
    const c = albumIdentity({ album: "Greatest Hits", albumartist: "ABBA" }, "/m/Queen/GH/02.flac")!;
    expect(a.artistKey).not.toBeNull();
    expect(b.artistKey).toBe(a.artistKey);
    expect(c.artistKey).not.toBe(a.artistKey);
  });

  it("has only a folder key without an album artist", () => {
    const a = albumIdentity({ album: "Greatest Hits", albumartist: "" }, "/m/Queen/GH/01.flac")!;
    expect(a.artistKey).toBeNull();
    expect(a.folderKey).not.toBe(albumIdentity({ album: "Greatest Hits" }, "/m/ABBA/GH/01.flac")!.folderKey);
  });
});
