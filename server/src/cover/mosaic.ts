import type { Database } from "../sqlite.js";

/* A collection's cover (#462): a 2×2 mosaic of up to four of its albums,
 * drawn by src/ui/Mosaic.tsx. A playlist's albums are its tracks' records;
 * the favourites' are their records, or the favourite itself when it is a
 * record, an artist or a producer. A track on no record stands for itself.
 *
 * Which four: the collection's albums ranked by a hash of (collection,
 * album), the first four. That's random-looking, the same on every device
 * and every reload, and changes only when the albums do: reordering or
 * adding another track from an album already there changes nothing.
 *
 * Which cell each sits in is kept (migration 0052), so when an album leaves
 * the four, whatever took its place takes its cell and the other three stay
 * put. An album joining the four (added, or next in rank after one left)
 * takes the cell of the one it displaced, or the first empty cell. A
 * collection with fewer than four albums leaves the rest empty.
 *
 * Everything that changes a collection's tracks saves the cells as part of
 * the change (routes/playlists.ts, playlist-import.ts, favourites.ts), so a
 * read normally only reads. A read writes when the albums changed some
 * other way (a scan deleted a track, a merge took an album's id away) or a
 * collection has no cells yet (one made before this), and only the cells
 * that changed. */

export const MOSAIC_CELLS = 4;

/** Four cells, each an album's node id or null for an empty cell. */
export type Mosaic = (number | null)[];

// FNV-1a over the key, then MurmurHash3's finaliser, so that keys differing
// in one digit land far apart.
function hash32(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The four albums a collection shows, by its stable ranking, best first. */
export function mosaicAlbums(collection: string, albums: Iterable<number>): number[] {
  return [...new Set(albums)]
    .map((id) => ({ id, rank: hash32(`${collection}:${id}`) }))
    .sort((a, b) => a.rank - b.rank || a.id - b.id)
    .slice(0, MOSAIC_CELLS)
    .map(({ id }) => id);
}

/** The cells for a collection's albums now, given the cells it had: every
 * album still among the four keeps its cell, and the newcomers fill the
 * cells left empty, in rank order. */
export function pickMosaic(collection: string, albums: Iterable<number>, previous: readonly (number | null)[]): Mosaic {
  const chosen = mosaicAlbums(collection, albums);
  const cells: Mosaic = Array.from({ length: MOSAIC_CELLS }, (_, i) => {
    const id = previous[i] ?? null;
    return id != null && chosen.includes(id) && previous.indexOf(id) === i ? id : null;
  });
  const newcomers = chosen.filter((id) => !cells.includes(id));
  for (let i = 0; i < MOSAIC_CELLS && newcomers.length > 0; i++) {
    if (cells[i] == null) cells[i] = newcomers.shift()!;
  }
  return cells;
}

const sameCells = (a: Mosaic, b: Mosaic) => a.every((id, i) => id === b[i]);

function asCells(rows: { cell: number; node_id: number }[]): Mosaic {
  const cells: Mosaic = Array.from({ length: MOSAIC_CELLS }, () => null);
  for (const row of rows) if (row.cell >= 0 && row.cell < MOSAIC_CELLS) cells[row.cell] = row.node_id;
  return cells;
}

// A track's record: its first appears_on, the one its cover comes from
// (cover/extract.ts' coverTargetNode). A track on none stands for itself.
const ALBUM_OF = (column: string) =>
  `COALESCE((SELECT e.to_node FROM edges e WHERE e.from_node = ${column} AND e.type = 'appears_on' ORDER BY e.id LIMIT 1), ${column})`;

const playlistKey = (id: number) => `playlist:${id}`;

/** Every playlist's mosaic, by playlist id. Saves the cells of any whose
 * albums changed since they were last saved. */
export function playlistMosaics(db: Database): Map<number, Mosaic> {
  return resolvePlaylists(db, null);
}

/** One playlist's mosaic. Saves its cells if its albums changed. */
export function playlistMosaic(db: Database, playlistId: number): Mosaic {
  return resolvePlaylists(db, playlistId).get(playlistId) ?? Array.from({ length: MOSAIC_CELLS }, () => null);
}

function resolvePlaylists(db: Database, only: number | null): Map<number, Mosaic> {
  const scoped = (column: string) => (only == null ? "" : `WHERE ${column} = ?`);
  const args = only == null ? [] : [only];
  const ids = db.prepare(`SELECT id FROM playlists ${scoped("id")}`).all(...args) as { id: number }[];
  const albums = new Map<number, number[]>(ids.map(({ id }) => [id, []]));
  const albumRows = db
    .prepare(
      `SELECT DISTINCT pt.playlist_id AS owner, ${ALBUM_OF("pt.node_id")} AS album
       FROM playlist_tracks pt ${scoped("pt.playlist_id")}`,
    )
    .all(...args) as { owner: number; album: number }[];
  for (const row of albumRows) albums.get(row.owner)?.push(row.album);
  const saved = new Map<number, { cell: number; node_id: number }[]>();
  const cellRows = db.prepare(`SELECT playlist_id, cell, node_id FROM playlist_mosaic_cells ${scoped("playlist_id")}`).all(...args) as {
    playlist_id: number;
    cell: number;
    node_id: number;
  }[];
  for (const row of cellRows) saved.set(row.playlist_id, [...(saved.get(row.playlist_id) ?? []), row]);

  const result = new Map<number, Mosaic>();
  const changed: [number, Mosaic][] = [];
  for (const [id, owned] of albums) {
    const previous = asCells(saved.get(id) ?? []);
    const cells = pickMosaic(playlistKey(id), owned, previous);
    result.set(id, cells);
    if (!sameCells(cells, previous)) changed.push([id, cells]);
  }
  if (changed.length > 0) {
    db.transaction(() => {
      const clear = db.prepare("DELETE FROM playlist_mosaic_cells WHERE playlist_id = ?");
      const insert = db.prepare("INSERT INTO playlist_mosaic_cells (playlist_id, cell, node_id) VALUES (?, ?, ?)");
      for (const [id, cells] of changed) {
        clear.run(id);
        cells.forEach((node, cell) => node != null && insert.run(id, cell, node));
      }
    })();
  }
  return result;
}

/** The favourites' mosaic. Saves its cells if the favourites' albums
 * changed. */
export function favouritesMosaic(db: Database): Mosaic {
  const albums = (
    db
      .prepare(
        `SELECT DISTINCT CASE WHEN n.type = 'recording' THEN ${ALBUM_OF("n.id")} ELSE n.id END AS album
         FROM favourites f JOIN nodes n ON n.id = f.node_id`,
      )
      .all() as { album: number }[]
  ).map((row) => row.album);
  const previous = asCells(db.prepare("SELECT cell, node_id FROM favourites_mosaic_cells").all() as { cell: number; node_id: number }[]);
  const cells = pickMosaic("favourites", albums, previous);
  if (!sameCells(cells, previous)) {
    db.transaction(() => {
      db.prepare("DELETE FROM favourites_mosaic_cells").run();
      const insert = db.prepare("INSERT INTO favourites_mosaic_cells (cell, node_id) VALUES (?, ?)");
      cells.forEach((node, cell) => node != null && insert.run(cell, node));
    })();
  }
  return cells;
}
