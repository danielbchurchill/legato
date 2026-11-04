import type { Database } from "../sqlite.js";
import { isSameArtist, normalizeArtistName } from "../enrich/artistName.js";
import { caaImageUrl, fetchCaaReleaseImages, type CaaListedImage } from "../enrich/coverArchive.js";
import { deezerCoverUrl, searchDeezerAlbums, type DeezerAlbum } from "../enrich/deezer.js";
import {
  browseReleaseGroupReleases,
  searchReleaseGroup,
  USER_AGENT,
  type MbGroupRelease,
} from "../enrich/mbClient.js";

/* Issue #461: an album's cover, chosen from what the Cover Art Archive and
 * Deezer hold for it, the way SteamGridDB lets you choose a game's art.
 *
 * Everything here runs because someone opened the picker: the server looks
 * the album up, lists the candidates and proxies their thumbnails, so a
 * device only ever talks to its own server (a phone through legato.fm
 * included). Nothing is queued, and nothing runs with "Look up metadata
 * online" off; the routes check that before calling in here.
 *
 * A candidate is named by an id that says where its image lives, built from
 * parts this file checks: `caa:{release mbid}:{image id, "front" or "back"}`
 * or `deezer:{md5}`. The thumbnail proxy and the choose route rebuild the
 * URL from those parts, so neither ever fetches a URL a client sent. */

export type CandidateSource = "caa" | "deezer";

export type CoverCandidate = {
  id: string;
  source: CandidateSource;
  /** What the image is, in CAA's words, lowercased: "front", "back",
   * "booklet", "medium", "back, spine". Deezer's are all "front". */
  kind: string;
  /** The edition it's from: "1977 · US", "2013 · XE · deluxe edition",
   * "Rumours (Super Deluxe) · 58 tracks". */
  edition: string;
};

export type CandidateList = {
  source: CandidateSource;
  /** What the source matched the album to. Null when nothing matched. */
  match: { title: string; artist: string | null } | null;
  candidates: CoverCandidate[];
  /** CAA only: how many more images (booklets, discs, trays…) its editions
   * hold beyond the fronts and backs listed, which take a request per
   * edition to list. 0 once they're listed, or when there are none. */
  more: number;
};

/** What the picker searches for: an album's title and artist, and the
 * MusicBrainz ids M-8's album match stored, when it ran. */
export type CoverSubject = {
  nodeId: number;
  title: string;
  artist: string | null;
  releaseGroupMbid: string | null;
  releaseMbid: string | null;
};

