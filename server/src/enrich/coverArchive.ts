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
