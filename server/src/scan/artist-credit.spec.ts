import { describe, expect, it } from "bun:test";
import { extraCreditedArtists, splitArtistCredit } from "./artist-credit.js";

describe("splitArtistCredit", () => {
  it("splits a semicolon-joined credit into its artists", () => {
    expect(splitArtistCredit("JPEGMAFIA; Danny Brown")).toEqual(["JPEGMAFIA", "Danny Brown"]);
    expect(splitArtistCredit("JPEGMAFIA; Danny Brown; redveil")).toEqual([
      "JPEGMAFIA",
      "Danny Brown",
      "redveil",
    ]);
  });

  it("keeps the credited order, primary first", () => {
    expect(splitArtistCredit("Pussy Riot; Big Freedia")[0]).toBe("Pussy Riot");
  });

  it("tolerates semicolons without surrounding spaces", () => {
    expect(splitArtistCredit("A;B ;C ; D")).toEqual(["A", "B", "C", "D"]);
  });

  // The whole reason the separator list is short. Each of these is one act.
  it("never splits on and, ampersand, or comma", () => {
    expect(splitArtistCredit("Peter Bjorn and John")).toEqual(["Peter Bjorn and John"]);
    expect(splitArtistCredit("George Martin and His Orchestra")).toEqual([
      "George Martin and His Orchestra",
    ]);
    expect(splitArtistCredit("Simon & Garfunkel")).toEqual(["Simon & Garfunkel"]);
    expect(splitArtistCredit("Earth, Wind & Fire")).toEqual(["Earth, Wind & Fire"]);
  });

  it("splits on a spaced slash but not a bare one", () => {
    expect(splitArtistCredit("Aphex Twin / Squarepusher")).toEqual(["Aphex Twin", "Squarepusher"]);
    expect(splitArtistCredit("AC/DC")).toEqual(["AC/DC"]);
  });

  it("splits feature clauses in every spelling", () => {
    expect(splitArtistCredit("Kendrick Lamar feat. SZA")).toEqual(["Kendrick Lamar", "SZA"]);
    expect(splitArtistCredit("Kendrick Lamar feat SZA")).toEqual(["Kendrick Lamar", "SZA"]);
    expect(splitArtistCredit("Kendrick Lamar ft. SZA")).toEqual(["Kendrick Lamar", "SZA"]);
    expect(splitArtistCredit("Kendrick Lamar FEATURING SZA")).toEqual(["Kendrick Lamar", "SZA"]);
    expect(splitArtistCredit("The Beatles with Billy Preston")).toEqual([
      "The Beatles",
      "Billy Preston",
    ]);
  });

  it("splits a bracketed feature clause without leaving brackets behind", () => {
    expect(splitArtistCredit("The Roots (feat. Erykah Badu)")).toEqual(["The Roots", "Erykah Badu"]);
    expect(splitArtistCredit("The Roots [ft. Erykah Badu]")).toEqual(["The Roots", "Erykah Badu"]);
  });

  // Folding bracketed clauses before splitting, rather than trimming stray
  // brackets after, is what makes this pass.
  it("leaves a name whose own brackets are unbalanced alone", () => {
    expect(splitArtistCredit("Sunn O)))")).toEqual(["Sunn O)))"]);
    expect(splitArtistCredit("Sunn O))) feat. Scott Walker")).toEqual(["Sunn O)))", "Scott Walker"]);
  });

  it("drops empties and case-insensitive repeats", () => {
    expect(splitArtistCredit("Burial;;Burial ; burial")).toEqual(["Burial"]);
    expect(splitArtistCredit("  ")).toEqual([]);
    expect(splitArtistCredit(null)).toEqual([]);
    expect(splitArtistCredit(undefined)).toEqual([]);
  });
});

describe("extraCreditedArtists", () => {
  it("drops ARTISTS entries that decompose an ensemble the credit keeps whole", () => {
    expect(
      extraCreditedArtists("George Martin and His Orchestra", ["George Martin", "His Orchestra"]),
    ).toEqual([]);
  });

  it("drops ARTISTS entries the credit already splits into", () => {
    expect(extraCreditedArtists("JPEGMAFIA; Danny Brown", ["JPEGMAFIA", "Danny Brown"])).toEqual([]);
    expect(extraCreditedArtists("The Beatles with Billy Preston", ["The Beatles", "Billy Preston"])).toEqual(
      [],
    );
  });

  it("keeps a genuine featured credit the ARTIST tag never mentions", () => {
    expect(extraCreditedArtists("JPEGMAFIA", ["JPEGMAFIA", "Danny Brown"])).toEqual(["Danny Brown"]);
  });

  // "air" sits inside "Fairport" — a raw substring test would swallow a real
  // featured artist.
  it("matches whole names, not substrings", () => {
    expect(extraCreditedArtists("Fairport Convention", ["Fairport Convention", "Air"])).toEqual(["Air"]);
  });

  it("handles missing or empty ARTISTS", () => {
    expect(extraCreditedArtists("The Beatles", null)).toEqual([]);
    expect(extraCreditedArtists("The Beatles", [])).toEqual([]);
    expect(extraCreditedArtists(null, ["Someone"])).toEqual(["Someone"]);
  });
});
