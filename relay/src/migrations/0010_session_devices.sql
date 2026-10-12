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
--
-- public_id is what the list calls a session, and what signing one out
-- names: random, so it says nothing about how many sign-ins there have
-- been, and never names a later session the way a reused rowid would. The
-- id column is the session's token, so it can't be that. Sessions from
-- before this get one here.
ALTER TABLE relay_sessions ADD COLUMN client TEXT;
ALTER TABLE relay_sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE relay_sessions ADD COLUMN public_id TEXT;
UPDATE relay_sessions SET public_id = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX relay_sessions_public_id_idx ON relay_sessions (public_id);
