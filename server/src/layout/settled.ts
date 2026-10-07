import type { Database } from "../sqlite.js";

export type SettledPosition = { id: number; x: number; y: number };

// #274: the map's physics runs in the client, so the client reports where
// nodes came to rest each time it settles, and GET /nodes hands those spots
// back on the next visit. Only nodes that moved arrive here, in one batch
// per settle.
//
// A node the user dragged has user_x/user_y, which the client reads first.
// Since #46 a drop is a starting point, not a pin, so a dragged node keeps
// drifting after the drop. Its user_x/user_y moves to where it came to rest
// too; otherwise it would reopen at the drop point rather than where it was
// left. A node that was never dragged keeps a null user_x/user_y.
export function saveSettledPositions(db: Database, positions: SettledPosition[]): number {
  const update = db.prepare(
    `UPDATE positions SET settled_x = ?, settled_y = ?,
       user_x = CASE WHEN user_x IS NULL THEN NULL ELSE ? END,
       user_y = CASE WHEN user_y IS NULL THEN NULL ELSE ? END
     WHERE node_id = ? AND granularity = 'tracks'`,
  );
  let saved = 0;
  const applyAll = db.transaction(() => {
    for (const p of positions) saved += update.run(p.x, p.y, p.x, p.y, p.id).changes;
  });
  applyAll();
  return saved;
}

export function isSettledPositionList(value: unknown): value is SettledPosition[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        p != null && typeof p === "object" && Number.isInteger(p.id) && Number.isFinite(p.x) && Number.isFinite(p.y),
    )
  );
}