function provenance(db: Database, nodeId: number, field: string): string | null {
  const row = db
    .prepare(
      "SELECT value FROM field_provenance WHERE node_id = ? AND field = ? AND value IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get(nodeId, field) as { value: string } | undefined;
  return row?.value ?? null;
}

// Only an album has art of its own to look up. A track's panel opens the
// picker on its album (the client passes the album's id), so a track only
// gets here when it has no album, and then there's no record to search for.
export function coverSubject(db: Database, nodeId: number): CoverSubject | null {
  const node = db.prepare("SELECT type, title FROM nodes WHERE id = ?").get(nodeId) as
    | { type: string; title: string }
    | undefined;
  if (node?.type !== "release" || !node.title.trim()) return null;
  const artist = db
    .prepare("SELECT a.title AS title FROM albums al JOIN nodes a ON a.id = al.primary_artist_node_id WHERE al.node_id = ?")
    .get(nodeId) as { title: string } | undefined;
  return {
    nodeId,
    title: node.title,
    artist: artist?.title ?? null,
    releaseGroupMbid: provenance(db, nodeId, "release_group_mbid"),
    releaseMbid: provenance(db, nodeId, "release_mbid"),
  };
}

// The title an edition carries beyond the album's own: "(Remastered)",
// "[2011 Deluxe Edition]", " - 2009 Remaster". Searched without, and
// compared without, so "Abbey Road (Remastered 2009)" in the tags finds
// "Abbey Road" and Deezer's "Rumours (Super Deluxe)" counts as Rumours.
// Only a trailing group: "(What's the Story) Morning Glory?" keeps its own.
const TRAILING_GROUP = /\s*[([][^()[\]]*[)\]]\s*$/;
const TRAILING_EDITION = /\s+[-–—]\s+[^-–—]*\b(remaster(ed)?|deluxe|edition|expanded|anniversary|version|mono|stereo)\b[^-–—]*$/i;

export function editionlessTitle(title: string): string {
  let out = title.trim();
  for (;;) {
    const next = out.replace(TRAILING_GROUP, "").replace(TRAILING_EDITION, "").trim();
    if (next === out || next === "") return out;
    out = next;
  }
}

/** Two titles for the same record, editions aside. The artist name rules
 * (enrich/artistName.ts) fold case, accents, punctuation and "&". */
export function isSameAlbumTitle(a: string, b: string): boolean {
  const left = normalizeArtistName(editionlessTitle(a));
  return left.length > 0 && left === normalizeArtistName(editionlessTitle(b));
}

// A compilation with no artist on most of its tracks is credited to
// "Various Artists" on MusicBrainz, which is what it's searched as.
const VARIOUS_ARTISTS = "Various Artists";

/* ---- Cover Art Archive ------------------------------------------------------ */

type ReleaseGroupMatch = { mbid: string; title: string; artist: string | null };

// The best release group for a title and artist: the same title, editions
// aside, by the same artist, highest scored. MusicBrainz scores a phrase
// hit 100 whether or not it's the record meant (mbClient's M-2 note), so
// the names have to agree as well.
export function pickReleaseGroup(
  subject: Pick<CoverSubject, "title" | "artist">,
  groups: { mbid: string; score: number; title: string; artist: string | null }[],
): ReleaseGroupMatch | null {
  const artist = subject.artist ?? VARIOUS_ARTISTS;
  const best = groups
    .filter((g) => isSameAlbumTitle(subject.title, g.title) && g.artist != null && isSameArtist(artist, g.artist))
    .sort((a, b) => b.score - a.score)[0];
  return best ? { mbid: best.mbid, title: best.title, artist: best.artist } : null;
}

// Which release group a name search found, per album node, for as long as
// the server runs: a second look at the same album costs no MusicBrainz
// request. Not written to field_provenance, which holds what M-8 matched by
// the album's tracks; a match on a name alone is weaker than that, and other
// lookups (an album's description) read it.
const searchedGroups = new Map<string, ReleaseGroupMatch | null>();

async function resolveReleaseGroup(subject: CoverSubject): Promise<ReleaseGroupMatch | null> {
  if (subject.releaseGroupMbid) {
    return { mbid: subject.releaseGroupMbid, title: subject.title, artist: subject.artist };
  }
  const key = `${subject.nodeId}\u0000${subject.title}\u0000${subject.artist ?? ""}`;
  if (searchedGroups.has(key)) return searchedGroups.get(key)!;
  const groups = await searchReleaseGroup(editionlessTitle(subject.title), subject.artist ?? VARIOUS_ARTISTS);
  const match = pickReleaseGroup(subject, groups);
  searchedGroups.set(key, match);
  return match;
}

// The order editions are offered in: the one the album's tracks matched
// first, then official releases, oldest first, so the original pressing
// leads; then by country, for a stable order.
export function orderReleases(releases: MbGroupRelease[], ownRelease: string | null): MbGroupRelease[] {
  const year = (r: MbGroupRelease) => r.date ?? "9999";
  return [...releases].sort(
    (a, b) =>
      Number(b.mbid === ownRelease) - Number(a.mbid === ownRelease) ||
      Number(b.status === "Official") - Number(a.status === "Official") ||
      year(a).localeCompare(year(b)) ||
      (a.country ?? "").localeCompare(b.country ?? "") ||
      a.mbid.localeCompare(b.mbid),
  );
}

export function editionLabel(release: MbGroupRelease, albumTitle: string): string {
  const parts = [release.date?.slice(0, 4), release.country, release.disambiguation].filter(Boolean) as string[];
  // An edition titled as more than the album ("Rumours (Deluxe)") says so.
  const title = release.title.trim();
  if (title && (!isSameAlbumTitle(title, albumTitle) || editionlessTitle(title) !== title)) parts.unshift(title);
  return parts.join(" · ") || title || "unknown edition";
}

// The images a release has beyond its front and back, by CAA's own summary.
function extraImages(release: MbGroupRelease): number {
  return Math.max(0, release.art.count - Number(release.art.front) - Number(release.art.back));
}

// Where the other images come, after every edition's marked front and back:
// a second front or back first, then the kinds most like a cover.
const KIND_ORDER = ["front", "back", "booklet", "medium", "tray", "obi", "spine", "liner", "track", "sticker", "poster"];

function kindRank(kind: string): number {
  const first = kind.split(",")[0].trim();
  const rank = KIND_ORDER.indexOf(first);
  return rank === -1 ? KIND_ORDER.length : rank;
}

export function caaKind(image: Pick<CaaListedImage, "types">): string {
  return image.types.length > 0 ? image.types.map((t) => t.toLowerCase()).join(", ") : "other";
}

/** Every front, then every back, of the editions with art, and how many
 * more images there are. The fronts and backs come from MusicBrainz's
 * browse alone (CAA serves `/front` and `/back` for any release with one),
 * so this costs MusicBrainz requests and none to CAA. */
export function frontsAndBacks(subject: CoverSubject, releases: MbGroupRelease[]): { candidates: CoverCandidate[]; more: number } {
  const withArt = orderReleases(
    releases.filter((r) => r.art.artwork && !r.art.darkened),
    subject.releaseMbid,
  );
  const candidates: CoverCandidate[] = [];
  for (const side of ["front", "back"] as const) {
    for (const release of withArt) {
      if (!release.art[side]) continue;
      candidates.push({ id: `caa:${release.mbid}:${side}`, source: "caa", kind: side, edition: editionLabel(release, subject.title) });
    }
  }
  return { candidates, more: withArt.reduce((n, r) => n + extraImages(r), 0) };
}

const LISTING_CONCURRENCY = 6;

// Every image of every edition: the fronts and backs as above, then the
// rest, which CAA only lists release by release, six at a time. A release
// whose listing fails is left out rather than failing the rest; if every
// one fails, CAA isn't answering, which is an error.
async function everyImage(
  subject: CoverSubject,
  releases: MbGroupRelease[],
  signal?: AbortSignal,
): Promise<{ candidates: CoverCandidate[]; more: number }> {
  const base = frontsAndBacks(subject, releases);
  const toList = orderReleases(
    releases.filter((r) => r.art.artwork && !r.art.darkened && extraImages(r) > 0),
    subject.releaseMbid,
  );
  const listed = new Map<string, CaaListedImage[]>();
  let failures = 0;
  let next = 0;
  const worker = async () => {
    while (next < toList.length && !signal?.aborted) {
      const release = toList[next++];
      try {
        listed.set(release.mbid, await fetchCaaReleaseImages(release.mbid, signal));
      } catch {
        failures += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LISTING_CONCURRENCY, toList.length) }, worker));
  if (signal?.aborted) throw new Error("the picker closed");
  if (toList.length > 0 && failures === toList.length) throw new Error("the Cover Art Archive didn't list any edition");

  const rest: { candidate: CoverCandidate; order: number }[] = [];
  toList.forEach((release, order) => {
    for (const image of listed.get(release.mbid) ?? []) {
      // The marked front and back are already listed, as `front` and `back`.
      if (image.front || image.back) continue;
      const candidate: CoverCandidate = {
        id: `caa:${release.mbid}:${image.id}`,
        source: "caa",
        kind: caaKind(image),
        edition: editionLabel(release, subject.title),
      };
      rest.push({ candidate, order });
    }
  });
  rest.sort((a, b) => kindRank(a.candidate.kind) - kindRank(b.candidate.kind) || a.order - b.order);
  return { candidates: [...base.candidates, ...rest.map((r) => r.candidate)], more: 0 };
}

