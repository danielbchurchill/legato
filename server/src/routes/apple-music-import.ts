import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../sqlite.js";
import { importAppleMusicLibrary, previewAppleMusicImport } from "../applemusic/import.js";
import { LibraryXmlError } from "../applemusic/library.js";
import { broadcast } from "../ws.js";

// #133: Apple Music's Library.xml, sent as the file itself (application/xml
// or text/xml), so a library of tens of thousands of tracks isn't wrapped
// in JSON on the way. Preview first, then import, the M3U import's two
// steps (routes/playlist-import.ts). applemusic/import.ts does the work.

// About 170,000 tracks of Music's XML. Fastify answers 413 past it.
export const MAX_LIBRARY_XML_BYTES = 256 * 1024 * 1024;

// An import replaces the whole library's imported play counts, so it's
// the owner's to do, like adding a folder.
function refuseUnlessOwner(request: FastifyRequest, reply: FastifyReply) {
  if (request.authUser?.role === "owner") return null;
  reply.code(403);
  return { error: "Only the server's owner can import a Music library.", reason: "owner_only" };
}

function readBody(request: FastifyRequest, reply: FastifyReply): string | { error: string } {
  if (typeof request.body !== "string" || !request.body.trim()) {
    reply.code(400);
    return { error: "Send Music's Library.xml as the request body, as application/xml." };
  }
  return request.body;
}

export function appleMusicImportRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    // Scoped to this plugin: nowhere else takes XML.
    app.addContentTypeParser(
      ["application/xml", "text/xml"],
      { parseAs: "string", bodyLimit: MAX_LIBRARY_XML_BYTES },
      (_request, body, done) => done(null, body),
    );

    app.post("/apple-music/import/preview", async (request, reply) => {
      const refused = refuseUnlessOwner(request, reply);
      if (refused) return refused;
      const xml = readBody(request, reply);
      if (typeof xml !== "string") return xml;
      try {
        return previewAppleMusicImport(db, xml);
      } catch (err) {
        if (!(err instanceof LibraryXmlError)) throw err;
        reply.code(400);
        return { error: err.message, reason: "not_a_library" };
      }
    });

    app.post<{ Querystring: { filename?: string } }>("/apple-music/import", async (request, reply) => {
      const refused = refuseUnlessOwner(request, reply);
      if (refused) return refused;
      const xml = readBody(request, reply);
      if (typeof xml !== "string") return xml;
      try {
        const result = importAppleMusicLibrary(db, request.query.filename?.trim() || "Library.xml", xml);
        for (const playlist of result.playlists) {
          if (playlist.playlistId != null) broadcast("playlist:changed", { id: playlist.playlistId });
        }
        return result;
      } catch (err) {
        if (!(err instanceof LibraryXmlError)) throw err;
        reply.code(400);
        return { error: err.message, reason: "not_a_library" };
      }
    });
  };
}
