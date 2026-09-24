// Ambient module for `import sql from "./file.sql" with { type: "text" }` —
// Bun resolves these at both runtime and `bun build --compile` time (see
// server/src/migrations/manifest.generated.ts), but tsc has no idea what a
// .sql file's module shape is without this declaration.
declare module "*.sql" {
  const contents: string;
  export default contents;
}
