import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { computeDiff, type FieldDiff } from "../tagwrite/diff.js";
import { applyTagWrite, revertTagWrite } from "../tagwrite/writer.js";
import type { TagFields } from "../tagwrite/fields.js";
import { broadcast } from "../ws.js";

type FileRow = { id: number; file_path: string };
type TagWriteRow = { id: number; file_id: number; status: string; diff_json: string };

export function tagWritesRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/tag-writes", async () =>
      db.prepare("SELECT * FROM tag_writes ORDER BY id DESC LIMIT 100").all(),
    );

    app.get<{ Params: { id: string } }>("/tag-writes/:id", async (request, reply) => {
      const row = db.prepare("SELECT * FROM tag_writes WHERE id = ?").get(request.params.id);
      if (!row) {
        reply.code(404);
        return { error: "not found" };
      }
      return row;
    });

    // Dry-run only — computes the diff and stores it for review. Mandatory
    // no-op check: a diff with nothing in it (on-disk already matches)
    // never becomes a tag_writes row at all.
    app.post<{ Body: { fileId: number; changes: TagFields } }>("/tag-writes", async (request, reply) => {
      const file = db
        .prepare("SELECT id, file_path FROM files WHERE id = ?")
        .get(request.body.fileId) as FileRow | undefined;
      if (!file) {
        reply.code(404);
        return { error: "file not found" };
      }

      let diff: FieldDiff[];
      try {
        diff = computeDiff(file.file_path, request.body.changes);
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }

      if (diff.length === 0) {
        return { noop: true, diff: [] };
      }

      return db
        .prepare(
          "INSERT INTO tag_writes (file_id, status, diff_json) VALUES (?, 'pending_review', ?) RETURNING *",
        )
        .get(file.id, JSON.stringify(diff));
    });

    // Actually writes to disk. Separate from creation on purpose — the
    // dry-run diff is meant to be reviewed before this ever runs.
    app.post<{ Params: { id: string } }>("/tag-writes/:id/approve", async (request, reply) => {
      const tagWrite = db
        .prepare("SELECT * FROM tag_writes WHERE id = ?")
        .get(request.params.id) as TagWriteRow | undefined;
      if (!tagWrite) {
        reply.code(404);
        return { error: "not found" };
      }
      if (tagWrite.status !== "pending_review") {
        reply.code(409);
        return { error: `cannot approve a tag_write in status '${tagWrite.status}'` };
      }

      const file = db.prepare("SELECT id, file_path FROM files WHERE id = ?").get(tagWrite.file_id) as FileRow;
      const diff = JSON.parse(tagWrite.diff_json) as FieldDiff[];
      const changes = Object.fromEntries(diff.map((d) => [d.field, d.newValue])) as TagFields;

      try {
        const { writeId, writtenMtime } = await applyTagWrite(file.file_path, changes);
        db.prepare("UPDATE files SET app_write_marker = ?, last_written_mtime = ? WHERE id = ?").run(
          writeId,
          writtenMtime,
          file.id,
        );
        const updated = db
          .prepare("UPDATE tag_writes SET status = 'written', written_at = datetime('now') WHERE id = ? RETURNING *")
          .get(tagWrite.id);
        broadcast("tag-write:written", { tagWriteId: tagWrite.id, fileId: file.id });
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.prepare("UPDATE tag_writes SET status = 'failed', error_message = ? WHERE id = ?").run(
          message,
          tagWrite.id,
        );
        reply.code(500);
        return { error: message };
      }
    });

    // Discards a review without writing anything to disk. Only pending or
    // already-terminal rows are eligible — a 'written' row still has a live
    // file-system effect and must go through /revert instead, which is the
    // only path that also clears app_write_marker/last_written_mtime.
    app.delete<{ Params: { id: string } }>("/tag-writes/:id", async (request, reply) => {
      const tagWrite = db
        .prepare("SELECT * FROM tag_writes WHERE id = ?")
        .get(request.params.id) as TagWriteRow | undefined;
      if (!tagWrite) {
        reply.code(404);
        return { error: "not found" };
      }
      if (tagWrite.status === "written") {
        reply.code(409);
        return { error: "cannot delete a written tag_write — revert it first" };
      }

      db.prepare("DELETE FROM tag_writes WHERE id = ?").run(tagWrite.id);
      reply.code(204);
      return null;
    });

    // Re-applies the old values from the same diff — itself a write (goes
    // through the same atomic path and gets its own fresh write-marker),
    // not a magic "undo."
    app.post<{ Params: { id: string } }>("/tag-writes/:id/revert", async (request, reply) => {
      const tagWrite = db
        .prepare("SELECT * FROM tag_writes WHERE id = ?")
        .get(request.params.id) as TagWriteRow | undefined;
      if (!tagWrite) {
        reply.code(404);
        return { error: "not found" };
      }
      if (tagWrite.status !== "written") {
        reply.code(409);
        return { error: `cannot revert a tag_write in status '${tagWrite.status}'` };
      }

      const file = db.prepare("SELECT id, file_path FROM files WHERE id = ?").get(tagWrite.file_id) as FileRow;
      const diff = JSON.parse(tagWrite.diff_json) as FieldDiff[];
      const oldValues = Object.fromEntries(diff.map((d) => [d.field, d.oldValue])) as TagFields;

      try {
        const { writeId, writtenMtime } = await revertTagWrite(file.file_path, oldValues);
        db.prepare("UPDATE files SET app_write_marker = ?, last_written_mtime = ? WHERE id = ?").run(
          writeId,
          writtenMtime,
          file.id,
        );
        const updated = db
          .prepare("UPDATE tag_writes SET status = 'reverted', reverted_at = datetime('now') WHERE id = ? RETURNING *")
          .get(tagWrite.id);
        broadcast("tag-write:reverted", { tagWriteId: tagWrite.id, fileId: file.id });
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(500);
        return { error: message };
      }
    });
  };
}
