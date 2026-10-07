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
//
// Issue #273: "," and "&" do split when something other than the separator
// names the artists on either side of it. "Cage The Elephant, Alison
// Mosshart" is two artists because the file's ARTISTS tag or MusicBrainz's
// artist credit lists them as two; "Crosby, Stills & Nash" stays whole
// because neither ever lists "Crosby" on its own. See splitOnEvidence.

// A bracketed feature clause is folded into a plain ";" before splitting,
// so brackets never survive into a name. Doing it this way rather than
// trimming stray brackets off the split parts afterward is what keeps
// "Sunn O)))" intact — a real band whose name genuinely ends in three
// unbalanced brackets, and which any blind bracket-strip silently renames.
const BRACKETED_FEATURE = /\s*[([]\s*(?:featuring|feat\.?|ft\.?|with)\s+([^)\]]*?)\s*[)\]]/gi;

const CREDIT_SEPARATOR = /\s*;\s*|\s+\/\s+|\s+(?:featuring|feat\.?|ft\.?|with)\s+/i;

// The only joiners evidence can split on. " and " stays out even with
// evidence: Picard tags "George Martin and His Orchestra" with ARTISTS of
// ["George Martin", "His Orchestra"], and that is still one ensemble.
const EVIDENCE_JOINER = /^\s*(?:,\s*&|,|&)\s*/;

// "Joe Loss & His Orchestra" can carry the same ARTISTS breakdown as the
// George Martin credit above, joined by "&" this time. A name that opens
// with a possessive belongs to the name before it, so a line that would
// leave one standing alone isn't split.
const DEPENDENT_NAME = /^(?:his|her|their)\s/i;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function collapseSpaces(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Reads `part` as two or more of the `evidence` names joined by "," or
 *  "&", the way a file's ARTISTS tag or a MusicBrainz artist credit lists
 *  them. Returns the names as the tag spells them, or null when the
 *  evidence doesn't account for every character between the joiners. A
 *  name that itself contains "," or "&" ("Earth, Wind & Fire & The
 *  Emotions") is matched whole, because each try consumes a full
 *  evidence name before it looks for a joiner. */
function splitOnEvidence(part: string, evidence: readonly string[]): string[] | null {
  const text = collapseSpaces(part);
  const names = [...new Set(evidence.map(collapseSpaces).filter((name) => name.length > 0))];
  if (names.length < 2) return null;

  const from = (start: number): string[] | null => {
    for (const name of names) {
      const candidate = text.slice(start, start + name.length);
      if (candidate.toLowerCase() !== name.toLowerCase()) continue;
      const end = start + name.length;
      if (end === text.length) return [candidate];
      const joiner = EVIDENCE_JOINER.exec(text.slice(end));
      if (!joiner) continue;
      const rest = from(end + joiner[0].length);
      if (rest) return [candidate, ...rest];
    }
    return null;
  };

  const split = from(0);
  if (!split || split.length < 2 || split.some((name) => DEPENDENT_NAME.test(name))) return null;
  return split;
}

/** Individual artists credited by one ARTIST tag, in credit order. The first
 *  entry is the primary performer — callers that need a single artist for a
 *  recording (album aggregates, layout seeding, article generation) all take
 *  the first, so this order is contractual, not incidental.
 *
 *  `evidence` is every name something other than the separators says is a
 *  separate artist on this recording: the file's ARTISTS values, the
 *  MusicBrainz artist credit. A part joined by "," or "&" splits only when
 *  it reads as those names and nothing else (splitOnEvidence). */
export function splitArtistCredit(
  credit: string | null | undefined,
  evidence: readonly string[] = [],
): string[] {
  if (!credit) return [];
  const parts = credit
    .replace(BRACKETED_FEATURE, "; $1")
    .split(CREDIT_SEPARATOR)
    .flatMap((part) => splitOnEvidence(part, evidence) ?? [part]);

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

/** A producer or engineer line split by evidence alone, the separators
 *  above left out (match/edges.ts says why). Trimmed, whole, when the
 *  evidence doesn't account for it. */
export function splitJoinedNames(line: string, evidence: readonly string[]): string[] {
  const names = splitOnEvidence(line, evidence) ?? [line];
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
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
