import type { MbUrlRelation } from "./mbClient.js";
import { USER_AGENT } from "./mbClient.js";

// The description half of enrichment: a paragraph about who an artist is or
// what an album was, which nothing in a local FLAC tag can supply.
//
// Wikipedia is reached *through* MusicBrainz rather than by searching it
// directly. Searching an encyclopedia by name is how you end up with the film
// Abbey Road on a Beatles album node; MusicBrainz already stores a curated
// wikidata relation per entity, so the identity question is answered by a
// music database and only the prose comes from the encyclopedia. Two extra
// round trips (relations, then the sitelink) buy a correct article instead of
// a plausible one.
//
// No API key on any of it. The REST summary endpoint is the same one
// Wikipedia's own link previews use.

// Wikipedia text is CC BY-SA, which is a real obligation, not a footnote: the
// UI has to show where it came from. Stored per row (descriptions.license)
// rather than assumed, so a second provider with different terms can coexist
// without anything downstream having to know which is which.
export const WIKIPEDIA_LICENSE = "CC BY-SA 4.0";

export type FetchedDescription = {
  body: string;
  sourceUrl: string;
  license: string;
};

// https://www.wikidata.org/wiki/Q70855114 -> Q70855114
export function parseWikidataId(url: string): string | null {
  const match = /wikidata\.org\/(?:wiki|entity)\/(Q\d+)/i.exec(url);
  return match ? match[1] : null;
}

// https://en.wikipedia.org/wiki/Genesis_Owusu -> { lang: "en", title: "Genesis_Owusu" }
//
// Kept for the older MusicBrainz entities that still carry a direct
// 'wikipedia' relation instead of (or alongside) a wikidata one.
export function parseWikipediaUrl(url: string): { lang: string; title: string } | null {
  const match = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#]+)/i.exec(url);
  return match ? { lang: match[1], title: decodeURIComponent(match[2]) } : null;
}

// The English article title for a Wikidata item, via its sitelinks.
//
// Uses the action API with props=sitelinks&sitefilter=enwiki rather than
// Special:EntityData: the latter returns the entity's *entire* statement graph,
// which for a well-documented artist is megabytes of claims to find one title
// in (The Beatles' item is one of the largest on Wikidata). English only for
// now — the UI has no language setting to honour, and picking a language the
// user can't read would be worse than showing nothing.
export async function fetchEnwikiTitle(wikidataId: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "wbgetentities",
    ids: wikidataId,
    props: "sitelinks",
    sitefilter: "enwiki",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`https://www.wikidata.org/w/api.php?${params}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Wikidata lookup failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>;
  };
  return data.entities?.[wikidataId]?.sitelinks?.enwiki?.title ?? null;
}

type RawSummary = {
  type?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
};

// Turns a summary response into a description, or nothing.
//
// 'disambiguation' pages are rejected outright — "Revolver (disambiguation)"
// has an extract, and it is a list of unrelated things rather than a
// description of anything. A redirect to one lands here too, which is why this
// is checked on the response rather than on the title going in.
export function parseSummary(data: RawSummary, fallbackUrl: string): FetchedDescription | null {
  if (data.type === "disambiguation") return null;

  const body = data.extract?.trim();
  if (!body) return null;

  return {
    body,
    sourceUrl: data.content_urls?.desktop?.page ?? fallbackUrl,
    license: WIKIPEDIA_LICENSE,
  };
}

export async function fetchSummary(lang: string, title: string): Promise<FetchedDescription | null> {
  // encodeURIComponent, not the raw title: article titles contain spaces,
  // slashes and question marks ("Where Did You Sleep Last Night?"), any of
  // which silently changes the path this resolves to.
  const path = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${path}`;

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Wikipedia summary fetch failed: ${res.status} ${res.statusText}`);
  }

  return parseSummary((await res.json()) as RawSummary, `https://${lang}.wikipedia.org/wiki/${path}`);
}

// The whole chain from a set of MusicBrainz url relations to prose. Returns
// null for every ordinary "there is nothing to show" case — no wiki relation,
// no English article, a disambiguation page — leaving exceptions for the
// genuinely transient failures the job queue should retry.
export async function fetchDescriptionFromRelations(
  relations: MbUrlRelation[],
): Promise<FetchedDescription | null> {
  // Direct wikipedia relation first when one exists: it is one round trip
  // instead of two, and it is what MB's own editors linked.
  for (const relation of relations) {
    if (relation.type !== "wikipedia") continue;
    const parsed = parseWikipediaUrl(relation.url);
    if (parsed) return await fetchSummary(parsed.lang, parsed.title);
  }

  for (const relation of relations) {
    if (relation.type !== "wikidata") continue;
    const wikidataId = parseWikidataId(relation.url);
    if (!wikidataId) continue;
    const title = await fetchEnwikiTitle(wikidataId);
    if (title) return await fetchSummary("en", title);
  }

  return null;
}
