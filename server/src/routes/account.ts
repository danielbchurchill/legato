import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "../sqlite.js";
import { MAX_UPLOAD_BYTES, PICTURE_HASH_PATTERN, pictures } from "../account/pictures.js";
import { SESSION_USER_COLUMNS, type SessionUser } from "../auth/sessions.js";
import { broadcast } from "../ws.js";
import { publicUser } from "./auth.js";

// The signed-in user's own account (issue #470): their name and their
// picture, for the Account panel. Every route here is behind the gate, and
// each changes only the user who asks. A media ticket can read a picture
// but change nothing (auth/gate.ts).

// The same bound creating the owner puts on a name (routes/auth.ts).
export const MAX_DISPLAY_NAME_LENGTH = 200;

function freshUser(db: Database, userId: number): SessionUser {
  return db.prepare(`SELECT ${SESSION_USER_COLUMNS} FROM users WHERE id = ?`).get(userId) as SessionUser;
}

function signedInUser(request: FastifyRequest): SessionUser {
  // The gate answers 401 before a route runs for anyone signed out.
  return request.authUser!;
}

export function accountRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    // index.ts takes raw image bytes for the whole server, as covers are
    // uploaded. A spec's server doesn't, so this adds the same parser where
    // it's missing.
    if (!app.hasContentTypeParser(/^image\/.*/)) {
      app.addContentTypeParser(/^image\/.*/, { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) =>
        done(null, body),
      );
    }

    // The name the rail's initials and the Account panel show. An empty
    // name is no name, and the initials fall back to the email's first
    // letter, as they do for an owner created without one.
    app.patch<{ Body: { displayName?: unknown } | null }>("/account", async (request, reply) => {
      const user = signedInUser(request);
      const raw = request.body?.displayName;
      if (typeof raw !== "string") {
        reply.code(400);
        return { error: "Send the new name as `displayName`.", reason: "bad_name" };
      }
      const name = raw.trim();
      if (name.length > MAX_DISPLAY_NAME_LENGTH) {
        reply.code(400);
        return { error: `A name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`, reason: "name_too_long" };
      }
      db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name || null, user.id);
      broadcast("account:changed", { userId: user.id });
      return { user: publicUser(freshUser(db, user.id)) };
    });

    // A picture of the user's own, as raw image bytes. It replaces any
    // earlier upload and wins over legato.fm's picture, and it never leaves
    // this server.
    app.put("/account/picture", async (request, reply) => {
      const user = signedInUser(request);
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400);
        return { error: "Send the picture's bytes as the request body, with an image content type.", reason: "no_picture" };
      }
      if (body.length > MAX_UPLOAD_BYTES) {
        reply.code(413);
        return { error: "That picture is too big. Pick one under 20 MB.", reason: "picture_too_big" };
      }
      const store = pictures(db);
      let hash: string;
      try {
        hash = await store.store(body);
      } catch {
        reply.code(400);
        return { error: "That file isn't a picture this server can read. Try a JPEG or PNG.", reason: "not_a_picture" };
      }
      await store.setUpload(user.id, hash);
      return { user: publicUser(freshUser(db, user.id)) };
    });

    // Removes the uploaded picture. legato.fm's, if there is one, shows
    // again; otherwise the initials do.
    app.delete("/account/picture", async (request) => {
      const user = signedInUser(request);
      await pictures(db).setUpload(user.id, null);
      return { user: publicUser(freshUser(db, user.id)) };
    });

    // A picture by its hash, uploaded or fetched, for any signed-in device:
    // <img> loads it with the media ticket. The hash names the bytes, so
    // the answer never changes and can be kept a year.
    app.get<{ Params: { hash: string } }>("/account/pictures/:hash", async (request, reply) => {
      const { hash } = request.params;
      if (!PICTURE_HASH_PATTERN.test(hash)) {
        reply.code(400);
        return { error: "That isn't a picture's hash.", reason: "bad_hash" };
      }
      const bytes = await pictures(db).read(hash);
      if (!bytes) {
        reply.code(404);
        return { error: "There's no picture with that hash.", reason: "no_picture" };
      }
      reply.header("Content-Type", "image/jpeg");
      reply.header("ETag", `"${hash}"`);
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
      return reply.send(bytes);
    });
  };
}
