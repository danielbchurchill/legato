import { describe, expect, it } from "bun:test";
import {
  isSameArtist,
  looksLikeMultipleArtists,
  normalizeArtistName,
  pickArtistMatch,
  type ArtistCandidate,
} from "./artistName.js";

describe("looksLikeMultipleArtists", () => {
  // Every one of these is a real artist node in the current library — the
  // tags produced them, and none of them names one artist.
  it("catches the credit lines the real library actually contains", () => {
    expect(looksLikeMultipleArtists("JPEGMAFIA; Danny Brown")).toBe(true);
    expect(looksLikeMultipleArtists("Pussy Riot; Vladimir Putin")).toBe(true);
    expect(looksLikeMultipleArtists("The Beatles with Billy Preston")).toBe(true);
  });

  it("catches the other common credit spellings", () => {
    expect(looksLikeMultipleArtists("Artist feat. Guest")).toBe(true);
    expect(looksLikeMultipleArtists("Artist featuring Guest")).toBe(true);
    expect(looksLikeMultipleArtists("Artist vs. Other")).toBe(true);
    expect(looksLikeMultipleArtists("Artist x Other")).toBe(true);
    expect(looksLikeMultipleArtists("Artist / Other")).toBe(true);
  });

  // The whole reason "&" and " and " are not separators: these are single
  // bands, and treating them as credit lines would strip enrichment from a
  // large, ordinary class of artists.
  it("leaves band names containing 'and' or '&' alone", () => {
    expect(looksLikeMultipleArtists("Peter Bjorn and John")).toBe(false);
    expect(looksLikeMultipleArtists("Simon & Garfunkel")).toBe(false);
    expect(looksLikeMultipleArtists("Nick Cave and the Bad Seeds")).toBe(false);
    expect(looksLikeMultipleArtists("Genesis Owusu")).toBe(false);
  });

  it("does not fire on a separator embedded in a word", () => {
    // "with" as a substring, not as a separator — the padding-and-spaces
    // form of the check is what keeps this from matching.
    expect(looksLikeMultipleArtists("Withered Hand")).toBe(false);
    expect(looksLikeMultipleArtists("Xavier Rudd")).toBe(false);
  });
});

describe("normalizeArtistName", () => {
  it("folds case, accents and punctuation", () => {
    expect(normalizeArtistName("Sigur Rós")).toBe("sigur ros");
    expect(normalizeArtistName("BEYONCÉ")).toBe("beyonce");
    expect(normalizeArtistName("Godspeed You! Black Emperor")).toBe("godspeed you black emperor");
  });

  it("treats a leading article and an ampersand as noise", () => {
    expect(normalizeArtistName("The Beatles")).toBe("beatles");
    expect(normalizeArtistName("Simon & Garfunkel")).toBe(normalizeArtistName("Simon and Garfunkel"));
  });

  it("never drops a word", () => {
    // The distinction the Deezer match depends on: a karaoke act's name
    // contains the artist's name, and must not normalize to it.
    expect(normalizeArtistName("The Beatles With Billy Preston (Karaoke)")).not.toBe(
      normalizeArtistName("The Beatles"),
    );
  });
});

describe("isSameArtist", () => {
  it("matches spellings that differ only cosmetically", () => {
    expect(isSameArtist("the beatles", "The Beatles")).toBe(true);
    expect(isSameArtist("Sigur Ros", "Sigur Rós")).toBe(true);
  });

  it("rejects the near misses a name search returns as top results", () => {
    // Deezer's own second result for "Pussy Riot".
    expect(isSameArtist("Pussy Riot", "Pussyfoot")).toBe(false);
    expect(isSameArtist("The Beatles", "The Beatles With Billy Preston (Karaoke)")).toBe(false);
  });

  it("never matches on an empty local name", () => {
    expect(isSameArtist("", "")).toBe(false);
    expect(isSameArtist("!!!???", "")).toBe(false);
  });
});

describe("pickArtistMatch", () => {
  const candidate = (name: string, score: number, disambiguation: string | null = null): ArtistCandidate => ({
    mbid: `${name}-${score}`,
    name,
    score,
    disambiguation,
  });

  // Verbatim from the live MusicBrainz response for artist:"The Beatles" —
  // four artists share the name exactly, which is what made the original
  // "must be the only match" rule refuse to identify the most obvious band in
  // the library.
  it("picks the clear leader among artists sharing a name", () => {
    const match = pickArtistMatch("The Beatles", [
      candidate("The Beatles", 100, "UK rock band, “The Fab Four”"),
      candidate("The Beatles Revival Band", 60, "German cover band"),
      candidate("The Beatles", 58, "SiIvaGunner collaboration"),
      candidate("The Beatles", 56, "punk/lofi"),
      candidate("The Beatles", 56, "1960s Philadelphia doo-wop group"),
    ]);

    expect(match?.score).toBe(100);
    expect(match?.disambiguation).toContain("Fab Four");
  });

  // The other real case: two bands called Nirvana, 25 points apart. A tag
  // saying "Nirvana" means the one everybody means.
  it("resolves the famous homonym rather than giving up", () => {
    const match = pickArtistMatch("Nirvana", [
      candidate("Nirvana", 100, "1980s–1990s US grunge band"),
      candidate("Nirvana", 75, "60s band from the UK"),
      candidate("Nirvana", 61, "’70s French band from Martigues"),
    ]);
    expect(match?.disambiguation).toContain("grunge");
  });

  it("refuses a genuine tie between two artists of the same name", () => {
    expect(
      pickArtistMatch("Ambiguous", [candidate("Ambiguous", 100, "one"), candidate("Ambiguous", 100, "another")]),
    ).toBeNull();
  });

  it("refuses a lead too narrow to mean anything", () => {
    expect(
      pickArtistMatch("Ambiguous", [candidate("Ambiguous", 100), candidate("Ambiguous", 92)]),
    ).toBeNull();
  });

  it("refuses when even the best match scores poorly", () => {
    expect(pickArtistMatch("Obscure Band", [candidate("Obscure Band", 70)])).toBeNull();
  });

  it("ignores results whose name does not match at all", () => {
    // A high-scoring near miss must not be picked, and must not count as the
    // runner-up that blocks a real match either.
    const match = pickArtistMatch("Pussy Riot", [
      candidate("Pussy Riot", 100, "Russian feminist punk-rock band"),
      candidate("Pussyfoot", 99),
    ]);
    expect(match?.name).toBe("Pussy Riot");
  });

  it("returns null for no candidates", () => {
    expect(pickArtistMatch("Nobody", [])).toBeNull();
  });
});
