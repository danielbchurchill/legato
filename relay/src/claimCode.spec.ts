import { describe, expect, it } from "bun:test";
import { CODE_ALPHABET, normalizeCode } from "./claimCode.js";

describe("CODE_ALPHABET", () => {
  it("is Crockford base32, without the letters Crockford drops", () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    for (const letter of "ILOU") expect(CODE_ALPHABET).not.toContain(letter);
  });
});

describe("normalizeCode", () => {
  it("accepts lowercase, a missing dash and stray spaces", () => {
    expect(normalizeCode("k7qm-4xrd")).toBe("K7QM-4XRD");
    expect(normalizeCode("K7QM4XRD")).toBe("K7QM-4XRD");
    expect(normalizeCode(" k7qm 4xrd ")).toBe("K7QM-4XRD");
  });

  it("reads O as 0 and I or L as 1", () => {
    expect(normalizeCode("OOII-LL00")).toBe("0011-1100");
  });

  it("rejects anything that can't be a code", () => {
    for (const bad of ["", "K7QM-4XR", "K7QM-4XRDX", "K7QM-4XRU", "K7QM_4XRD", undefined, 12345678]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });
});
