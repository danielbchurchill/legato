/* Which of a recording's files plays, when a merge has given it more than
 * one: the highest bitrate among those on disk, and between equal (or
 * unknown) bitrates the one Legato found first. POST /queue/resolve picks
 * by it for every player, native and streamed, and Library health's
 * duplicates card says which file a merge would play by it (#469), so the
 * card can't promise one thing while playback does another.
 *
 * Bitrate stands in for quality: a lossless file's is several times a lossy
 * one's, and a 24-bit or high-sample-rate file's is higher again. An ORDER
 * BY over `files`, for a query that has already left out missing files.
 * SQLite sorts NULL lowest, so DESC puts a file with no bitrate last. */
export const PLAYBACK_FILE_ORDER = "bitrate DESC, id ASC";
