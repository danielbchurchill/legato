// Turning one credit string into artist nodes is the whole ballgame for the
// artists graph: "JPEGMAFIA; Danny Brown" is two artists that must split,
// and "Peter Bjorn and John" is one band that must not. Nothing in the tag
// distinguishes them except which characters sit between the names, so the
// separator list below is the entire safety argument — and it is
// deliberately short.
//
// Split on these:
//   ";"          Picard and every Vorbis tagger's convention for genuinely
//                distinct credited artists. This is the one that matters.
//   " / "        Slash with surrounding whitespace. The whitespace is
//                load-bearing: a bare "/" would tear "AC/DC" in half.
//   feat./ft./featuring/with   Feature clauses, bracketed or not.
//
// Never split on these, no matter how tempting:
//   "&"          Simon & Garfunkel, Earth, Wind & Fire, Florence + the Machine
//   ","          Earth, Wind & Fire again — the comma is inside the name
//   " and "      Peter Bjorn and John, George Martin and His Orchestra
//
// Both of those last two live in the real library this was written against.
// Splitting on "and" would invent an artist called "His Orchestra" and
// destroy a band called Peter Bjorn and John in the same pass.

// A bracketed feature clause is folded into a plain ";" before splitting,
// so brackets never survive into a name. Doing it this way rather than
// trimming stray brackets off the split parts afterward is what keeps
// "Sunn O)))" intact — a real band whose name genuinely ends in three
// unbalanced brackets, and which any blind bracket-strip silently renames.
const BRACKETED_FEATURE = /\s*[([]\s*(?:featuring|feat\.?|ft\.?|with)\s+([^)\]]*?)\s*[)\]]/gi;

const CREDIT_SEPARATOR = /\s*;\s*|\s+\/\s+|\s+(?:featuring|feat\.?|ft\.?|with)\s+/i;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Individual artists credited by one ARTIST tag, in credit order. The first
 *  entry is the primary performer — callers that need a single artist for a
 *  recording (album aggregates, layout seeding, article generation) all take
 *  the first, so this order is contractual, not incidental. */
export function splitArtistCredit(credit: string | null | undefined): string[] {
  if (!credit) return [];
  const parts = credit.replace(BRACKETED_FEATURE, "; $1").split(CREDIT_SEPARATOR);

  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of parts) {
    const name = part.trim();
    if (name.length === 0) continue;
    // "X feat. X" and other tagger duplication would otherwise mint two
    // identical performed_by edges to the same node.
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

// Whole-name match, not a raw substring test: ARTISTS listing "Air" against
// an ARTIST of "Fairport Convention" would otherwise be swallowed by the
// "air" inside "Fairport", and a genuine featured artist would vanish.
function creditMentions(credit: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, "u").test(credit);
}

/** The ARTISTS multi-value tag minus everything the ARTIST credit already
 *  accounts for — the genuine "featured artist" credits, with no dedicated
 *  tag of their own.
 *
 *  The subtraction is by mention, not by exact string equality, and that is
 *  the fix for a specific real failure: Picard writes ARTISTS from
 *  MusicBrainz's per-artist breakdown of a credit, so a Yellow Submarine
 *  track credited to "George Martin and His Orchestra" carries ARTISTS of
 *  ["George Martin", "His Orchestra"]. Exact-match subtraction kept both,
 *  and the graph grew three nodes for one ensemble. An ARTISTS entry that
 *  the credit string already names is a fragment of an act the graph is
 *  keeping whole, not a separate performer. */
export function extraCreditedArtists(
  credit: string | null | undefined,
  all: string[] | null | undefined,
): string[] {
  if (!all || all.length === 0) return [];
  const creditText = normalizeName(credit ?? "");
  const covered = new Set(splitArtistCredit(credit).map(normalizeName));

  const extras: string[] = [];
  const seen = new Set<string>();
  for (const name of all) {
    const key = normalizeName(name);
    if (key.length === 0 || seen.has(key)) continue;
    if (covered.has(key) || creditMentions(creditText, key)) continue;
    seen.add(key);
    extras.push(name.trim());
  }
  return extras;
}
