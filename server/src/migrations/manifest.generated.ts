// GENERATED FILE — do not edit by hand.
// Regenerate with `npm --prefix server run generate:migrations` after
// touching server/src/migrations/*.sql — see
// server/scripts/generate-migrations-manifest.mjs for why this exists.

import m0001_init from "./0001_init.sql" with { type: "text" };
import m0002_scan from "./0002_scan.sql" with { type: "text" };
import m0003_graph from "./0003_graph.sql" with { type: "text" };
import m0004_positions from "./0004_positions.sql" with { type: "text" };
import m0005_articles from "./0005_articles.sql" with { type: "text" };
import m0006_search from "./0006_search.sql" with { type: "text" };
import m0007_enrich from "./0007_enrich.sql" with { type: "text" };
import m0008_field_provenance_note from "./0008_field_provenance_note.sql" with { type: "text" };
import m0009_tag_writes from "./0009_tag_writes.sql" with { type: "text" };
import m0010_cover_art from "./0010_cover_art.sql" with { type: "text" };
import m0011_tag_columns from "./0011_tag_columns.sql" with { type: "text" };
import m0012_entities from "./0012_entities.sql" with { type: "text" };
import m0013_plays from "./0013_plays.sql" with { type: "text" };
import m0014_cover_art_archive from "./0014_cover_art_archive.sql" with { type: "text" };
import m0015_position_granularity from "./0015_position_granularity.sql" with { type: "text" };
import m0016_similarity from "./0016_similarity.sql" with { type: "text" };
import m0017_lyrics from "./0017_lyrics.sql" with { type: "text" };
import m0018_match_candidates from "./0018_match_candidates.sql" with { type: "text" };
import m0019_artist_images_descriptions from "./0019_artist_images_descriptions.sql" with { type: "text" };
import m0020_favourites from "./0020_favourites.sql" with { type: "text" };
import m0021_users from "./0021_users.sql" with { type: "text" };
import m0022_playlists from "./0022_playlists.sql" with { type: "text" };
import m0023_scan_mode from "./0023_scan_mode.sql" with { type: "text" };
import m0024_artist_member_jobs from "./0024_artist_member_jobs.sql" with { type: "text" };
import m0025_playlist_imports from "./0025_playlist_imports.sql" with { type: "text" };
import m0026_watch_status from "./0026_watch_status.sql" with { type: "text" };
import m0027_scan_stages from "./0027_scan_stages.sql" with { type: "text" };
import m0028_fuzzy_match_index from "./0028_fuzzy_match_index.sql" with { type: "text" };
import m0029_local_owner from "./0029_local_owner.sql" with { type: "text" };
import m0030_nodes_title_lookup_index from "./0030_nodes_title_lookup_index.sql" with { type: "text" };
import m0032_legato_identity from "./0032_legato_identity.sql" with { type: "text" };

export interface MigrationFile {
  version: number;
  file: string;
  sql: string;
}

export const MIGRATIONS: MigrationFile[] = [
  { version: 1, file: "0001_init.sql", sql: m0001_init },
  { version: 2, file: "0002_scan.sql", sql: m0002_scan },
  { version: 3, file: "0003_graph.sql", sql: m0003_graph },
  { version: 4, file: "0004_positions.sql", sql: m0004_positions },
  { version: 5, file: "0005_articles.sql", sql: m0005_articles },
  { version: 6, file: "0006_search.sql", sql: m0006_search },
  { version: 7, file: "0007_enrich.sql", sql: m0007_enrich },
  { version: 8, file: "0008_field_provenance_note.sql", sql: m0008_field_provenance_note },
  { version: 9, file: "0009_tag_writes.sql", sql: m0009_tag_writes },
  { version: 10, file: "0010_cover_art.sql", sql: m0010_cover_art },
  { version: 11, file: "0011_tag_columns.sql", sql: m0011_tag_columns },
  { version: 12, file: "0012_entities.sql", sql: m0012_entities },
  { version: 13, file: "0013_plays.sql", sql: m0013_plays },
  { version: 14, file: "0014_cover_art_archive.sql", sql: m0014_cover_art_archive },
  { version: 15, file: "0015_position_granularity.sql", sql: m0015_position_granularity },
  { version: 16, file: "0016_similarity.sql", sql: m0016_similarity },
  { version: 17, file: "0017_lyrics.sql", sql: m0017_lyrics },
  { version: 18, file: "0018_match_candidates.sql", sql: m0018_match_candidates },
  { version: 19, file: "0019_artist_images_descriptions.sql", sql: m0019_artist_images_descriptions },
  { version: 20, file: "0020_favourites.sql", sql: m0020_favourites },
  { version: 21, file: "0021_users.sql", sql: m0021_users },
  { version: 22, file: "0022_playlists.sql", sql: m0022_playlists },
  { version: 23, file: "0023_scan_mode.sql", sql: m0023_scan_mode },
  { version: 24, file: "0024_artist_member_jobs.sql", sql: m0024_artist_member_jobs },
  { version: 25, file: "0025_playlist_imports.sql", sql: m0025_playlist_imports },
  { version: 26, file: "0026_watch_status.sql", sql: m0026_watch_status },
  { version: 27, file: "0027_scan_stages.sql", sql: m0027_scan_stages },
  { version: 28, file: "0028_fuzzy_match_index.sql", sql: m0028_fuzzy_match_index },
  { version: 29, file: "0029_local_owner.sql", sql: m0029_local_owner },
  { version: 30, file: "0030_nodes_title_lookup_index.sql", sql: m0030_nodes_title_lookup_index },
  { version: 32, file: "0032_legato_identity.sql", sql: m0032_legato_identity },
];
