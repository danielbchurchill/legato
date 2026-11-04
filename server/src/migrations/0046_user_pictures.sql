-- Issue #470: a picture for each user, beside the name they can now change
-- (display_name was already here; only the route that changes it is new).
--
-- Two pictures can stand behind one user, and the uploaded one wins:
--   * avatar_upload_hash: a picture the user uploaded in the Account panel.
--     It stays on this server and is never sent to legato.fm.
--   * avatar_remote_hash: this server's copy of avatar_url, the Google or
--     GitHub picture legato.fm sends for a linked user. Devices never load
--     avatar_url themselves; the server fetches it and serves its copy.
--     avatar_remote_url is the address that copy came from, so a new
--     address is noticed and an unchanged one is never fetched again.
--
-- Each hash names a file under <data dir>/avatars/ (account/pictures.ts).
-- Every row starts with none, so there's nothing to bring forward: a linked
-- user's picture arrives with the next token legato.fm signs for them.
ALTER TABLE users ADD COLUMN avatar_upload_hash TEXT;
ALTER TABLE users ADD COLUMN avatar_remote_hash TEXT;
ALTER TABLE users ADD COLUMN avatar_remote_url TEXT;
