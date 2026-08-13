import { homedir } from "node:os";
import path from "node:path";

// LEGATO_DATA_DIR is set by the Tauri shell to its per-OS app-data directory
// (src-tauri's setup hook, via app.path().app_data_dir()). The fallback below
// only matters when the server is run standalone (`npm run dev`/`start`
// outside Tauri) — real cross-platform default resolution is Tauri's job,
// not this server's, per Legato's platform split.
export const DATA_DIR = path.resolve(
  process.env.LEGATO_DATA_DIR ?? path.join(homedir(), ".local", "share", "legato"),
);

export const PORT = Number(process.env.LEGATO_PORT ?? 8899);
