import path from "node:path";
import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { computeDiff, type FieldDiff } from "../tagwrite/diff.js";
import { applyTagWrite, revertTagWrite } from "../tagwrite/writer.js";
import type { TagFields } from "../tagwrite/fields.js";
import { filesForNode, planNodeEdit, validateChanges } from "../tagwrite/nodeEdit.js";
import { applyNodeEdit, identitiesAfter, mergeTarget, undoNodeEdit, type TagEditRow } from "../tagwrite/rename.js";
import { filesLinkedTo, refreshAfterWrite } from "../tagwrite/refresh.js";
import { broadcast } from "../ws.js";

type FileRow = { id: number; file_path: string };
type NodeRow = { id: number; type: string; title: string };
type TagWriteRow = { id: number; file_id: number; status: string; diff_json: string; edit_id: number | null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The format words the review names files by ("12 FLAC files").
function formatWord(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toUpperCase();
  return ext === "MP4" ? "M4A" : ext;
}

type ScannedTags = {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumartist?: string | null;
  releaseDate?: string | null;
  trackNo?: number | null;
  discNo?: number | null;
  genre?: string[] | null;
  bpm?: number | null;
  label?: string | null;
  releaseType?: string | null;
};

// What the edit form starts from, per field: what most of the files say, as
// the last scan read them (and, since #464, as the last write left them).
function formValues(node: NodeRow, tags: ScannedTags[]): Record<string, string> {
  const common = (pick: (t: ScannedTags) => unknown): string => {
    const counts = new Map<string, number>();
    for (const t of tags) {
      const raw = pick(t);
      const value = Array.isArray(raw) ? raw.join("; ") : raw == null ? "" : String(raw);
      if (value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best = "";
    for (const [value, count] of counts) if (best === "" || count > counts.get(best)!) best = value;
    return best;
  };
  if (node.type === "artist") return { name: node.title };
  const shared = {
    albumArtist: common((t) => t.albumartist),
    releaseDate: common((t) => t.releaseDate),
    genre: common((t) => t.genre),
    label: common((t) => t.label),
    releaseType: common((t) => t.releaseType),
  };
  if (node.type === "release") return { album: node.title, ...shared };
  return {
    title: node.title,
    artist: common((t) => t.artist),
    album: common((t) => t.album),
    trackNo: common((t) => t.trackNo),
    discNo: common((t) => t.discNo),
    bpm: common((t) => t.bpm),
    ...shared,
  };
}

export function tagWritesRoutes(db: Database) {
  const getWrite = (id: number | string) =>
    db.prepare("SELECT * FROM tag_writes WHERE id = ?").get(id) as TagWriteRow | undefined;
  const getEdit = (id: number | string | null) =>
    id == null ? undefined : (db.prepare("SELECT * FROM tag_edits WHERE id = ?").get(id) as TagEditRow | undefined);
  const editWrites = (editId: number, status: string) =>
    db.prepare("SELECT * FROM tag_writes WHERE edit_id = ? AND status = ? ORDER BY id").all(editId, status) as TagWriteRow[];
  const fileOf = (fileId: number) => db.prepare("SELECT id, file_path FROM files WHERE id = ?").get(fileId) as FileRow;

  // An edit whose writes have all been discarded has nothing left to group.
  const forgetEditIfEmpty = (editId: number | null) => {
    if (editId == null) return;
    const left = db.prepare("SELECT 1 FROM tag_writes WHERE edit_id = ? LIMIT 1").get(editId);
    if (!left) db.prepare("DELETE FROM tag_edits WHERE id = ?").run(editId);
  };

  // Writes one reviewed row to its file. A failure is recorded on the row,
  // which is how Library health shows it.
  const writeRow = async (row: TagWriteRow): Promise<{ ok: true } | { ok: false; error: string }> => {
    const file = fileOf(row.file_id);
    const diff = JSON.parse(row.diff_json) as FieldDiff[];
    const changes = Object.fromEntries(diff.map((d) => [d.field, d.newValue])) as TagFields;
    try {
      const { writeId, writtenMtime } = await applyTagWrite(file.file_path, changes);
      db.prepare("UPDATE files SET app_write_marker = ?, last_written_mtime = ? WHERE id = ?").run(writeId, writtenMtime, file.id);
      db.prepare("UPDATE tag_writes SET status = 'written', written_at = datetime('now') WHERE id = ?").run(row.id);
      return { ok: true };
    } catch (err) {
      db.prepare("UPDATE tag_writes SET status = 'failed', error_message = ? WHERE id = ?").run(message(err), row.id);
      return { ok: false, error: message(err) };
    }
  };

  return async function routes(app: FastifyInstance) {
    app.get("/tag-writes", async () => db.prepare("SELECT * FROM tag_writes ORDER BY id DESC LIMIT 100").all());

    app.get<{ Params: { id: string } }>("/tag-writes/:id", async (request, reply) => {
      const row = getWrite(request.params.id);
      if (!row) {
        reply.code(404);
        return { error: "not found" };
      }
      return row;
    });

    // Issue #464: what the details panel's edit form starts from.
    app.get<{ Params: { nodeId: string } }>("/tag-writes/node/:nodeId", async (request, reply) => {
      const node = db.prepare("SELECT id, type, title FROM nodes WHERE id = ?").get(request.params.nodeId) as NodeRow | undefined;
      if (!node) {
        reply.code(404);
        return { error: "node not found" };
      }
      const files = node.type === "artist" ? [] : filesForNode(db, node).filter((f) => !f.missing_since);
      const tags = files.map((f) => {
        try {
          return (f.tags_raw ? JSON.parse(f.tags_raw) : {}) as ScannedTags;
        } catch {
          return {};
        }
      });
      return { type: node.type, values: formValues(node, tags) };
    });

    // Dry-run only — computes the diff and stores it for review. Mandatory
    // no-op check: a diff with nothing in it (on-disk already matches)
    // never becomes a tag_writes row at all.
    //
    // Issue #464: `{ nodeId, changes }` reviews an edit to a whole track,
    // album or artist (tagwrite/nodeEdit.ts): one row per file that
    // differs, grouped under a tag_edits row, plus the files left out and
    // why, and the node a rename would merge into. `{ fileId, changes }`
    // still reviews one file, as Library health's gap fixes do.
    app.post<{ Body: { fileId?: number; nodeId?: number; changes: unknown } }>("/tag-writes", async (request, reply) => {
      if (request.body?.nodeId != null) {
        const node = db.prepare("SELECT id, type, title FROM nodes WHERE id = ?").get(request.body.nodeId) as NodeRow | undefined;
        if (!node) {
          reply.code(404);
          return { error: "node not found" };
        }
        const checked = validateChanges(node.type, request.body.changes);
        if ("error" in checked) {
          reply.code(400);
          return { error: checked.error };
        }

        const plan = planNodeEdit(db, node, checked.changes);
        const skipped = plan.skipped.map(({ fileId, path, reason }) => ({ fileId, path, reason }));
        if (plan.writes.length === 0) return { noop: true, editId: null, writeIds: [], fileCount: 0, formats: [], skipped, merge: null };

        // Asked the way approving will ask it (tagwrite/rename.ts), of the
        // identities the written files will have, so the review says what
        // approving does.
        const rename = plan.rename;
        const target = rename ? mergeTarget(db, node, rename.newTitle, identitiesAfter(plan.writes)) : null;
        const { editId, writeIds } = db.transaction(() => {
          const edit = db
            .prepare("INSERT INTO tag_edits (node_id, old_title, new_title) VALUES (?, ?, ?) RETURNING id")
            .get(node.id, rename?.oldTitle ?? null, rename?.newTitle ?? null) as { id: number };
          const insert = db.prepare(
            "INSERT INTO tag_writes (file_id, status, diff_json, edit_id) VALUES (?, 'pending_review', ?, ?) RETURNING id",
          );
          const ids = plan.writes.map((w) => (insert.get(w.fileId, JSON.stringify(w.diff), edit.id) as { id: number }).id);
          return { editId: edit.id, writeIds: ids };
        })();

        return {
          noop: false,
          editId,
          writeIds,
          fileCount: writeIds.length,
          formats: [...new Set(plan.writes.map((w) => formatWord(w.filePath)))],
          skipped,
          merge: target ? { id: target.id, title: target.title } : null,
        };
      }

      const file = db.prepare("SELECT id, file_path FROM files WHERE id = ?").get(request.body?.fileId ?? null) as FileRow | undefined;
      if (!file) {
        reply.code(404);
        return { error: "file not found" };
      }

      let diff: FieldDiff[];
      try {
        diff = computeDiff(file.file_path, request.body.changes as TagFields);
      } catch (err) {
        reply.code(400);
        return { error: message(err) };
      }

      if (diff.length === 0) {
        return { noop: true, diff: [] };
      }

      return db
        .prepare("INSERT INTO tag_writes (file_id, status, diff_json) VALUES (?, 'pending_review', ?) RETURNING *")
        .get(file.id, JSON.stringify(diff));
    });

    // Issue #464: approves every write an edit is waiting on, one file after
    // another, then carries the node over to its new name (rename.ts) and
    // reads the written files back (refresh.ts). A file that fails is
    // recorded as failed and the rest still go ahead.
    app.post<{ Params: { id: string } }>("/tag-writes/edits/:id/approve", async (request, reply) => {
      const edit = getEdit(request.params.id);
      if (!edit) {
        reply.code(404);
        return { error: "not found" };
      }
      const rows = editWrites(edit.id, "pending_review");
      if (rows.length === 0) {
        reply.code(409);
        return { error: "nothing in this edit is waiting to be written" };
      }

      const linked = edit.applied ? [] : filesLinkedTo(db, edit.node_id);
      const written: number[] = [];
      const failed: { fileId: number; path: string; error: string }[] = [];
      for (const row of rows) {
        const result = await writeRow(row);
        if (result.ok) written.push(row.file_id);
        else failed.push({ fileId: row.file_id, path: fileOf(row.file_id).file_path, error: result.error });
      }

      let nodeId = edit.node_id;
      await refreshAfterWrite(db, written, written.length > 0 ? linked : [], () => {
        if (written.length > 0) nodeId = applyNodeEdit(db, edit.id);
      });
      if (written.length > 0) broadcast("tag-write:written", { editId: edit.id, fileIds: written });
      return { written: written.length, failed, nodeId };
    });

    // Issue #464: discards everything an edit is still waiting on, unwritten.
    app.delete<{ Params: { id: string } }>("/tag-writes/edits/:id", async (request, reply) => {
      const edit = getEdit(request.params.id);
      if (!edit) {
        reply.code(404);
        return { error: "not found" };
      }
      const rows = editWrites(edit.id, "pending_review");
      db.prepare("DELETE FROM tag_writes WHERE edit_id = ? AND status = 'pending_review'").run(edit.id);
      // Writes already approved one at a time from Library health renamed
      // the node; the files discarded here still say the old name.
      if (edit.applied) await refreshAfterWrite(db, [], rows.map((r) => r.file_id));
      forgetEditIfEmpty(edit.id);
      reply.code(204);
      return null;
    });

    // Actually writes to disk. Separate from creation on purpose — the
    // dry-run diff is meant to be reviewed before this ever runs.
    app.post<{ Params: { id: string } }>("/tag-writes/:id/approve", async (request, reply) => {
      const tagWrite = getWrite(request.params.id);
      if (!tagWrite) {
        reply.code(404);
        return { error: "not found" };
      }
      if (tagWrite.status !== "pending_review") {
        reply.code(409);
        return { error: `cannot approve a tag_write in status '${tagWrite.status}'` };
      }

      // One of an edit's writes, approved on its own from Library health:
      // the first one carries the node over. The edit's other files are
      // still waiting and still say the old name; they follow when they're
      // approved, or are re-derived if they're discarded.
      const edit = getEdit(tagWrite.edit_id);
      const linked = edit && !edit.applied ? filesLinkedTo(db, edit.node_id) : [];
      const result = await writeRow(tagWrite);
      if (!result.ok) {
        reply.code(500);
        return { error: result.error };
      }
      const waiting = new Set(edit ? editWrites(edit.id, "pending_review").map((r) => r.file_id) : []);
      await refreshAfterWrite(
        db,
        [tagWrite.file_id],
        linked.filter((id) => !waiting.has(id)),
        () => edit && applyNodeEdit(db, edit.id),
      );
      broadcast("tag-write:written", { tagWriteId: tagWrite.id, fileId: tagWrite.file_id });
      return getWrite(tagWrite.id);
    });

    // Discards a review without writing anything to disk. Only pending or
    // already-terminal rows are eligible — a 'written' row still has a live
    // file-system effect and must go through /revert instead, which is the
    // only path that also clears app_write_marker/last_written_mtime.
    app.delete<{ Params: { id: string } }>("/tag-writes/:id", async (request, reply) => {
      const tagWrite = getWrite(request.params.id);
      if (!tagWrite) {
        reply.code(404);
        return { error: "not found" };
      }
      if (tagWrite.status === "written") {
        reply.code(409);
        return { error: "cannot delete a written tag_write — revert it first" };
      }

      db.prepare("DELETE FROM tag_writes WHERE id = ?").run(tagWrite.id);
      const edit = getEdit(tagWrite.edit_id);
      if (edit?.applied && tagWrite.status === "pending_review") await refreshAfterWrite(db, [], [tagWrite.file_id]);
      forgetEditIfEmpty(tagWrite.edit_id);
      reply.code(204);
      return null;
    });

    // Re-applies the old values from the same diff — itself a write (goes
    // through the same atomic path and gets its own fresh write-marker),
    // not a magic "undo."
    //
    // Issue #464: read back like any other write. Reverting the last of a
    // renamed node's files puts its old name back (rename.ts).
    app.post<{ Params: { id: string } }>("/tag-writes/:id/revert", async (request, reply) => {
      const tagWrite = getWrite(request.params.id);
      if (!tagWrite) {
        reply.code(404);
        return { error: "not found" };
      }
      if (tagWrite.status !== "written") {
        reply.code(409);
        return { error: `cannot revert a tag_write in status '${tagWrite.status}'` };
      }

      const file = fileOf(tagWrite.file_id);
      const diff = JSON.parse(tagWrite.diff_json) as FieldDiff[];
      const oldValues = Object.fromEntries(diff.map((d) => [d.field, d.oldValue])) as TagFields;

      try {
        const { writeId, writtenMtime } = await revertTagWrite(file.file_path, oldValues);
        db.prepare("UPDATE files SET app_write_marker = ?, last_written_mtime = ? WHERE id = ?").run(writeId, writtenMtime, file.id);
        const updated = db
          .prepare("UPDATE tag_writes SET status = 'reverted', reverted_at = datetime('now') WHERE id = ? RETURNING *")
          .get(tagWrite.id);
        const edit = getEdit(tagWrite.edit_id);
        await refreshAfterWrite(db, [file.id], [], () => {
          if (edit && editWrites(edit.id, "written").length === 0) undoNodeEdit(db, edit.id);
        });
        broadcast("tag-write:reverted", { tagWriteId: tagWrite.id, fileId: file.id });
        return updated;
      } catch (err) {
        reply.code(500);
        return { error: message(err) };
      }
    });
  };
}
