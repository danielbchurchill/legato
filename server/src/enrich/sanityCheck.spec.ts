import { describe, expect, it } from "vitest";
import { looksSuspicious } from "./sanityCheck.js";

describe("looksSuspicious", () => {
  it("flags the real reversed-word-order case (Vol N - Title instead of Title, Vol. N)", () => {
    expect(looksSuspicious("Vol 1 - Past Masters")).toBe(true);
    expect(looksSuspicious("Vol. 2 - Past Masters")).toBe(true);
    expect(looksSuspicious("Disc 1 - Some Album")).toBe(true);
  });

  it("does not flag a normal title", () => {
    expect(looksSuspicious("Past Masters, Vol. 1")).toBe(false);
    expect(looksSuspicious("Abbey Road")).toBe(false);
    expect(looksSuspicious("Come Together")).toBe(false);
  });

  it("flags empty or missing titles", () => {
    expect(looksSuspicious("")).toBe(true);
    expect(looksSuspicious("   ")).toBe(true);
    expect(looksSuspicious(null)).toBe(true);
    expect(looksSuspicious(undefined)).toBe(true);
  });

  it("flags mangled encoding artifacts", () => {
    expect(looksSuspicious("Com�e Together")).toBe(true);
    expect(looksSuspicious("Come__Together__Now")).toBe(true);
  });
});
