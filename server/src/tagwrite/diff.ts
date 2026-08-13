import { File as TagLibFile } from "node-taglib-sharp";
import { assertFlac, readFields, type TagFields } from "./fields.js";

export type FieldDiff = { field: keyof TagFields; oldValue: string | number; newValue: string | number };

// Dry-run only — opens the file read-only (node-taglib-sharp still needs
// to parse it to know current values, but nothing is written here) and
// returns only the fields that actually differ. An empty result is the
// mandatory no-op signal: the caller must not create a tag_writes row for
// a diff with nothing in it, matching Picard's ~21%-of-library bar rather
// than writing (and touching mtimes) for files that are already correct.
export function computeDiff(filePath: string, changes: TagFields): FieldDiff[] {
  assertFlac(filePath);

  const file = TagLibFile.createFromPath(filePath);
  try {
    const current = readFields(file.tag);
    const diffs: FieldDiff[] = [];

    for (const key of Object.keys(changes) as (keyof TagFields)[]) {
      const newValue = changes[key];
      if (newValue === undefined) continue;
      const oldValue = current[key];
      if (String(oldValue) !== String(newValue)) {
        diffs.push({ field: key, oldValue, newValue });
      }
    }

    return diffs;
  } finally {
    file.dispose();
  }
}
