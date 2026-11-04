import { describe, expect, it } from "bun:test";
import { caaImageUrl, parseCaaListing } from "./coverArchive.js";

const RELEASE = "02ac7ce7-4f21-4010-8210-e682085c58ab";

// Issue #461: a release's listing, trimmed from a live answer for one of
// Rumours' CD editions.
describe("parseCaaListing", () => {
  it("reads each image's id, types, front and back marks and comment", () => {
    const images = parseCaaListing({
      images: [
        { id: "4647807254", types: ["Front"], front: true, back: false, comment: "Jewel case front & booklet page 1 (front cover)" },
        { id: "4647819936", types: ["Booklet"], front: false, back: false, comment: "page 2 & 3" },
        { id: 1234, types: [], front: false, back: false, comment: "" },
      ],
    });
    expect(images).toEqual([
      { id: "4647807254", types: ["Front"], front: true, back: false, comment: "Jewel case front & booklet page 1 (front cover)" },
      { id: "4647819936", types: ["Booklet"], front: false, back: false, comment: "page 2 & 3" },
      { id: "1234", types: [], front: false, back: false, comment: null },
    ]);
  });

  // The id goes into a URL this server fetches, so anything but digits is
  // left out rather than passed along.
  it("leaves out an image whose id isn't a number", () => {
    expect(parseCaaListing({ images: [{ id: "../../etc", types: ["Front"] }] })).toEqual([]);
  });
});

describe("caaImageUrl", () => {
  it("names a sized copy, or the original with no size", () => {
    expect(caaImageUrl(RELEASE, "front", 250)).toBe(`https://coverartarchive.org/release/${RELEASE}/front-250.jpg`);
    expect(caaImageUrl(RELEASE, "4647807254", null)).toBe(`https://coverartarchive.org/release/${RELEASE}/4647807254.jpg`);
  });
});
