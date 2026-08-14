import { describe, expect, it } from "vitest";
import { computeSeeds } from "./seed.js";

describe("computeSeeds", () => {
  it("is deterministic — same input produces byte-identical output every time", () => {
    const inputs = [
      { nodeId: 3, year: 1969 },
      { nodeId: 1, year: 1969 },
      { nodeId: 2, year: 1987 },
    ];
    const first = computeSeeds(inputs);
    const second = computeSeeds([...inputs].reverse()); // input order shouldn't matter
    expect(second).toEqual(first);
  });

  it("spreads nodes sharing a (decade, year) cell instead of stacking them", () => {
    const inputs = [
      { nodeId: 1, year: 1969 },
      { nodeId: 2, year: 1969 },
      { nodeId: 3, year: 1969 },
    ];
    const seeds = computeSeeds(inputs);
    const positions = [seeds.get(1), seeds.get(2), seeds.get(3)];
    const unique = new Set(positions.map((p) => `${p?.x},${p?.y}`));
    expect(unique.size).toBe(3);
  });

  it("gives different years a different Y and different decades a different X", () => {
    const seeds = computeSeeds([
      { nodeId: 1, year: 1965 },
      { nodeId: 2, year: 1969 }, // same decade as 1965
      { nodeId: 3, year: 1989 }, // different decade
    ]);
    const y1965 = seeds.get(1)!;
    const y1969 = seeds.get(2)!;
    const y1989 = seeds.get(3)!;

    expect(y1965.x).toBe(y1969.x); // same decade
    expect(y1965.y).not.toBe(y1969.y);
    expect(y1989.x).not.toBe(y1965.x); // different decade
  });

  it("routes nodes with no year to a dedicated region, not the origin", () => {
    const seeds = computeSeeds([{ nodeId: 1, year: null }]);
    const seed = seeds.get(1)!;
    expect(seed.x).toBeLessThan(0);
  });

  // Regression: the unknown-year region used to be a fixed -1200 while real
  // years derive their x from the calendar year (1960s -> 78,400). One
  // untagged file then sat ~79,600 units from everything else and stretched
  // the bounding box 16x, squeezing the whole graph into a corner of the
  // canvas. The region has to be relative to the actual data.
  it("keeps the unknown-year region near the real data, not at a fixed origin", () => {
    const seeds = computeSeeds([
      { nodeId: 1, year: 1964 },
      { nodeId: 2, year: 1969 },
      { nodeId: 3, year: null },
    ]);

    const xs = [...seeds.values()].map((s) => s.x);
    const span = Math.max(...xs) - Math.min(...xs);

    // Three decades of margin, not five figures of it.
    expect(span).toBeLessThan(2000);
  });

  it("scales the unknown region with the era of the collection", () => {
    const sixties = computeSeeds([
      { nodeId: 1, year: 1964 },
      { nodeId: 2, year: null },
    ]);
    const noughties = computeSeeds([
      { nodeId: 1, year: 2004 },
      { nodeId: 2, year: null },
    ]);

    expect(noughties.get(2)!.x).toBeGreaterThan(sixties.get(2)!.x);
  });
});
