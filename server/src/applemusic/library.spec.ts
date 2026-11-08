import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileUrlToPath, LibraryXmlError, readMusicLibrary } from "./library.js";
import { decodeXmlText, parsePlist, PlistError } from "./plist.js";

// fixtures/Library.xml is a trimmed library in the plist Music writes,
// made up from start to finish: its artists, its paths (a media folder on
// an external drive, /Volumes/Archive/Music Media) and its ids.
const FIXTURE = readFileSync(path.join(import.meta.dir, "fixtures", "Library.xml"), "utf8");

describe("parsePlist", () => {
  it("reads every kind of value", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>s</key><string>A &#38; B &lt;C&gt; &amp; &#x44;</string>
	<key>empty</key><string></string>
	<key>bare</key><string/>
	<key>i</key><integer>-42</integer>
	<key>r</key><real>0.5</real>
	<key>d</key><date>2025-10-28T20:14:03Z</date>
	<key>yes</key><true/>
	<key>no</key><false/>
	<key>data</key><data>
	AQID
	BA==
	</data>
	<key>list</key><array><integer>1</integer><dict/><array/></array>
	<!-- a comment -->
</dict>
</plist>`;
    expect(parsePlist(xml)).toEqual({
      s: "A & B <C> & D",
      empty: "",
      bare: "",
      i: -42,
      r: 0.5,
      d: "2025-10-28T20:14:03Z",
      yes: true,
      no: false,
      data: "AQIDBA==",
      list: [1, {}, []],
    });
  });

  it("gives a key like __proto__ no special meaning", () => {
    const value = parsePlist("<plist><dict><key>__proto__</key><string>x</string></dict></plist>") as Record<
      string,
      unknown
    >;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(value["__proto__"]).toBe("x");
  });

  it("refuses what isn't a property list, and a broken one, with a reason", () => {
    expect(() => parsePlist("<html><body>hi</body></html>")).toThrow(PlistError);
    expect(() => parsePlist("#EXTM3U\n/music/a.flac")).toThrow("This isn't a property list.");
    expect(() => parsePlist("<plist><dict><key>a</key>")).toThrow(PlistError);
    expect(() => parsePlist("<plist><dict><key>a</key></dict></plist>")).toThrow('The key "a" has no value.');
    expect(() => parsePlist("<plist><array></dict></plist>")).toThrow("An unexpected </dict>.");
  });

  it("decodes Music's numeric references, and leaves a stray & alone", () => {
    expect(decodeXmlText("Salt &#38; Cedar")).toBe("Salt & Cedar");
    expect(decodeXmlText("AT&T")).toBe("AT&T");
  });
});

describe("fileUrlToPath", () => {
  it("decodes a Mac's file URL, accents and all", () => {
    expect(fileUrlToPath("file:///Volumes/Archive/Music%20Media/Caf%C3%A9.m4a")).toBe(
      "/Volumes/Archive/Music Media/Café.m4a",
    );
  });

  it("takes iTunes on Windows' localhost URL as a drive path", () => {
    expect(fileUrlToPath("file://localhost/C:/Users/Public/Music/iTunes/a%20b.mp3")).toBe(
      "C:/Users/Public/Music/iTunes/a b.mp3",
    );
  });

  it("keeps a network share's host", () => {
    expect(fileUrlToPath("file://nas/music/a.flac")).toBe("//nas/music/a.flac");
  });

  it("is null for anything else", () => {
    expect(fileUrlToPath("http://stream.example.org/radio")).toBeNull();
    expect(fileUrlToPath("file:///broken%E0%A4%A")).toBeNull();
  });
});

describe("readMusicLibrary on the fixture", () => {
  const library = readMusicLibrary(FIXTURE);

  it("reads every track", () => {
    expect([...library.tracks.keys()]).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012,
    ]);
  });

  it("reads a local track's facts", () => {
    expect(library.tracks.get(1001)).toEqual({
      trackId: 1001,
      persistentId: "8C1D4E5F60718293",
      name: "Lanterns on the Water",
      artist: "The Paper Boats",
      albumArtist: "The Paper Boats",
      album: "Harbour Songs",
      trackNumber: 1,
      discNumber: 1,
      durationMs: 241066,
      kind: "local",
      location: "/Volumes/Archive/Music Media/Music/The Paper Boats/Harbour Songs/01 Lanterns on the Water.m4a",
      playCount: 12,
      lastPlayedAt: "2025-10-28T20:14:03Z",
      rating: 80,
      dateAdded: "2024-03-02T10:00:12Z",
    });
  });

  it("decodes an & in a name and a path, and keeps a path's decomposed accent", () => {
    expect(library.tracks.get(1002)!.name).toBe("Salt & Cedar");
    expect(library.tracks.get(1002)!.location).toEndWith("/02 Salt & Cedar.m4a");
    expect(library.tracks.get(1003)!.location).toEndWith("/03 Cafe\u0301 Aurore.m4a");
  });

  it("takes a count with no play date as undated, and leaves out a rating Music worked out from the album", () => {
    expect(library.tracks.get(1002)).toMatchObject({ playCount: 3, lastPlayedAt: null, rating: 60 });
    expect(library.tracks.get(1003)!.rating).toBeNull();
    expect(library.tracks.get(1012)).toMatchObject({ playCount: 0, rating: null });
  });

  it("tells cloud tracks from local ones: Apple Music streams and purchases left in the cloud", () => {
    const kinds = Object.fromEntries([...library.tracks].map(([id, t]) => [id, t.kind]));
    expect(kinds).toMatchObject({ 1006: "cloud", 1007: "cloud", 1008: "cloud", 1001: "local", 1005: "local" });
    expect(library.tracks.get(1006)!.location).toBeNull();
  });

  it("sets aside podcasts, videos and internet radio", () => {
    expect([1009, 1010, 1011].map((id) => library.tracks.get(id)!.kind)).toEqual(["other", "other", "other"]);
  });

  it("sorts playlists into the person's own, smart ones, Music's own and folders", () => {
    expect(library.playlists.map((p) => [p.name, p.kind, p.trackIds])).toEqual([
      ["Library", "built-in", [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1010, 1012]],
      ["Downloaded", "built-in", [1001, 1002]],
      ["Music", "built-in", [1001, 1003]],
      ["Podcasts", "built-in", [1009]],
      ["Recently Added", "smart", [1006, 1001]],
      ["Mixes", "folder", []],
      ["Road Trip", "user", [1001, 1004, 1006, 1005]],
      ["Sunday Morning & Coffee", "user", [1003, 1002, 1007, 1008, 1010]],
      ["Empty Ideas", "user", []],
    ]);
  });

  it("refuses an .m3u, or a plist that isn't a library, with a reason", () => {
    expect(() => readMusicLibrary("#EXTM3U\n/a.flac")).toThrow(LibraryXmlError);
    expect(() => readMusicLibrary("<plist><dict><key>a</key><integer>1</integer></dict></plist>")).toThrow(
      "This property list has no tracks, so it isn't a Music or iTunes library.",
    );
  });
});
