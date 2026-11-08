import { describe, expect, it } from "bun:test";
import { centroid, cosineSimilarity, decodeVector, encodeVector, sameBytes, sparseVector } from "./vectors.js";

describe("sparse vectors", () => {
  it("round-trips through the stored form, values to the last bit", () => {
    const vector = sparseVector([
      [70_000, Math.PI],
      [3, -1 / 3],
      [12, 1.5],
    ]);
    const bytes = encodeVector(vector);
    expect(bytes.byteLength).toBe(36);
    expect(decodeVector(bytes)).toEqual(vector);
    expect([...vector.dims]).toEqual([3, 12, 70_000]);
  });

  it("decodes from a view into a larger buffer, as SQLite may hand one back", () => {
    const bytes = encodeVector(sparseVector([[5, 0.25]]));
    const larger = new Uint8Array(bytes.byteLength + 3);
    larger.set(bytes, 3);
    expect(decodeVector(larger.subarray(3))).toEqual(sparseVector([[5, 0.25]]));
  });

  it("leaves zeros out", () => {
    expect([...sparseVector([[1, 0], [2, 0.5]]).dims]).toEqual([2]);
  });

  it("compares stored forms byte for byte", () => {
    const a = encodeVector(sparseVector([[1, 0.5]]));
    expect(sameBytes(a, encodeVector(sparseVector([[1, 0.5]])))).toBe(true);
    expect(sameBytes(a, encodeVector(sparseVector([[1, 0.25]])))).toBe(false);
    expect(sameBytes(a, encodeVector(sparseVector([[1, 0.5], [2, 1]])))).toBe(false);
    expect(sameBytes(undefined, a)).toBe(false);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    const v = sparseVector([[1, 1], [2, 2], [3, 3]]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it("is 0 for vectors that share no dimension", () => {
    expect(cosineSimilarity(sparseVector([[1, 1]]), sparseVector([[2, 1]]))).toBe(0);
  });

  it("is 0, not NaN, when either vector is empty", () => {
    expect(cosineSimilarity(sparseVector([]), sparseVector([[1, 2]]))).toBe(0);
    expect(cosineSimilarity(sparseVector([[1, 2]]), sparseVector([]))).toBe(0);
  });

  it("counts only the dimensions both have in the dot product, and every one in the norms", () => {
    const a = sparseVector([[1, 3], [2, 4]]);
    const b = sparseVector([[2, 1], [9, 1]]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(4 / (5 * Math.SQRT2), 12);
  });
});

describe("centroid", () => {
  it("is the mean in each dimension, missing ones counting as zero", () => {
    const mean = centroid([sparseVector([[1, 1], [2, 4]]), sparseVector([[2, 2], [3, 6]])]);
    expect([...mean.dims]).toEqual([1, 2, 3]);
    expect([...mean.values]).toEqual([0.5, 3, 3]);
  });
});
