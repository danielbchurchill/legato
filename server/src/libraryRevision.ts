import { broadcast } from "./ws.js";

// #302: what the Library header and its Artists tab read (GET /stats, GET
// /library/artists) changes when a recompute rewrites the albums table, and
// when a merge moves files from one recording to another. Each of those
// bumps this number and sends it as `library:changed`, and the Library view
// fetches again only on that event.
//
// It used to follow scan:done, enrich:applied and hygiene:changed. The
// enrichment worker sends the last two once per job, and none of its jobs
// rewrites the albums table, so an open Library view fetched /stats and the
// first page of artists every 2-3 s for as long as a drain lasted.
//
// It counts from the time the server started, in ms, so a revision from
// before a restart is never sent again. GET /library/artists keeps its
// sorted list for one revision (routes/library.ts).
let revision = Date.now();

export function libraryRevision(): number {
  return revision;
}

export function libraryChanged(): void {
  revision += 1;
  broadcast("library:changed", { revision });
}
