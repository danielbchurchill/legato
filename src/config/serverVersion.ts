// The lowest server this client works with, as the server's schemaVersion
// (the highest migration it has applied — see server/src/routes/health.ts
// for the /health shape). Raise it in the same change that makes the client
// depend on a route or field a migration introduced; a server below it gets
// the "update the server" notice rather than a pile of confusing failures.
//
// Schema version rather than release version on purpose: a client needs
// the server's data model, and the migration number is the one thing that
// moves exactly when that changes, on every install channel alike.
export const MIN_SERVER_SCHEMA_VERSION = 28
