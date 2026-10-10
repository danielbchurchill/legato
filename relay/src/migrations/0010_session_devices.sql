-- Issue #115: an account's sessions, listed in its settings so it can tell
-- them apart and sign any of them out.
--
-- client is what signed in, worked out once from the User-Agent at sign-in
-- (accounts.ts, describeClient): "Legato app on macOS", "Firefox on Linux".
-- Only that label is kept, never the User-Agent itself. NULL for a session
-- from before this.
--
-- last_seen_at is when the session was last used, written at most every
-- few minutes rather than on every request. NULL until it's first used
-- after this.
ALTER TABLE relay_sessions ADD COLUMN client TEXT;
ALTER TABLE relay_sessions ADD COLUMN last_seen_at TEXT;
