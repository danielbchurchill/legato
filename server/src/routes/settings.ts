import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { broadcast } from "../ws.js";

type SettingRow = { key: string; value: string };

function allSettings(db: Database) {
  const rows = db.prepare("SELECT key, value FROM settings").all() as SettingRow[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/* #467: a write tells every connected client what it changed, so a phone
 * moving a map option shows on a desktop open on the same library without
 * a reload, and the other way round. `from` is the writing page's own id
 * (`?from=`, a query parameter rather than a header so legato.fm's tunnel
 * and CORS pass it untouched), which lets that page skip its own echo. An
 * id that isn't a short run of letters and digits is left out. */
const CLIENT_ID = /^[a-z0-9]{1,64}$/i;

export function settingsRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/settings", async () => allSettings(db));

    app.put<{ Body: Record<string, string>; Querystring: { from?: string } }>("/settings", async (request) => {
      const upsert = db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      const applyAll = db.transaction((entries: [string, string][]) => {
        for (const [key, value] of entries) upsert.run(key, value);
      });
      const entries = Object.entries(request.body);
      applyAll(entries);
      const from = typeof request.query.from === "string" && CLIENT_ID.test(request.query.from) ? request.query.from : undefined;
      if (entries.length > 0) broadcast("settings:changed", { changed: Object.fromEntries(entries), from });
      return allSettings(db);
    });
  };
}
