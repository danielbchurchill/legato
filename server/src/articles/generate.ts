// Template-based, not an LLM call, like facts.ts. Where
// facts.ts produces a flat bullet list from local hard edges, this module
// weaves the same underlying data (edges, entity aggregates, collaboration
// ties) into prose: a wiki page dense with links to everything else in
// the collection, the kind that says the engineer also worked on three
// other records you own.
//
// Links use plain markdown syntax with a custom scheme — [text](node:123)
// — real, valid markdown (openable in any editor, not a made-up format),
// but resolved by the frontend's own light parser rather than a full
// markdown library, since paragraphs of prose with inline links is all
// this content ever needs.

export type NodeRef = { id: number; title: string };

function link(node: NodeRef): string {
  return `[${node.title}](node:${node.id})`;
}

function joinLinks(nodes: NodeRef[]): string {
  const links = nodes.map(link);
  if (links.length === 1) return links[0];
  if (links.length === 2) return `${links[0]} and ${links[1]}`;
  return `${links.slice(0, -1).join(", ")}, and ${links[links.length - 1]}`;
}

// Like joinLinks, but for a listing that's about to be capped with a
// ", and N more" suffix — joinLinks' own trailing "and" would otherwise
// collide with that suffix's "and" ("...and X, and 3 more.").
function joinListed(nodes: NodeRef[], remainder: number): string {
  return remainder > 0 ? nodes.map(link).join(", ") : joinLinks(nodes);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export type RecordingArticleInput = {
  artist: NodeRef | null;
  release: NodeRef | null;
  year: number | null;
  label: NodeRef | null;
  producers: NodeRef[];
  engineers: NodeRef[];
  featuredArtists: NodeRef[];
  siblingCount: number;
};

export function generateRecordingArticle(input: RecordingArticleInput): string | null {
  const parts: string[] = [];

  if (input.artist) parts.push(`Performed by ${link(input.artist)}.`);

  if (input.release) {
    let sentence = `Appears on ${link(input.release)}`;
    if (input.year) sentence += `, released in ${input.year}`;
    if (input.label) sentence += ` on ${link(input.label)}`;
    parts.push(`${sentence}.`);
  } else if (input.year) {
    parts.push(`Released in ${input.year}.`);
  }

  if (input.featuredArtists.length > 0) parts.push(`Features ${joinLinks(input.featuredArtists)}.`);
  if (input.producers.length > 0) parts.push(`Produced by ${joinLinks(input.producers)}.`);
  if (input.engineers.length > 0) parts.push(`Engineered by ${joinLinks(input.engineers)}.`);

  if (input.siblingCount > 0) {
    parts.push(`${plural(input.siblingCount, "other track")} from this release ${input.siblingCount === 1 ? "is" : "are"} in your collection.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

export type ArtistArticleInput = {
  trackCount: number;
  albumCount: number;
  collaborators: NodeRef[];
};

export function generateArtistArticle(input: ArtistArticleInput): string | null {
  const parts: string[] = [];

  if (input.trackCount > 0) {
    parts.push(`${plural(input.trackCount, "track")} across ${plural(input.albumCount, "album")} in your collection.`);
  }
  if (input.collaborators.length > 0) {
    parts.push(`Has collaborated with ${joinLinks(input.collaborators)}.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

export type ReleaseArticleInput = {
  primaryArtist: NodeRef | null;
  trackCount: number;
  totalDurationMs: number;
  yearMin: number | null;
  yearMax: number | null;
  sameArtistAlbums: NodeRef[];
  sameLabelAlbums: NodeRef[];
};

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function generateReleaseArticle(input: ReleaseArticleInput): string | null {
  const parts: string[] = [];

  let opening = input.primaryArtist ? `By ${link(input.primaryArtist)}` : "An album in your collection";
  if (input.yearMin != null) {
    opening += input.yearMax != null && input.yearMax !== input.yearMin ? `, ${input.yearMin}–${input.yearMax}` : `, ${input.yearMin}`;
  }
  parts.push(`${opening}.`);

  if (input.trackCount > 0) {
    parts.push(`${plural(input.trackCount, "track")}, ${formatDuration(input.totalDurationMs)} total.`);
  }
  if (input.sameArtistAlbums.length > 0) {
    parts.push(`Same artist as ${joinLinks(input.sameArtistAlbums)}.`);
  }
  if (input.sameLabelAlbums.length > 0) {
    parts.push(`Shares a label with ${joinLinks(input.sameLabelAlbums)}.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

export type LabelArticleInput = {
  recordings: NodeRef[];
  artistCount: number;
};

const MAX_LISTED_RECORDINGS = 8;

export function generateLabelArticle(input: LabelArticleInput): string | null {
  if (input.recordings.length === 0) return null;

  const listed = input.recordings.slice(0, MAX_LISTED_RECORDINGS);
  const remainder = input.recordings.length - listed.length;
  let sentence = `Released ${plural(input.recordings.length, "recording")} you own across ${plural(input.artistCount, "artist")}: ${joinListed(listed, remainder)}`;
  if (remainder > 0) sentence += `, and ${remainder} more`;
  return `${sentence}.`;
}

export type CreditArticleInput = {
  producedRecordings: NodeRef[];
  engineeredRecordings: NodeRef[];
};

export function generateCreditArticle(input: CreditArticleInput): string | null {
  const parts: string[] = [];

  if (input.producedRecordings.length > 0) {
    const listed = input.producedRecordings.slice(0, MAX_LISTED_RECORDINGS);
    const remainder = input.producedRecordings.length - listed.length;
    let sentence = `Produced ${plural(input.producedRecordings.length, "recording")} you own: ${joinListed(listed, remainder)}`;
    if (remainder > 0) sentence += `, and ${remainder} more`;
    parts.push(`${sentence}.`);
  }
  if (input.engineeredRecordings.length > 0) {
    const listed = input.engineeredRecordings.slice(0, MAX_LISTED_RECORDINGS);
    const remainder = input.engineeredRecordings.length - listed.length;
    let sentence = `Engineered ${plural(input.engineeredRecordings.length, "recording")} you own: ${joinListed(listed, remainder)}`;
    if (remainder > 0) sentence += `, and ${remainder} more`;
    parts.push(`${sentence}.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}
