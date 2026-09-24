import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";

type SettingRow = { key: string; value: string };

function allSettings(db: Database) {
  const rows = db.prepare("SELECT key, value FROM settings").all() as SettingRow[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function settingsRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/settings", async () => allSettings(db));

    app.put<{ Body: Record<string, string> }>("/settings", async (request) => {
      const upsert = db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      const applyAll = db.transaction((entries: [string, string][]) => {
        for (const [key, value] of entries) upsert.run(key, value);
      });
      applyAll(Object.entries(request.body));
      return allSettings(db);
    });
  };
}
