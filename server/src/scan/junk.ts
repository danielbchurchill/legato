// Filesystem junk that should never be walked, watched, or imported as
// audio: NAS thumbnail/recycle directories (Synology, QNAP), OS trash and
// index folders, and macOS's AppleDouble shadow files. One list — the
// walker (fast-glob, walk.ts) and the watcher (chokidar, watcher.ts) each
// need this translated into a different matcher language, and keeping two
// hand-written lists is exactly how one drifts from the other (issue #99).
//
// A trailing "*" means "starts with" (everything before it is a literal
// prefix, matched against one whole path segment); anything else is an
// exact segment match.
const JUNK_PATTERNS = [
  "lost+found", // ext4/ext3 root-only recovery directory
  ".Trash-*", // Linux desktop trash, one per uid ("`.Trash-1000`")
  "System Volume Information", // Windows/NTFS index
  "@eaDir", // Synology thumbnail cache, dropped into every media folder
  "#recycle", // Synology recycle bin
  "#snapshot", // Synology/QNAP/NetApp snapshot directory
  ".@__thumb", // QNAP thumbnail cache
  ".DS_Store", // macOS Finder metadata file
  "._*", // macOS AppleDouble resource-fork shadow files
] as const;

function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// fast-glob ignore patterns for walk.ts's `ignore` option. Each entry
// becomes two globs: one that prunes it as a directory subtree, one that
// matches it as a bare file — cheaper than classifying which of the two
// every pattern actually is, and a directory-shaped glob simply never
// matches a file (and vice versa), so the extra pattern is free.
export const FAST_GLOB_IGNORE: string[] = JUNK_PATTERNS.flatMap((pattern) => [
  `**/${pattern}/**`,
  `**/${pattern}`,
]);

// chokidar `ignored` patterns for watcher.ts. One regex per entry,
// matching the literal (or prefix-wildcarded) name as a whole path
// segment anywhere under the watched root.
export const CHOKIDAR_IGNORED: RegExp[] = JUNK_PATTERNS.map((pattern) => {
  const isPrefix = pattern.endsWith("*");
  const literal = isPrefix ? pattern.slice(0, -1) : pattern;
  const escaped = escapeRegExp(literal);
  const body = isPrefix ? `${escaped}[^/\\\\]*` : escaped;
  return new RegExp(`(^|[/\\\\])${body}($|[/\\\\])`);
});
