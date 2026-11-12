import { describe, expect, it, spyOn } from "bun:test";
import { openDb } from "../db.js";
import { indexOf, loadVectorIndex, READ_SLICE_MS, rowOf, scoreRows, scoreRowsAgainstEach, SLICE_MS } from "./vectorIndex.js";
import { cosineSimilarity, encodeVector, sparseVector, vectorNorm } from "./vectors.js";

describe("loadVectorIndex", () => {
  it("reads every stored vector, over as many pages as it takes", async () => {
    const db = openDb(":memory:");
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES (?, 'x') RETURNING id");
    const store = db.prepare("INSERT INTO node_similarity_features (node_id, vector) VALUES (?, ?)");
    const expected = new Map<number, { type: string; vector: ReturnType<typeof sparseVector> }>();
    db.transaction(() => {
      // Five pages of 1,000, so the read goes on past the first.
      for (let i = 0; i < 5_000; i++) {
        const type = i % 10 === 0 ? "release" : "recording";
        const id = (node.get(type) as { id: number }).id;
        const vector = sparseVector([
          [1 + (i % 7), 0.5],
          [100 + (i % 13), i / 5_000],
        ]);
        store.run(id, encodeVector(vector));
        expected.set(id, { type, vector });
      }
    })();

    const index = await loadVectorIndex(db);
    expect(index.ids.length).toBe(5_000);
    expect([...index.ids]).toEqual([...expected.keys()].sort((a, b) => a - b));
    expect(index.offsets[0]).toBe(0);
    expect(index.offsets[5_000]).toBe(index.dims.length);
    expect(index.maxDim).toBe(112);
    for (const [id, { type, vector }] of expected) {
      const row = rowOf(index, id);
      const start = index.offsets[row]!;
      const end = index.offsets[row + 1]!;
      expect([...index.dims.subarray(start, end)]).toEqual([...vector.dims]);
      expect([...index.values.subarray(start, end)]).toEqual([...vector.values]);
      expect(index.norms[row]).toBe(vectorNorm(vector));
      expect(index.types[index.kinds[row]!]).toBe(type);
    }
  });

  /** Reads five pages of vectors with the clock moving `step` ms every time
   *  it's read, and counts the times the read lets the loop run. */
  async function yieldsReadingFivePages(step: number): Promise<number> {
    const db = openDb(":memory:");
    const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id");
    const store = db.prepare("INSERT INTO node_similarity_features (node_id, vector) VALUES (?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 5_000; i++) store.run((node.get() as { id: number }).id, encodeVector(sparseVector([[1, 1]])));
    })();

    let clock = 0;
    const now = spyOn(performance, "now").mockImplementation(() => (clock += step));
    const yields = spyOn(globalThis, "setTimeout");
    try {
      const index = await loadVectorIndex(db);
      expect(index.ids.length).toBe(5_000);
      return yields.mock.calls.length;
    } finally {
      now.mockRestore();
      yields.mockRestore();
    }
  }

  // Issue #494: putting the arrays together in one go held a Pi's loop for
  // 68 ms at 30,000 albums. Every step of it now lets the loop run once a
  // slice is up, as reading the pages does. With the clock made to say a
  // slice is always up, the loop runs after every page read and every page
  // put together: five pages, so ten times at least, against seven before.
  it("lets the loop run between the pages it puts together, not only between those it reads", async () => {
    expect(await yieldsReadingFivePages(SLICE_MS)).toBeGreaterThanOrEqual(10);
  });

  // Issue #494: the read runs in the background, in slices half a ranking's
  // length. A clock that moves just over READ_SLICE_MS each time it's read
  // makes every chance to give way a slice's end: 12 of them, and the one
  // before returning. In a ranking's 20 ms slices only every other one is.
  it("gives way in slices of READ_SLICE_MS, not a ranking's SLICE_MS", async () => {
    expect(READ_SLICE_MS).toBeLessThan(SLICE_MS);
    expect(await yieldsReadingFivePages(READ_SLICE_MS + 1)).toBeGreaterThanOrEqual(12);
  });

  it("reads an empty table as an empty index", async () => {
    const index = await loadVectorIndex(openDb(":memory:"));
    expect(index.ids.length).toBe(0);
    expect(rowOf(index, 1)).toBe(-1);
  });
});

describe("scoreRows", () => {
  const vectors = [
    { nodeId: 2, type: "recording", vector: sparseVector([[1, 1], [2, 1]]) },
    { nodeId: 5, type: "release", vector: sparseVector([[1, 1]]) },
    { nodeId: 8, type: "recording", vector: sparseVector([[2, 3]]) },
    { nodeId: 9, type: "recording", vector: sparseVector([]) },
    { nodeId: 11, type: "recording", vector: sparseVector([[1, 2], [7, 1]]) },
  ];
  const index = indexOf(vectors);

  it("scores every row of the type it's given that the filter keeps, as cosineSimilarity does", async () => {
    const scores: [number, number][] = [];
    await scoreRows(index, rowOf(index, 2), index.kinds[rowOf(index, 2)]!, (row) => index.ids[row] !== 8, (row, score) =>
      scores.push([index.ids[row]!, score]),
    );
    expect(scores.map(([id]) => id)).toEqual([2, 9, 11]);
    for (const [id, score] of scores) {
      expect(score).toBeCloseTo(cosineSimilarity(vectors[0]!.vector, vectors.find((v) => v.nodeId === id)!.vector), 12);
    }
  });

  // Issue #494: /dissimilar's coverage counts score every candidate against
  // twelve rows in one pass. Each score must be the very number scoreRows
  // gives, so the counts and the order they make don't move. Widths around
  // the groups of four it sums in, and a row with no entries (norm 0).
  it("scores against several rows at once exactly as scoreRows does against each", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      nodeId: i + 1,
      type: i % 5 === 0 ? "release" : "recording",
      vector:
        i === 7
          ? sparseVector([])
          : sparseVector([
              [1 + (i % 3), 0.25 + (i % 4) / 3],
              [5 + (i % 7), 1 / (1 + i)],
              [20, i / 40],
            ]),
    }));
    const big = indexOf(rows);
    const kind = big.kinds[1]!;
    const include = (row: number) => row !== 3;
    for (const width of [1, 3, 4, 5, 12]) {
      const from = Array.from({ length: width }, (_, j) => (j * 7 + 1) % rows.length);
      const each: number[][] = [];
      for (const row of from) {
        const scores: number[] = [];
        await scoreRows(big, row, kind, include, (_, score) => scores.push(score));
        each.push(scores);
      }
      const together: number[][] = from.map(() => []);
      const visited: number[] = [];
      await scoreRowsAgainstEach(big, from, kind, include, (row, scores) => {
        visited.push(row);
        expect(scores.length).toBe(width);
        scores.forEach((score, j) => together[j]!.push(score));
      });
      expect(together).toEqual(each);
      expect(visited).not.toContain(3);
      expect(visited.every((row) => big.kinds[row] === kind)).toBe(true);
    }
  });

  it("finds a row by node id", () => {
    expect([2, 5, 8, 9, 11].map((id) => rowOf(index, id))).toEqual([0, 1, 2, 3, 4]);
    expect(rowOf(index, 3)).toBe(-1);
    expect(rowOf(index, 12)).toBe(-1);
  });
});
