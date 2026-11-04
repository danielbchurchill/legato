import { splitArtistCredit, splitJoinedNames } from "../scan/artist-credit.js";
import type { TagFields } from "./fields.js";

/* Issue #464: renaming an artist rewrites every credit line that names
 * them, and only their part of it. "Danny Brown" renamed in "JPEGMAFIA;
 * Danny Brown" leaves JPEGMAFIA and the "; " alone, and "John" renamed
 * never touches the John in "Peter Bjorn and John".
 *
 * What counts as a part is whatever the scanner reads out of the line, so
 * this asks the scanner's own splitter (scan/artist-credit.ts) rather than
 * keeping a second copy of its rules: each place the name appears is tried
 * with a placeholder in its spot, and kept only when the split reads the
 * placeholder back as a name of its own. */

type Split = (line: string, evidence: readonly string[]) => string[];

// Letters only, so the splitter and the word-boundary test below treat it
// as part of a name, the way they treat the name it stands in for.
const PLACEHOLDER = "Legatorenameplaceholder";

export function normalName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameName(a: string, b: string): boolean {
  return normalName(a) === normalName(b);
}

/** `line` with each part the split reads as `from` turned into `to`, and
 *  the rest of the line as it was. Unchanged when no part is `from`. */
export function renameInLine(line: string, from: string, to: string, split: Split, evidence: readonly string[] = []): string {
  if (!split(line, evidence).some((name) => sameName(name, from))) return line;
  const placeheld = evidence.map((name) => (sameName(name, from) ? PLACEHOLDER : name));
  const words = from.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, "giu");

  let out = line;
  let searchAt = 0;
  for (;;) {
    pattern.lastIndex = searchAt;
    const match = pattern.exec(out);
    if (!match) break;
    const tried = out.slice(0, match.index) + PLACEHOLDER + out.slice(match.index + match[0].length);
    if (split(tried, placeheld).includes(PLACEHOLDER)) {
      out = tried;
      searchAt = match.index + PLACEHOLDER.length;
    } else {
      searchAt = match.index + match[0].length;
    }
  }
  return out.split(PLACEHOLDER).join(to);
}

/** What a file credits, read back the way fields.ts reads it. */
export type CreditFields = Pick<Required<TagFields>, "performers" | "artists" | "albumArtist" | "producer" | "engineer">;

/** The fields to write so a file credits `to` wherever it credited `from`.
 *  Empty when the file doesn't credit `from` at all.
 *
 *  `performerEvidence` and `creditEvidence` are what the scanner splits this
 *  recording's lines with (match/evidence.ts). A line joined by "," or "&"
 *  only splits on evidence, and MusicBrainz's evidence still spells the old
 *  name, so where a renamed line would no longer split without it, the
 *  ARTISTS list is written too, naming each artist the way the line now
 *  does. Picard writes the same list. */
export function renameCredits(
  current: CreditFields,
  from: string,
  to: string,
  performerEvidence: readonly string[],
  creditEvidence: readonly string[],
): TagFields {
  const changes: TagFields = {};
  const renamedEvidence = (names: readonly string[]) => names.map((name) => (sameName(name, from) ? to : name));

  const performers = current.performers.map((line) => renameInLine(line, from, to, splitArtistCredit, performerEvidence));
  const performersChanged = performers.some((line, i) => line !== current.performers[i]);
  if (performersChanged) {
    // The one-value case is the common one, and reads as "artist" in the
    // review; several values are written whole.
    if (performers.length === 1) changes.artist = performers[0];
    else changes.performers = performers;
  }

  let artists = current.artists.map((name) => (sameName(name, from) ? to : name));
  if (performersChanged && current.artists.length === 0) {
    const evidence = renamedEvidence(performerEvidence);
    const needsEvidence = performers.some(
      (line) => splitArtistCredit(line, evidence).length > splitArtistCredit(line, []).length,
    );
    if (needsEvidence) artists = performers.flatMap((line) => splitArtistCredit(line, evidence));
  }
  if (artists.length !== current.artists.length || artists.some((name, i) => name !== current.artists[i])) {
    changes.artists = artists;
  }

  const albumArtist = renameInLine(current.albumArtist, from, to, splitArtistCredit, performerEvidence);
  if (albumArtist !== current.albumArtist) changes.albumArtist = albumArtist;

  for (const role of ["producer", "engineer"] as const) {
    const lines = current[role].map((line) => renameInLine(line, from, to, splitJoinedNames, creditEvidence));
    if (lines.some((line, i) => line !== current[role][i])) changes[role] = lines;
  }

  return changes;
}
