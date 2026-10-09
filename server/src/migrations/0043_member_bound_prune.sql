-- Issue #321: the startup membership prune (enrich/members.ts) runs before
-- the server listens, and reading the bound takes seconds on a large
-- library, so it only runs when it may have something to do. This row says
-- when that is.
--
-- bound_hash is a hash of the SQL the last prune read the bound with
-- (enrich/queue.ts's BOUND_SQL). NULL means no prune has run here yet. A
-- build whose bound reads differently prunes again on its first start.
--
-- bound_may_have_shrunk is set by whatever removes an edge the bound is read
-- through: a re-derive that drops a person edge from a recording, a member
-- lookup that drops a member_of pair, or deleting a manual edge that
-- touches an artist. The next start prunes and clears it.
--
-- Not in `settings` on purpose, like server_identity (0032): PUT /settings
-- writes whatever key it's sent and GET /settings returns them all, so any
-- signed-in client could skip a pending prune, or make every start slow.
CREATE TABLE member_bound_prune (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bound_hash TEXT,
  bound_may_have_shrunk INTEGER NOT NULL DEFAULT 0
);

INSERT INTO member_bound_prune (id) VALUES (1);
