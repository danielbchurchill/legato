// Pre-match check for tags that won't search well before spending a rate-
// limited MusicBrainz request on them. Real finding this targets directly:
// a library had ALBUM tags reading "Vol 1 - Past Masters" instead of
// "Past Masters, Vol. 1" — reversed word order from a different ripping
// tool than the rest of the library — which silently defeated text search
// outright (zero matches, no error, just nothing found) until hand-fixed.
// Catching the shape up front means it surfaces as an actionable flag
// instead of a quiet "no_match" indistinguishable from a genuinely obscure
// recording.
const REVERSED_VOLUME_PREFIX = /^(vol\.?\s*\d+|disc\s*\d+|cd\s*\d+)\s*[-:]\s*.+/i;
const MANGLED_ENCODING = /�|_{2,}/;

export function looksSuspicious(title: string | null | undefined): boolean {
  if (!title || !title.trim()) return true;
  return REVERSED_VOLUME_PREFIX.test(title) || MANGLED_ENCODING.test(title);
}
