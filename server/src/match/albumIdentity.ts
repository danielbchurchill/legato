import { splitArtistCredit } from "../scan/artist-credit.js";
import { artistNameKey } from "./artistLookup.js";

// Issue #465: which album a file belongs to. An album node used to be found
// by its ALBUM tag alone, so "Farewells & Fantasies (disc 1)" and "(disc 2)"
// were two albums, and two artists' "Greatest Hits" were one. This file
// works out, from the files of one album folder, which album each of them is
// on; the node that album is lives in match/releases.ts. Pure, so the rule
// can be tested without a database, and so scan/tags.ts can take a disc
// number from the title without reaching into the database layer.

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

// Paths are stored with "/" on every platform (the scan's walk normalises
// them), but a path with "\" is split on that too, so a folder is never
// misread.
function lastSeparator(filePath: string): number {
  return Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
}

/** The folder an album's files are in, and the disc a folder's name gave.
 *  A disc subfolder counts as its parent: "Album/CD1/01.flac" and
 *  "Album/CD2/01.flac" are both in "Album". So does a folder named after
 *  one disc of the album, "Album CD1/" and "Album CD2/" side by side being
 *  one album in "Album". */
export function albumFolderOf(filePath: string): { folder: string; disc: number | null } {
  const cut = lastSeparator(filePath);
  if (cut < 0) return { folder: "", disc: null };
  const folder = cut === 0 ? filePath.slice(0, 1) : filePath.slice(0, cut);
  const nameCut = lastSeparator(folder);
  if (nameCut < 0 || nameCut === folder.length - 1) return { folder, disc: null };
  const name = folder.slice(nameCut + 1);
  const parent = nameCut === 0 ? folder.slice(0, 1) : folder.slice(0, nameCut);
  const bare = BRACKETED_SUFFIX.exec(name) ?? BARE_SUFFIX.exec(name);
  if (!bare) return { folder, disc: null };
  const rest = name.slice(0, bare.index).trim();
  const disc = discNumber(bare[1]!);
  if (rest === "") return { folder: parent, disc };
  return { folder: `${folder.slice(0, nameCut + 1)}${rest}`, disc };
}

export function albumFolder(filePath: string): string {
  return albumFolderOf(filePath).folder;
}

/** What the album rule reads about one file: its path and four tags. */
export type AlbumFile = {
  id: number;
  path: string;
  album: string | null;
  albumartist: string | null;
  artist: string | null;
  discNo: number | null;
  trackNo: number | null;
};

export type AlbumIdentity = {
  /** The album's title as it's shown: the ALBUM tag without its disc suffix. */
  title: string;
  /** The disc the title's suffix named, if it named one. */
  disc: number | null;
  /** The key of this title by one artist, when the album has one. */
  artistKey: string | null;
  /** The key of this title in this album folder. */
  folderKey: string;
};

type Member = {
  file: AlbumFile;
  title: string;
  disc: number | null;
  /** The disc for telling two files' places apart: the tag, the title's
   *  suffix, a disc folder's name, or else the first. */
  position: string | null;
  albumArtist: string | null;
  /** Who the file says the album is by: its ALBUMARTIST, or else the first
   *  name its ARTIST line credits. */
  name: string | null;
};

function nonEmpty(value: string | null | undefined): string | null {
  return value != null && String(value).trim() !== "" ? String(value) : null;
}

function member(file: AlbumFile, title: string, suffixDisc: number | null, folderDisc: number | null): Member {
  const albumArtist = nonEmpty(file.albumartist);
  const primary = splitArtistCredit(nonEmpty(file.artist))[0] ?? null;
  const disc = file.discNo ?? suffixDisc ?? folderDisc ?? 1;
  return {
    file,
    title,
    disc: suffixDisc,
    position: file.trackNo == null ? null : `${disc}:${file.trackNo}`,
    albumArtist: albumArtist === null ? null : artistNameKey(albumArtist),
    name: albumArtist !== null ? artistNameKey(albumArtist) : primary === null ? null : artistNameKey(primary),
  };
}

