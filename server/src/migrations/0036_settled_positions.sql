-- #274: where each node came to rest the last time the map's physics
-- settled, saved by the client so the next visit opens on the same layout
-- instead of re-settling from seeds. Null until the first settle after this
-- migration writes it; layout/seed.ts's routine recompute never touches it,
-- and only rebuildLayout ("rebuild map") clears it.
ALTER TABLE positions ADD COLUMN settled_x REAL;
ALTER TABLE positions ADD COLUMN settled_y REAL;
