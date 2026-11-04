import path from "node:path";

// Issue #465: which album a file belongs to. An album node used to be found
// by its ALBUM tag alone, so "Farewells & Fantasies (disc 1)" and "(disc 2)"
// were two albums, and two artists' "Greatest Hits" were one. This file
// works out, from one file's tags and path, the album it's on; the node that
// album is lives in match/releases.ts. Pure, so the rule can be tested
// without a database, and so scan/tags.ts can take a disc number from the
// title without reaching into the database layer.

// A disc number in words as well as digits: "Disc One" is as common in
// hand-tagged rips as "Disc 1".
const DISC_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const NUMBER = `(\\d{1,3}|${DISC_WORDS.join("|")})`;
// "CD1", "CD 1", "CD-1", "Disc #2", "disk 3", and "of 2" or "/2" after it.
const DISC = `(?:cd|disc|disk)\\s*[-.#]?\\s*${NUMBER}(?:\\s*(?:of|/)\\s*\\d{1,3})?`;

// "(disc 3)", "[CD2]", "{CD 1}", "(Disc 1 of 2)", at the very end.
const BRACKETED_SUFFIX = new RegExp(`\\s*[([{]\\s*${DISC}\\s*[)\\]}]\\s*$`, "i");
// "… CD1", "… - Disc 1", "…, Disc 2", "…_CD1", at the very end, and only
// after a space or punctuation: "ABCD1" isn't a disc. The separators are
// taken with it, so "Live - Disc 1" is "Live", not "Live -".
const BARE_SUFFIX = new RegExp(`(?:^|[\\s\\-–—_,:;/.]+)${DISC}\\s*$`, "i");

export type DiscSuffix = { title: string; disc: number | null };

function discNumber(word: string): number {
  const asWord = DISC_WORDS.indexOf(word.toLowerCase());
  return asWord >= 0 ? asWord + 1 : Number.parseInt(word, 10);
}

/** An album title without its per-disc suffix ("CD1", "[CD2]", "(disc 3)",
 *  "Disc 2", "- Disc 1", "(Disc 1 of 2)", in any case), and the disc number
 *  the suffix gave. A set marker ("[2CD]") or a catalogue number ("[DCC
 *  GZS-1047]") isn't a disc suffix, and a title that is nothing but one
 *  ("CD1") is left whole: the suffix has to follow something. */
export function stripDiscSuffix(title: string): DiscSuffix {
  const match = BRACKETED_SUFFIX.exec(title) ?? BARE_SUFFIX.exec(title);
  if (!match) return { title: title.trim(), disc: null };
  const rest = title.slice(0, match.index).trim();
  if (rest === "") return { title: title.trim(), disc: null };
  return { title: rest, disc: discNumber(match[1]!) };
}

/** The folder an album's files are in. A disc subfolder counts as its
 *  parent: "Album/CD1/01.flac" and "Album/CD2/01.flac" are both in "Album".
 *  So does a folder named after one disc of the album, "Album CD1/" and
 *  "Album CD2/" side by side being one album in "Album". Paths are compared
 *  as they're stored, with this platform's separators. */
export function albumFolder(filePath: string): string {
  const folder = path.dirname(filePath);
  const name = path.basename(folder);
  const parent = path.dirname(folder);
  if (name === "" || parent === folder) return folder;
  const bare = BRACKETED_SUFFIX.exec(name) ?? BARE_SUFFIX.exec(name);
  if (!bare) return folder;
  const rest = name.slice(0, bare.index).trim();
  return rest === "" ? parent : path.join(parent, rest);
}

export type AlbumIdentity = {
  /** The album's title as it's shown: the ALBUM tag without its disc suffix. */
  title: string;
  /** The disc the suffix named, if it named one. */
  disc: number | null;
  /** The key of this title by this album artist, when the file has an
   *  ALBUMARTIST tag. */
  artistKey: string | null;
  /** The key of this title in this album folder. */
  folderKey: string;
};

function fold(value: string): string {
  return value.trim().toLowerCase();
}

/** The album one file is on, from its ALBUM and ALBUMARTIST tags and its
 *  path, or null when it has no ALBUM tag. match/releases.ts turns this into
 *  a node:
 *
 *  - the title is the ALBUM tag without a disc suffix, compared without case
 *    or outer spaces;
 *  - a file with an ALBUMARTIST tag is on that artist's album of that title,
 *    wherever it is;
 *  - a file without one is on the album of that title in its folder (disc
 *    subfolders count as their parent, see albumFolder), and so is one with
 *    an ALBUMARTIST tag whose album has none of its own yet. */
export function albumIdentity(
  tags: { album?: string | null; albumartist?: string | null },
  filePath: string,
): AlbumIdentity | null {
  if (!tags.album || tags.album.trim() === "") return null;
  const { title, disc } = stripDiscSuffix(tags.album);
  const titleKey = fold(title);
  const albumArtist = tags.albumartist && tags.albumartist.trim() !== "" ? fold(tags.albumartist) : null;
  return {
    title,
    disc,
    artistKey: albumArtist === null ? null : JSON.stringify(["artist", titleKey, albumArtist]),
    folderKey: JSON.stringify(["folder", titleKey, albumFolder(filePath)]),
  };
}