/** Whether files with different names sit at the same disc and track: two
 *  same-titled albums in one folder, rather than one album by several. */
function placesCollide(members: Member[]): boolean {
  const byPlace = new Map<string, string | null>();
  for (const m of members) {
    if (m.position === null) continue;
    if (!byPlace.has(m.position)) byPlace.set(m.position, m.name);
    else if (byPlace.get(m.position) !== m.name) return true;
  }
  return false;
}

/** Which album each file of one album folder and title is on. The rule,
 *  decided over the whole group, so every file of an album gets the same
 *  answer:
 *
 *  - if the files agree on who the album is by (their ALBUMARTIST, or with
 *    none, the first name of their ARTIST line), it's that title by that
 *    artist, wherever its files are, so two folders holding one artist's
 *    album are one album;
 *  - if they don't, and no two files by different artists share a disc and
 *    track, it's one album by several: a compilation, the title in this
 *    folder. If exactly one ALBUMARTIST is among them, it's by that artist.
 *    Where several ALBUMARTISTs disagree, every file needs a track number
 *    for this, since an ALBUMARTIST says outright whose album a file is on;
 *  - otherwise it's same-titled albums in one folder, each file on its own
 *    artist's.
 *
 *  A file with neither tag, in a folder of artists' albums, is on the title
 *  in this folder. */
function resolveGroup(members: Member[], titleKey: string, folder: string): Map<number, AlbumIdentity> {
  const folderKey = JSON.stringify(["folder", titleKey, folder]);
  const artistKey = (name: string | null) => (name === null ? null : JSON.stringify(["artist", titleKey, name]));
  const names = new Set(members.map((m) => m.name).filter((n): n is string => n !== null));
  const albumArtists = new Set(members.map((m) => m.albumArtist).filter((n): n is string => n !== null));
  const unnamed = members.some((m) => m.name === null);

  let keyOf: (m: Member) => string | null;
  if (names.size <= 1 && !(names.size === 1 && unnamed && placesCollide(members))) {
    const only = names.size === 1 ? artistKey([...names][0]!) : null;
    keyOf = () => only;
  } else {
    const oneAlbum = !placesCollide(members) && (albumArtists.size < 2 || members.every((m) => m.position !== null));
    if (oneAlbum) {
      const only = albumArtists.size === 1 ? artistKey([...albumArtists][0]!) : null;
      keyOf = () => only;
    } else {
      keyOf = (m) => artistKey(m.name);
    }
  }

  const identities = new Map<number, AlbumIdentity>();
  for (const m of members) {
    identities.set(m.file.id, { title: m.title, disc: m.disc, artistKey: keyOf(m), folderKey });
  }
  return identities;
}

/** Which album each of `files` is on, by the rule in resolveGroup, applied
 *  to each album folder and title among them. A file without an ALBUM tag
 *  is on none. The caller passes every present file of each group it asks
 *  about: match/releases.ts reads a folder's, the startup upgrade every
 *  file's. */
export function albumIdentities(files: AlbumFile[]): Map<number, AlbumIdentity> {
  const groups = new Map<string, { titleKey: string; folder: string; members: Member[] }>();
  for (const file of files) {
    const album = nonEmpty(file.album);
    if (album === null) continue;
    const { title, disc } = stripDiscSuffix(album);
    const { folder, disc: folderDisc } = albumFolderOf(file.path);
    const titleKey = title.toLowerCase();
    const groupKey = JSON.stringify([folder, titleKey]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { titleKey, folder, members: [] };
      groups.set(groupKey, group);
    }
    group.members.push(member(file, title, disc, folderDisc));
  }
  const identities = new Map<number, AlbumIdentity>();
  for (const { titleKey, folder, members } of groups.values()) {
    for (const [id, identity] of resolveGroup(members, titleKey, folder)) identities.set(id, identity);
  }
  return identities;
}
