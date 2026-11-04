import { USER_AGENT } from "./mbClient.js";

export type CaaImage = { bytes: Buffer; mime: string | null };

// The Cover Art Archive redirects /front to whichever image a release-group
// has designated as its front cover — fetch() follows redirects by default,
// so this is a single request regardless of how CAA has that release-group's
// images organized internally. A release-group with no art at all is a
// plain 404, the normal and expected outcome for most of a real library
// (CAA's coverage is nowhere near total), not an error.
export async function fetchCaaFrontImage(releaseGroupMbid: string): Promise<CaaImage | null> {
  const res = await fetch(`https://coverartarchive.org/release-group/${releaseGroupMbid}/front`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Cover Art Archive fetch failed: ${res.status} ${res.statusText}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime: res.headers.get("content-type") };
}

// Issue #461: one image a release holds on the Cover Art Archive, from
// its listing (https://coverartarchive.org/release/{mbid}). `types` is CAA's
// own vocabulary: "Front", "Back", "Booklet", "Medium", "Tray", "Obi",
// "Spine", "Track", "Liner", "Sticker", "Poster", "Watermark", "Raw/Unedited",
// "Other", any number of them on one image.
export type CaaListedImage = {
  id: string;
  types: string[];
  front: boolean;
  back: boolean;
  comment: string | null;
};

type RawCaaImage = { id?: string | number; types?: string[]; front?: boolean; back?: boolean; comment?: string };

export function parseCaaListing(data: { images?: RawCaaImage[] }): CaaListedImage[] {
  return (data.images ?? []).flatMap((image) => {
    // Ids are numbers in older listings and strings in newer ones, and big
    // enough that a number can lose digits, so they're kept as text.
    const id = image.id == null ? "" : String(image.id);
    if (!/^\d+$/.test(id)) return [];
    return [
      {
        id,
        types: image.types ?? [],
        front: image.front === true,
        back: image.back === true,
        comment: image.comment?.trim() || null,
      },
    ];
  });
}

// Every image of one release. A release CAA has nothing for is a 404, an
// answer rather than a failure. The listing redirects to archive.org, which
// fetch follows.
export async function fetchCaaReleaseImages(releaseMbid: string, signal?: AbortSignal): Promise<CaaListedImage[]> {
  const res = await fetch(`https://coverartarchive.org/release/${releaseMbid}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal,
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`Cover Art Archive listing failed: ${res.status} ${res.statusText}`);
  }
  return parseCaaListing((await res.json()) as { images?: RawCaaImage[] });
}

// An image's URL on CAA. `image` is a listed image's id, or "front" or "back"
// for whichever image the release has marked as its front or back, which
// MusicBrainz's release browse says exists without a listing. CAA makes 250,
// 500 and 1200px copies of every image; no size is the original upload,
// which can be a 50 MB scan.
export function caaImageUrl(releaseMbid: string, image: string, px: 250 | 500 | 1200 | null): string {
  return `https://coverartarchive.org/release/${releaseMbid}/${image}${px == null ? "" : `-${px}`}.jpg`;
}
