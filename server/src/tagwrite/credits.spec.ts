import { describe, expect, it } from "bun:test";
import { splitArtistCredit, splitJoinedNames } from "../scan/artist-credit.js";
import { renameCredits, renameInLine, type CreditFields } from "./credits.js";

const rename = (line: string, from: string, to: string, evidence: string[] = []) =>
  renameInLine(line, from, to, splitArtistCredit, evidence);

describe("renameInLine", () => {
  it("renames only that artist's part of a multi-artist line", () => {
    expect(rename("JPEGMAFIA; Danny Brown", "Danny Brown", "Danny B.")).toBe("JPEGMAFIA; Danny B.");
    expect(rename("JPEGMAFIA; Danny Brown", "JPEGMAFIA", "Peggy")).toBe("Peggy; Danny Brown");
    expect(rename("Gorillaz feat. De La Soul", "De La Soul", "De La")).toBe("Gorillaz feat. De La");
    expect(rename("Gorillaz feat. De La Soul", "Gorillaz", "The Gorillaz")).toBe("The Gorillaz feat. De La Soul");
    expect(rename("Run The Jewels (feat. Zack de la Rocha)", "Zack de la Rocha", "Zack")).toBe("Run The Jewels (feat. Zack)");
    expect(rename("Mount Eerie / Julie Doiron", "Julie Doiron", "J. Doiron")).toBe("Mount Eerie / J. Doiron");
  });

  it("renames a line that is only that artist", () => {
    expect(rename("The Beatles", "The Beatles", "Beatles")).toBe("Beatles");
  });

  it("matches the name the way the scanner does, case and spacing aside", () => {
    expect(rename("JPEGMAFIA;  danny brown", "Danny Brown", "Danny B.")).toBe("JPEGMAFIA;  Danny B.");
  });

  it("leaves a name alone where it's only part of another one", () => {
    expect(rename("Peter Bjorn and John", "John", "Jon")).toBe("Peter Bjorn and John");
    expect(rename("Peter Bjorn and John; John", "John", "Jon")).toBe("Peter Bjorn and John; Jon");
    expect(rename("Simon & Garfunkel", "Simon", "Paul Simon")).toBe("Simon & Garfunkel");
    expect(rename("AC/DC", "AC", "Acca")).toBe("AC/DC");
  });

  it("renames a part the evidence splits a ',' or '&' line into", () => {
    const evidence = ["Cage The Elephant", "Alison Mosshart"];
    expect(rename("Cage The Elephant, Alison Mosshart", "Alison Mosshart", "Alison M.", evidence)).toBe(
      "Cage The Elephant, Alison M.",
    );
    expect(rename("Cage The Elephant, Alison Mosshart", "Alison Mosshart", "Alison M.")).toBe("Cage The Elephant, Alison Mosshart");
  });

  it("renames every mention when a tagger repeated the name", () => {
    expect(rename("Kanye West feat. Kanye West", "Kanye West", "Ye")).toBe("Ye feat. Ye");
  });

  it("splits producer lines only on evidence, as the scanner does", () => {
    expect(renameInLine("Rick Rubin", "Rick Rubin", "Rubin", splitJoinedNames)).toBe("Rubin");
    expect(renameInLine("Rick Rubin & Jay", "Rick Rubin", "Rubin", splitJoinedNames)).toBe("Rick Rubin & Jay");
    expect(renameInLine("Rick Rubin & Jay", "Rick Rubin", "Rubin", splitJoinedNames, ["Rick Rubin", "Jay"])).toBe("Rubin & Jay");
  });
});

const credits = (overrides: Partial<CreditFields> = {}): CreditFields => ({
  performers: [],
  artists: [],
  albumArtist: "",
  producer: [],
  engineer: [],
  ...overrides,
});

describe("renameCredits", () => {
  it("is empty for a file that doesn't credit the artist", () => {
    expect(renameCredits(credits({ performers: ["Fairport Convention"] }), "Air", "AIR", [], [])).toEqual({});
  });

  it("rewrites every field the artist is credited in, and only those", () => {
    const changes = renameCredits(
      credits({
        performers: ["JPEGMAFIA; Danny Brown"],
        artists: ["JPEGMAFIA", "Danny Brown"],
        albumArtist: "JPEGMAFIA; Danny Brown",
        producer: ["Danny Brown"],
        engineer: ["Someone Else"],
      }),
      "Danny Brown",
      "Danny B.",
      ["JPEGMAFIA", "Danny Brown"],
      [],
    );
    expect(changes).toEqual({
      artist: "JPEGMAFIA; Danny B.",
      artists: ["JPEGMAFIA", "Danny B."],
      albumArtist: "JPEGMAFIA; Danny B.",
      producer: ["Danny B."],
    });
  });

  it("renames a featured artist named only in the ARTISTS list", () => {
    const changes = renameCredits(credits({ performers: ["Gorillaz"], artists: ["Gorillaz", "De La Soul"] }), "De La Soul", "De La", [], []);
    expect(changes).toEqual({ artists: ["Gorillaz", "De La"] });
  });

  it("writes every artist value of a file that has several", () => {
    const changes = renameCredits(credits({ performers: ["JPEGMAFIA", "Danny Brown"] }), "Danny Brown", "Danny B.", [], []);
    expect(changes).toEqual({ performers: ["JPEGMAFIA", "Danny B."] });
  });

  // MusicBrainz's credit still spells the old name after a rename, so a
  // line it alone was splitting would stop splitting. The ARTISTS list keeps
  // the split, the way Picard writes it.
  it("writes the ARTISTS list when only MusicBrainz's evidence split the line", () => {
    const changes = renameCredits(
      credits({ performers: ["Cage The Elephant, Alison Mosshart"] }),
      "Alison Mosshart",
      "Alison M.",
      ["Cage The Elephant", "Alison Mosshart"],
      [],
    );
    expect(changes).toEqual({ artist: "Cage The Elephant, Alison M.", artists: ["Cage The Elephant", "Alison M."] });
  });

  it("doesn't add an ARTISTS list where the separators split the line on their own", () => {
    const changes = renameCredits(credits({ performers: ["JPEGMAFIA; Danny Brown"] }), "Danny Brown", "Danny B.", [], []);
    expect(changes).toEqual({ artist: "JPEGMAFIA; Danny B." });
  });
});
