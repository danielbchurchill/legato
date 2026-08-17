// Artist nodes come from tags, and a tag's artist field is whatever the
// person ripping the CD typed. Before any of it is used to ask an outside
// service "who is this and what do they look like", two questions have to be
// answered locally: is this even one artist, and does what came back actually
// name the same one.
//
// Both matter more here than for the MusicBrainz recording match, which has a
// duration, a track number and an album to weigh (enrich/textSearch.ts). A
// name search has the name and nothing else, and the cost of getting it wrong
// is a photograph of a stranger on someone's artist node — visibly, silently
// wrong, in the most prominent place the artist graph has.

// Separators that mean the tag holds a *credit line* rather than an artist:
// "Pussy Riot; Slayyyter", "The Beatles with Billy Preston". Nothing here can
// be resolved to one artist, so nothing should be fetched for it — and both of
// those are real nodes in the current library.
//
// Conspicuously absent: "&" and " and ". Peter Bjorn and John, Simon &
// Garfunkel, Nick Cave and the Bad Seeds — the ampersand is as common inside
// a band's actual name as it is between two of them, so treating it as a
// separator would silently strip enrichment from a whole class of real
// artists. The separators below don't have that problem: none of them appear
// in a real band name often enough to matter.
const CREDIT_SEPARATORS = [";", " / ", " feat.", " feat ", " featuring ", " with ", " vs.", " vs ", " x ", " + "];

export function looksLikeMultipleArtists(name: string): boolean {
  const padded = ` ${name.toLowerCase()} `;
  return CREDIT_SEPARATORS.some((separator) => padded.includes(separator));
}

// Folds away everything two spellings of one artist can differ by without
// being different artists: case, accents, punctuation, a leading article, and
// "&" against "and". Deliberately conservative — it never drops a word, so
// "Pussy Riot" and "Pussy Riot (Karaoke)" stay different, which is exactly
// the Deezer result that would otherwise have put a karaoke act's artwork on
// a Beatles node.
export function normalizeArtistName(name: string): string {
  return name
    .normalize("NFD")
    // Combining marks, i.e. the accents NFD just split off: Sigur Rós ->
    // Sigur Ros, Beyoncé -> Beyonce. Written as escapes, not as the literal
    // characters — a raw combining mark in source is invisible in every diff
    // it ever appears in.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/^\s*the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Whether a search result names the same artist as the local tag. Exact match
// after normalization, nothing fuzzier: a name search already returns near
// misses ranked as though they were hits — Deezer answers "Pussy Riot" with
// "Pussyfoot" as its second result — and there is no second signal here to
// break the tie with.
export function isSameArtist(localName: string, remoteName: string): boolean {
  const local = normalizeArtistName(localName);
  return local.length > 0 && local === normalizeArtistName(remoteName);
}

/** The shape this needs from a MusicBrainz artist search result, declared
 * structurally so the matching rules stay independent of the transport that
 * fetches them (mirroring how textSearch.ts is separate from mbClient.ts). */
export type ArtistCandidate = {
  mbid: string;
  name: string;
  /** MusicBrainz relevance, 0-100. */
  score: number;
  disambiguation: string | null;
};

// A name match alone is not enough to pick a MusicBrainz artist, because
// famous names are exactly the ones with homonyms: MusicBrainz holds four
// artists named "The Beatles" (the Fab Four, a SiIvaGunner collaboration, a
// lo-fi punk act, and a 1960s Philadelphia doo-wop group) and five named
// "Nirvana". Requiring a *unique* name match therefore refused to identify
// almost every well-known artist in a real library — which was the first
// version of this, and it left The Beatles with no photo and no description.
//
// MusicBrainz's own relevance score separates them cleanly, and by a wide
// margin: the Fab Four score 100 against 58 and 56 for the homonyms, the
// grunge Nirvana 100 against 75 for the 60s UK band. So the rule is a clear
// leader rather than a sole candidate — high absolute score, and daylight
// between it and the next artist of the same name.
const MIN_LEADER_SCORE = 90;
const MIN_LEAD_MARGIN = 15;

export function pickArtistMatch(localName: string, candidates: ArtistCandidate[]): ArtistCandidate | null {
  const matches = candidates
    .filter((candidate) => isSameArtist(localName, candidate.name))
    .sort((a, b) => b.score - a.score);

  const [leader, runnerUp] = matches;
  if (!leader || leader.score < MIN_LEADER_SCORE) return null;
  // A genuine tie is an answer: two equally-ranked artists of the same name
  // cannot be told apart from a tag, and guessing would put one band's
  // biography on another band's node.
  if (runnerUp && leader.score - runnerUp.score < MIN_LEAD_MARGIN) return null;
  return leader;
}