/* ---- Deezer -------------------------------------------------------------------- */

/** The albums Deezer has under this title by this artist, one candidate per
 * edition, with an edition whose cover is the same image as one already
 * listed left out. */
export function pickDeezerAlbums(subject: Pick<CoverSubject, "title" | "artist">, albums: DeezerAlbum[]): DeezerAlbum[] {
  const seen = new Set<string>();
  return albums.filter((album) => {
    if (!isSameAlbumTitle(subject.title, album.title)) return false;
    if (subject.artist && !(album.artist && isSameArtist(subject.artist, album.artist))) return false;
    if (seen.has(album.md5)) return false;
    seen.add(album.md5);
    return true;
  });
}

function deezerQueries(subject: CoverSubject): string[] {
  const title = editionlessTitle(subject.title).replace(/"/g, "");
  if (!subject.artist) return [`album:"${title}"`];
  const artist = subject.artist.replace(/"/g, "");
  // The fielded search first, which is precise; Deezer's fielded search is
  // also strict about punctuation, so the plain one is the fallback.
  return [`artist:"${artist}" album:"${title}"`, `${artist} ${title}`];
}

async function listDeezer(subject: CoverSubject): Promise<CandidateList> {
  let matches: DeezerAlbum[] = [];
  for (const query of deezerQueries(subject)) {
    matches = pickDeezerAlbums(subject, await searchDeezerAlbums(query));
    if (matches.length > 0) break;
  }
  return {
    source: "deezer",
    match: matches[0] ? { title: matches[0].title, artist: matches[0].artist } : null,
    candidates: matches.map((album) => ({
      id: `deezer:${album.md5}`,
      source: "deezer",
      kind: "front",
      edition: [album.title, album.tracks ? `${album.tracks} tracks` : null].filter(Boolean).join(" · "),
    })),
    more: 0,
  };
}

/* ---- Lists, cached while the picker is in use ------------------------------- */

// A list is kept for half an hour, so closing the picker and opening it again
// (or the phone's sheet re-rendering) asks nobody twice. Bounded, oldest out.
const LIST_TTL_MS = 30 * 60 * 1000;
const LIST_CACHE_MAX = 100;
const lists = new Map<string, { at: number; value: CandidateList }>();

function cached(key: string): CandidateList | null {
  const hit = lists.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > LIST_TTL_MS) {
    lists.delete(key);
    return null;
  }
  return hit.value;
}

function remember(key: string, value: CandidateList): CandidateList {
  lists.delete(key);
  lists.set(key, { at: Date.now(), value });
  while (lists.size > LIST_CACHE_MAX) lists.delete(lists.keys().next().value!);
  return value;
}

/** For specs: forget every list, search and thumbnail kept so far. */
export function clearCandidateCaches(): void {
  lists.clear();
  searchedGroups.clear();
  thumbs.clear();
}

/** `everything`: CAA's other images too, a request per edition. */
export async function listCandidates(
  subject: CoverSubject,
  source: CandidateSource,
  options: { everything?: boolean; signal?: AbortSignal } = {},
): Promise<CandidateList> {
  const key = `${source}\u0000${subject.nodeId}\u0000${subject.title}\u0000${subject.artist ?? ""}\u0000${subject.releaseGroupMbid ?? ""}\u0000${options.everything ? 1 : 0}`;
  const hit = cached(key);
  if (hit) return hit;

  if (source === "deezer") return remember(key, await listDeezer(subject));

  const group = await resolveReleaseGroup(subject);
  if (!group) return remember(key, { source, match: null, candidates: [], more: 0 });
  const releases = await browseReleaseGroupReleases(group.mbid);
  const found = options.everything ? await everyImage(subject, releases, options.signal) : frontsAndBacks(subject, releases);
  return remember(key, { source, match: { title: group.title, artist: group.artist }, ...found });
}

/* ---- Candidate images ----------------------------------------------------------- */

const MBID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CAA_ID = new RegExp(`^caa:(${MBID}):(front|back|\\d{1,20})$`);
const DEEZER_ID = /^deezer:([0-9a-f]{32})$/;

/** The URLs a candidate's image is fetched from, in order of preference, or
 * null when the id isn't one this file makes. A thumbnail is CAA's or
 * Deezer's 250px copy. The full image is CAA's 1200px copy, falling back to
 * the original for an image too old to have one and then the 500px copy, or
 * Deezer's 1000px cover_xl. The cover cache keeps 512px at most
 * (cover/store.ts). */
export function candidateImageUrls(id: string, size: "thumb" | "full"): string[] | null {
  const caa = CAA_ID.exec(id);
  if (caa) {
    const [, release, image] = caa;
    return size === "thumb"
      ? [caaImageUrl(release, image, 250)]
      : [caaImageUrl(release, image, 1200), caaImageUrl(release, image, null), caaImageUrl(release, image, 500)];
  }
  const deezer = DEEZER_ID.exec(id);
  if (deezer) return [deezerCoverUrl(deezer[1], size === "thumb" ? 250 : 1000)];
  return null;
}

export const MAX_CANDIDATE_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 30_000;

export type CandidateImage = { bytes: Buffer; mime: string; url: string };

export class CandidateFetchError extends Error {}

// The Cover Art Archive redirects every image to one of archive.org's
// storage nodes, and a node answers 500 now and then for an image another
// serves a moment later (seen live on Rumours' fronts while building #461).
// So a 5xx is asked once more, and then the next size is tried.
const RETRY_DELAY_MS = 300;

async function fetchOnce(url: string): Promise<Response> {
  const get = () => fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  const res = await get();
  if (res.status < 500) return res;
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return get();
}

// A candidate's image, or null when its source has no such image (a 404 at
// every URL). Anything that isn't an image, or is bigger than an upload may
// be, is an error rather than art.
async function fetchImage(urls: string[]): Promise<CandidateImage | null> {
  for (const [index, url] of urls.entries()) {
    const res = await fetchOnce(url);
    if (res.status === 404) continue;
    if (res.status >= 500 && index < urls.length - 1) continue;
    if (!res.ok) throw new CandidateFetchError(`${new URL(url).host} answered ${res.status}`);
    const mime = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!mime.startsWith("image/")) throw new CandidateFetchError(`${new URL(url).host} sent ${mime || "something"} that isn't an image`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_CANDIDATE_BYTES) throw new CandidateFetchError("the image is too large");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_CANDIDATE_BYTES) throw new CandidateFetchError("the image is too large");
    return { bytes, mime, url };
  }
  return null;
}

// Thumbnails seen lately, so a picker opened again shows them without going
// back to CAA, whose every image is two redirects away. 300 of about 15 KB.
const THUMB_CACHE_MAX = 300;
const thumbs = new Map<string, CandidateImage>();

/** A candidate's 250px thumbnail, for the picker's grid. */
export async function fetchCandidateThumb(id: string): Promise<CandidateImage | null> {
  const urls = candidateImageUrls(id, "thumb");
  if (!urls) return null;
  const hit = thumbs.get(id);
  if (hit) {
    thumbs.delete(id);
    thumbs.set(id, hit);
    return hit;
  }
  const image = await fetchImage(urls);
  if (image) {
    thumbs.set(id, image);
    while (thumbs.size > THUMB_CACHE_MAX) thumbs.delete(thumbs.keys().next().value!);
  }
  return image;
}

/** A candidate's full image, to store as an album's cover. */
export async function fetchCandidateImage(id: string): Promise<CandidateImage | null> {
  const urls = candidateImageUrls(id, "full");
  return urls ? fetchImage(urls) : null;
}

export function isCandidateId(id: string): boolean {
  return candidateImageUrls(id, "thumb") != null;
}
