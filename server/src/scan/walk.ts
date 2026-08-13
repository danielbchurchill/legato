import path from "node:path";
import fg from "fast-glob";

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".ogg", ".wav", ".ape"]);

export async function walkLibraryRoot(root: string): Promise<string[]> {
  const entries = await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    absolute: true,
    followSymbolicLinks: true,
    suppressErrors: true,
    // Same filesystem-junk exclusions as the chokidar watcher (see
    // scan/watcher.ts) — no reason to walk into ext4's root-only
    // lost+found, trash folders, or OS index directories.
    ignore: ["**/lost+found/**", "**/.Trash-*/**", "**/System Volume Information/**"],
  });
  return entries.filter((p) => AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase()));
}

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
