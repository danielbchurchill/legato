import { describe, expect, it } from "bun:test";
import { parseRange } from "./files.js";

const SIZE = 1000;

describe("parseRange", () => {
  it("returns null with no Range header — the caller sends a plain 200", () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
  });

  it("returns null for a non-bytes unit", () => {
    expect(parseRange("items=0-10", SIZE)).toBeNull();
  });

  it("parses an open-ended range, what a mobile <audio> element probes with first", () => {
    expect(parseRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("parses a fully bounded range", () => {
    expect(parseRange("bytes=200-499", SIZE)).toEqual({ start: 200, end: 499 });
  });

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-500", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("clamps a suffix range larger than the file to the whole file", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("rejects a start past the end of the file", () => {
    expect(parseRange("bytes=1000-1500", SIZE)).toBeNull();
  });

  it("rejects an end at or past the file size", () => {
    expect(parseRange("bytes=0-999", SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=0-1000", SIZE)).toBeNull();
  });

  it("rejects start > end", () => {
    expect(parseRange("bytes=500-200", SIZE)).toBeNull();
  });

  it("falls back to a full response for a multi-range request rather than mis-parsing it", () => {
    expect(parseRange("bytes=0-100,200-300", SIZE)).toBeNull();
  });

  it("rejects garbage instead of throwing", () => {
    expect(parseRange("bytes=abc-def", SIZE)).toBeNull();
    expect(parseRange("bytes=", SIZE)).toBeNull();
  });
});
