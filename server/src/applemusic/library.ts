import { parsePlist, PlistError, type PlistDict, type PlistValue } from "./plist.js";

// What #133 takes from Apple Music's Library.xml: File → Library → Export
// Library in Music, or the file Music keeps up to date beside its library
// with "Share Library XML with other applications" turned on (Settings →
// Advanced). Both are the same plist. No private API, and nothing read from
// Music's own database.

export type TrackKind =
  // A file on this Mac's disk: "Track Type" File, with a Location.
  | "local"
  // In the library but not downloaded: no Location, or "Track Type" Remote.
  // Apple Music streams, and purchases or iTunes Match tracks left in the
  // cloud.
  | "cloud"
  // Not music Legato would play: podcasts, videos, internet radio.
  | "other";

export type MusicTrack = {
  trackId: number;
  persistentId: string | null;
  name: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  durationMs: number | null;
  kind: TrackKind;
  // The file's path on the Mac (or PC) that wrote the library, from its
  // file:// URL. Null for a cloud track.
  location: string | null;
  playCount: number;
  // Music's "Play Date UTC", an ISO time; null when it has none.
  lastPlayedAt: string | null;
  // Music's 0–100 (20 a star), only when it was set on the track itself.
  rating: number | null;
  dateAdded: string | null;
};

export type PlaylistKind =
  // One the person made: imported.
  | "user"
  // Rules rather than a list, which Legato has no way to keep.
  | "smart"
  // Music's own: the library, Music, Downloaded, Podcasts, Genius mixes.
  | "built-in"
  // A folder of playlists. Its playlists are imported on their own.
  | "folder";

export type MusicPlaylist = {
  persistentId: string | null;
  name: string;
  kind: PlaylistKind;
  // Track ids in the playlist's order.
  trackIds: number[];
};

export type MusicLibrary = {
  tracks: Map<number, MusicTrack>;
  playlists: MusicPlaylist[];
};

export class LibraryXmlError extends Error {}

const isDict = (value: PlistValue | undefined): value is PlistDict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: PlistValue | undefined): string | null => (typeof value === "string" ? value : null);
const num = (value: PlistValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const flag = (value: PlistValue | undefined): boolean => value === true;

/** A Location URL as the path it names: file:///Volumes/Music/A%20B.m4a is
 *  /Volumes/Music/A B.m4a, file://localhost/C:/Music/x.mp3 (iTunes on
 *  Windows) is C:/Music/x.mp3, and file://nas/share/x.mp3 is //nas/share/x.mp3.
 *  Anything that isn't a file URL, or doesn't decode, is null. */
export function fileUrlToPath(url: string): string | null {
  const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(url);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  const host = match[1]!.toLowerCase();
  if (host && host !== "localhost") return `//${match[1]}${decoded}`;
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

function readTrack(id: number, track: PlistDict): MusicTrack {
  const trackType = str(track["Track Type"]);
  const rawLocation = str(track["Location"]);
  const location = rawLocation ? fileUrlToPath(rawLocation) : null;
  const notMusic =
    trackType === "URL" ||
    flag(track["Podcast"]) ||
    flag(track["iTunesU"]) ||
    flag(track["Movie"]) ||
    flag(track["TV Show"]) ||
    flag(track["Music Video"]) ||
    flag(track["Has Video"]);
  const kind: TrackKind = notMusic ? "other" : trackType === "Remote" || !location ? "cloud" : "local";
  const rating = num(track["Rating"]);
  return {
    trackId: num(track["Track ID"]) ?? id,
    persistentId: str(track["Persistent ID"]),
    name: str(track["Name"]),
    artist: str(track["Artist"]),
    albumArtist: str(track["Album Artist"]),
    album: str(track["Album"]),
    trackNumber: num(track["Track Number"]),
    discNumber: num(track["Disc Number"]),
    durationMs: num(track["Total Time"]),
    kind,
    location: kind === "local" ? location : null,
    playCount: Math.max(0, Math.trunc(num(track["Play Count"]) ?? 0)),
    lastPlayedAt: str(track["Play Date UTC"]),
    // "Rating Computed" means Music filled it in from an album rating.
    rating: rating != null && rating > 0 && !flag(track["Rating Computed"]) ? Math.min(100, rating) : null,
    dateAdded: str(track["Date Added"]),
  };
}

function readPlaylist(playlist: PlistDict): MusicPlaylist {
  const kind: PlaylistKind = flag(playlist["Folder"])
    ? "folder"
    : flag(playlist["Master"]) ||
        playlist["Distinguished Kind"] !== undefined ||
        playlist["Genius Track ID"] !== undefined ||
        playlist["Visible"] === false
      ? "built-in"
      : playlist["Smart Info"] !== undefined
        ? "smart"
        : "user";
  const items = playlist["Playlist Items"];
  const trackIds = Array.isArray(items)
    ? items.flatMap((item) => {
        const id = isDict(item) ? num(item["Track ID"]) : null;
        return id == null ? [] : [id];
      })
    : [];
  return {
    persistentId: str(playlist["Playlist Persistent ID"]),
    name: str(playlist["Name"]) ?? "Untitled playlist",
    kind,
    trackIds,
  };
}

export function readMusicLibrary(xml: string): MusicLibrary {
  let root: PlistValue;
  try {
    root = parsePlist(xml);
  } catch (err) {
    if (err instanceof PlistError)
      throw new LibraryXmlError(`This isn't a Library.xml Music could have written. ${err.message}`);
    throw err;
  }
  if (!isDict(root) || !isDict(root["Tracks"])) {
    throw new LibraryXmlError("This property list has no tracks, so it isn't a Music or iTunes library.");
  }
  const tracks = new Map<number, MusicTrack>();
  for (const [key, value] of Object.entries(root["Tracks"])) {
    if (!isDict(value)) continue;
    const track = readTrack(Number(key), value);
    tracks.set(track.trackId, track);
  }
  const playlists = Array.isArray(root["Playlists"]) ? root["Playlists"].filter(isDict).map(readPlaylist) : [];
  return { tracks, playlists };
}
