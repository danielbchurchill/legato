import type { FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { healthRoutes } from "./health.js";
import { settingsRoutes } from "./settings.js";
import { libraryRootsRoutes } from "./library-roots.js";
import { scanRoutes } from "./scan.js";
import { nodesRoutes } from "./nodes.js";
import { libraryRoutes } from "./library.js";
import { mergeOverridesRoutes } from "./merge-overrides.js";
import { favouritesRoutes } from "./favourites.js";
import { playlistsRoutes } from "./playlists.js";
import { playlistImportRoutes } from "./playlist-import.js";
import { layoutRoutes } from "./layout.js";
import { edgesRoutes } from "./edges.js";
import { searchRoutes } from "./search.js";
import { wsRoutes } from "./ws.js";
import { enrichRoutes } from "./enrich.js";
import { filesRoutes } from "./files.js";
import { queueRoutes } from "./queue.js";
import { hygieneRoutes } from "./hygiene.js";
import { tagWritesRoutes } from "./tag-writes.js";
import { coverRoutes } from "./cover.js";
import { playsRoutes } from "./plays.js";
import { statsRoutes } from "./stats.js";
import { dbInspectorRoutes } from "./db-inspector.js";
import { similarityRoutes } from "./similarity.js";
import { waveformRoutes } from "./waveform.js";
import { lyricsRoutes } from "./lyrics.js";
import { tagManagerRoutes } from "./tag-manager.js";
import { authRoutes } from "./auth.js";

// Every API route plugin, in one list (issue #112). Lives outside index.ts
// so auth/gate.spec.ts can build the real route table — not a copy of it —
// and prove each route rejects a request with no credentials. A plugin
// added here is covered by that test without touching it.
export async function registerRoutes(app: FastifyInstance, db: Database): Promise<void> {
  await app.register(healthRoutes(db), { prefix: "/api/v1" });
  await app.register(settingsRoutes(db), { prefix: "/api/v1" });
  await app.register(libraryRootsRoutes(db), { prefix: "/api/v1" });
  await app.register(scanRoutes(db), { prefix: "/api/v1" });
  await app.register(nodesRoutes(db), { prefix: "/api/v1" });
  await app.register(libraryRoutes(db), { prefix: "/api/v1" });
  await app.register(mergeOverridesRoutes(db), { prefix: "/api/v1" });
  await app.register(favouritesRoutes(db), { prefix: "/api/v1" });
  await app.register(playlistsRoutes(db), { prefix: "/api/v1" });
  await app.register(playlistImportRoutes(db), { prefix: "/api/v1" });
  await app.register(layoutRoutes(db), { prefix: "/api/v1" });
  await app.register(edgesRoutes(db), { prefix: "/api/v1" });
  await app.register(searchRoutes(db), { prefix: "/api/v1" });
  await app.register(wsRoutes(), { prefix: "/api/v1" });
  await app.register(enrichRoutes(db), { prefix: "/api/v1" });
  await app.register(filesRoutes(db), { prefix: "/api/v1" });
  await app.register(queueRoutes(db), { prefix: "/api/v1" });
  await app.register(hygieneRoutes(db), { prefix: "/api/v1" });
  await app.register(tagWritesRoutes(db), { prefix: "/api/v1" });
  await app.register(coverRoutes(db), { prefix: "/api/v1" });
  await app.register(playsRoutes(db), { prefix: "/api/v1" });
  await app.register(statsRoutes(db), { prefix: "/api/v1" });
  await app.register(dbInspectorRoutes(db), { prefix: "/api/v1" });
  await app.register(similarityRoutes(db), { prefix: "/api/v1" });
  await app.register(waveformRoutes(db), { prefix: "/api/v1" });
  await app.register(lyricsRoutes(db), { prefix: "/api/v1" });
  await app.register(tagManagerRoutes(db), { prefix: "/api/v1" });
  await app.register(authRoutes(db), { prefix: "/api/v1" });
}
