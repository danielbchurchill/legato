import { describe, expect, it } from "vitest";
import { computeClusteredSeeds, type ClusterInput } from "./cluster.js";

describe("computeClusteredSeeds", () => {
  it("is deterministic — identical input produces byte-identical output across runs", () => {
    const inputs: ClusterInput[] = [
      { nodeId: 1, groupKey: 100, decade: 1960 },
      { nodeId: 2, groupKey: 100, decade: 1960 },
      { nodeId: 3, groupKey: 100, decade: 1970 },
      { nodeId: 4, groupKey: 200, decade: 1960 },
      { nodeId: 5, groupKey: null, decade: null },
    ];

    const a = computeClusteredSeeds(inputs);
    const b = computeClusteredSeeds(inputs);

    for (const nodeId of [1, 2, 3, 4, 5]) {
      expect(a.get(nodeId)).toEqual(b.get(nodeId));
    }
  });

  it("returns a finite, non-NaN position for every input node", () => {
    const inputs: ClusterInput[] = Array.from({ length: 50 }, (_, i) => ({
      nodeId: i,
      groupKey: i % 5,
      decade: 1960 + (i % 6) * 10,
    }));

    const seeds = computeClusteredSeeds(inputs);
    expect(seeds.size).toBe(50);
    for (const seed of seeds.values()) {
      expect(Number.isFinite(seed.x)).toBe(true);
      expect(Number.isFinite(seed.y)).toBe(true);
    }
  });

  it("spreads members of an overcrowded cell apart rather than stacking them", () => {
    // The exact overplotting scenario the old grid packer replaced this
    // for: a lot of nodes sharing one (artist, decade) cell.
    const inputs: ClusterInput[] = Array.from({ length: 30 }, (_, i) => ({
      nodeId: i,
      groupKey: 42,
      decade: 1970,
    }));

    const seeds = [...computeClusteredSeeds(inputs).values()];
    const distances: number[] = [];
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        distances.push(Math.hypot(seeds[i].x - seeds[j].x, seeds[i].y - seeds[j].y));
      }
    }
    expect(Math.min(...distances)).toBeGreaterThan(0.5); // nothing coincides exactly
  });

  it("places different decades of the same artist at different X positions — the actual bug this replaced", () => {
    const inputs: ClusterInput[] = [
      { nodeId: 1, groupKey: 42, decade: 1960 },
      { nodeId: 2, groupKey: 42, decade: 1970 },
      { nodeId: 3, groupKey: 42, decade: 1980 },
    ];

    const seeds = computeClusteredSeeds(inputs);
    const xs = [seeds.get(1)!.x, seeds.get(2)!.x, seeds.get(3)!.x];
    expect(new Set(xs.map((x) => Math.round(x / 100))).size).toBe(3); // three distinct decade bands
  });

  it("places two different groups (artists) in the same decade at different Y bands", () => {
    const inputs: ClusterInput[] = [
      { nodeId: 1, groupKey: 42, decade: 1970 },
      { nodeId: 2, groupKey: 99, decade: 1970 },
    ];

    const seeds = computeClusteredSeeds(inputs);
    expect(seeds.get(1)!.y).not.toBeCloseTo(seeds.get(2)!.y, 0);
  });

  it("keeps a fully-unknown node (no group, no decade) from stretching the layout's bounding box", () => {
    const inputs: ClusterInput[] = [
      { nodeId: 1, groupKey: 42, decade: 1960 },
      { nodeId: 2, groupKey: null, decade: null },
    ];

    const seeds = computeClusteredSeeds(inputs);
    // Left of the known region, same reasoning as the original
    // unknownRegionX bug fix — not an arbitrary large offset.
    expect(seeds.get(2)!.x).toBeLessThan(seeds.get(1)!.x);
    expect(seeds.get(2)!.x - seeds.get(1)!.x).toBeGreaterThan(-2000);
  });

  it("handles an empty input without throwing", () => {
    expect(computeClusteredSeeds([]).size).toBe(0);
  });
});
