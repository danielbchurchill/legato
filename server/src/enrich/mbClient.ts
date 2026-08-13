// Required by MusicBrainz's API usage policy: a real UA identifying the
// application plus contact info, not a browser-spoofed or generic string.
const USER_AGENT = "Legato/0.1.0 (hello@legato.fm)";
const API_ROOT = "https://musicbrainz.org/ws/2";

// MusicBrainz rate-limits by IP at roughly 1 req/sec — this throttle is
// process-global (module-level, not per-call) since every enrichment
// request in this server shares the same limit regardless of which job
// triggered it.
const MIN_INTERVAL_MS = 1100;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export type MbRecordingCandidate = {
  mbid: string;
  score: number;
  title: string;
  artist: string | null;
  durationMs: number | null;
};

function escapeLucene(value: string): string {
  // MusicBrainz search queries are Lucene syntax — escape characters that
  // would otherwise break the query or let user-derived tag text (not
  // actually untrusted here, but still arbitrary strings) act as syntax.
  return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
}

export async function searchRecording(artist: string, title: string): Promise<MbRecordingCandidate[]> {
  await throttle();

  const query = `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(artist)}"`;
  const url = `${API_ROOT}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=15`;

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`MusicBrainz search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    recordings?: {
      id: string;
      score: number;
      title: string;
      length?: number | null;
      "artist-credit"?: { name: string }[];
    }[];
  };

  return (data.recordings ?? []).map((r) => ({
    mbid: r.id,
    score: r.score,
    title: r.title,
    artist: r["artist-credit"]?.[0]?.name ?? null,
    durationMs: r.length ?? null,
  }));
}
