import { describe, expect, it } from "vitest";
import { longestCommonPathPrefix, normalizeSeparators, parseM3U } from "./m3u-parse.js";

describe("parseM3U", () => {
  it("parses extended M3U with Windows paths and CRLF line endings", () => {
    const content =
      "#EXTM3U\r\n" +
      "#EXTINF:213,Radiohead - Karma Police\r\n" +
      "D:\\Music\\Radiohead\\OK Computer\\06 Karma Police.flac\r\n" +
      "#EXTINF:257,Radiohead - No Surprises\r\n" +
      "D:\\Music\\Radiohead\\OK Computer\\10 No Surprises.flac\r\n";

    const entries = parseM3U(content);
    expect(entries).toEqual([
      {
        position: 1,
        rawPath: "D:\\Music\\Radiohead\\OK Computer\\06 Karma Police.flac",
        extinfDurationSeconds: 213,
        extinfArtist: "Radiohead",
        extinfTitle: "Karma Police",
      },
      {
        position: 2,
        rawPath: "D:\\Music\\Radiohead\\OK Computer\\10 No Surprises.flac",
        extinfDurationSeconds: 257,
        extinfArtist: "Radiohead",
        extinfTitle: "No Surprises",
      },
    ]);
  });

  it("parses macOS-style /Volumes paths with plain LF endings", () => {
    const content = ["#EXTM3U", "#EXTINF:180,Air - La Femme d'Argent", "/Volumes/Music/Air/Moon Safari/01 La Femme d'Argent.flac"].join(
      "\n",
    );

    const entries = parseM3U(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].rawPath).toBe("/Volumes/Music/Air/Moon Safari/01 La Femme d'Argent.flac");
    expect(entries[0].extinfArtist).toBe("Air");
    expect(entries[0].extinfTitle).toBe("La Femme d'Argent");
  });

  it("strips a leading UTF-8 BOM without corrupting the first directive", () => {
    const content = "\uFEFF#EXTM3U\n#EXTINF:100,Artist - Title\n/mnt/music/track.flac\n";
    const entries = parseM3U(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].extinfTitle).toBe("Title");
  });

  it("treats the -1 unknown-duration sentinel as null, not literally -1 seconds", () => {
    const content = "#EXTINF:-1,Some Artist - Some Title\n/mnt/music/unknown-length.flac\n";
    expect(parseM3U(content)[0].extinfDurationSeconds).toBeNull();
  });

  it("splits only on the first ' - ', so a subtitle containing ' - ' stays in the title", () => {
    const content = "#EXTINF:200,Boards of Canada - Roygbiv - Reprise\n/mnt/music/roygbiv.flac\n";
    const entry = parseM3U(content)[0];
    expect(entry.extinfArtist).toBe("Boards of Canada");
    expect(entry.extinfTitle).toBe("Roygbiv - Reprise");
  });

  it("keeps a freeform EXTINF label (no ' - ') as a title with a null artist", () => {
    const content = "#EXTINF:90,Interlude\n/mnt/music/interlude.flac\n";
    const entry = parseM3U(content)[0];
    expect(entry.extinfArtist).toBeNull();
    expect(entry.extinfTitle).toBe("Interlude");
  });

  it("handles a path with no preceding #EXTINF line at all", () => {
    const content = "#EXTM3U\n/mnt/music/no-metadata.flac\n";
    const entry = parseM3U(content)[0];
    expect(entry.extinfDurationSeconds).toBeNull();
    expect(entry.extinfArtist).toBeNull();
    expect(entry.extinfTitle).toBeNull();
  });

  it("skips blank lines and unrecognized '#' directives without erroring", () => {
    const content = ["#EXTM3U", "#EXTALB:Kid A", "", "  ", "#EXTGENRE:Electronic", "/mnt/music/track.flac"].join("\n");
    const entries = parseM3U(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].rawPath).toBe("/mnt/music/track.flac");
  });

  it("numbers entries in file order, 1-based", () => {
    const content = ["/a.flac", "/b.flac", "/c.flac"].join("\n");
    expect(parseM3U(content).map((e) => e.position)).toEqual([1, 2, 3]);
  });
});

describe("normalizeSeparators", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeSeparators("D:\\Music\\Artist\\Track.mp3")).toBe("D:/Music/Artist/Track.mp3");
  });

  it("leaves an already-POSIX path untouched", () => {
    expect(normalizeSeparators("/Volumes/Music/Artist/Track.flac")).toBe("/Volumes/Music/Artist/Track.flac");
  });
});

describe("longestCommonPathPrefix", () => {
  it("finds a Windows drive-and-folder prefix, trimmed to the last separator", () => {
    const paths = [
      "D:/Music/ArtistA/Album/01 Track.mp3",
      "D:/Music/ArtistB/Album/02 Track.mp3",
      "D:/Music/ArtistC/Album/03 Track.mp3",
    ];
    expect(longestCommonPathPrefix(paths)).toBe("D:/Music/");
  });

  it("finds a macOS /Volumes prefix", () => {
    const paths = ["/Volumes/Music/Air/01.flac", "/Volumes/Music/Air/02.flac"];
    expect(longestCommonPathPrefix(paths)).toBe("/Volumes/Music/Air/");
  });

  it("returns an empty string when the paths share no directory", () => {
    expect(longestCommonPathPrefix(["/mnt/a.flac", "D:/b.flac"])).toBe("");
  });

  it("returns an empty string for an empty list", () => {
    expect(longestCommonPathPrefix([])).toBe("");
  });
});
