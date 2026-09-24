// Type declaration for generate-migrations-manifest.mjs, imported by
// compile.ts. Kept as plain JS (like this repo's other one-off scripts,
// e.g. root scripts/fetch-media-binaries.mjs) rather than converted to
// .ts — this file exists purely so that import gets a real type instead
// of implicit `any`.
export function generateMigrationsManifest(): { count: number; outFile: string };
