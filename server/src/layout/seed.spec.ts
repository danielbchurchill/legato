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
});
