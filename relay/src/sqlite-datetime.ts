// SQLite's datetime('now') returns space-separated strings
// ("2026-09-03 20:21:10"), not ISO 8601 ("2026-09-03T20:21:10.000Z"). The
// two formats compare correctly as strings on the date portion, but NOT
// on the time portion within the same calendar day — ' ' (0x20) sorts
// before 'T' (0x54), so *any* same-day ISO-formatted timestamp compares
// as greater than a same-day datetime('now') string, regardless of the
// actual clock time. That's invisible for something like a 30-day
// session TTL (it only bites on the literal expiry day), but it would
// silently break every check for a short-lived value like a 10-minute
// pairing code — an "expired" code would still read as valid until
// midnight. Every expiring row in this package is therefore written
// using SQL-relative datetime math (`datetime('now', '+10 minutes')`)
// rather than a JS-computed toISOString() string, so the stored value
// and the comparison value are always the same format. This helper turns
// a stored value back into a JS Date for API responses, where it's
// display-only — the SQL comparison, not this parse, is what's
// authoritative for expiry.
export function parseSqliteDatetime(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}
