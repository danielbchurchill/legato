-- Issue #122: once a library root's chokidar watcher is exhausted (Linux's
-- fs.inotify.max_user_watches is per-user and Synology ships a low stock
-- default), new files stop appearing with no error anywhere else in the
-- app — the scan that added them already finished cleanly, and nothing
-- about scan_jobs or scan:progress/scan:error was ever wrong. The failure
-- lives entirely in the watcher, so it gets its own field on the row the
-- watcher already belongs to (library_roots), independent of #123's scan
-- job/status work landing in parallel.
--
-- watch_status: 'watching' is the normal state a fresh FSWatcher starts in
-- (see scan/watcher.ts's watchLibraryRoot). 'fallback' means chokidar
-- either hit ENOSPC/EMFILE or the watched-directory count closed in on
-- max_user_watches first — either way, watcher.ts has fallen back to a
-- periodic incremental rescan for that root and closed the chokidar
-- watcher itself so it can't error again into the same fallback.
--
-- watch_fallback_reason distinguishes which of the two triggered it, for
-- logs and tests; NULL whenever watch_status is 'watching'.
ALTER TABLE library_roots ADD COLUMN watch_status TEXT NOT NULL DEFAULT 'watching'
  CHECK (watch_status IN ('watching', 'fallback'));
ALTER TABLE library_roots ADD COLUMN watch_fallback_reason TEXT
  CHECK (watch_fallback_reason IN ('enospc', 'emfile', 'near_limit'));
