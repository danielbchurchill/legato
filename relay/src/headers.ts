// Headers that describe the transport of a specific hop rather than the
// message content — stripped whenever headers cross from one hop of the
// proxy to the next (mobile client -> relay -> tunnel, and home server ->
// tunnel -> relay -> mobile client). Forwarding them verbatim would either
// be meaningless on the next hop (`host`, `connection`) or actively wrong
// once the byte layout changes underneath them (`content-length`,
// `transfer-encoding` — this relay frames every body itself; a response's
// plain Content-Length is the one exception, kept and held to by
// tunnel-registry.ts).
export const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}
