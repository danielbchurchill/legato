// Test-only helpers shared across spec files. Not a *.spec.ts itself, so
// `bun test` never picks it up as a suite of its own.
import type { Mock } from "bun:test";

// bun:test has no equivalent of vitest's `vi.mocked()`. That function does
// nothing at runtime — it's a pure type-narrowing identity, letting
// TypeScript treat an import that `mock.module()` replaced (e.g.
// `mbClient.searchArtist`) as the Mock instance it actually is, so
// `.mockResolvedValue()` etc. type-check. This is the same cast, for the
// same reason.
export function mocked<T extends (...args: never[]) => unknown>(fn: T): Mock<T> {
  return fn as unknown as Mock<T>;
}
