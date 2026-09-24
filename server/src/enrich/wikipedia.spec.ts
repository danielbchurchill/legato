import { describe, expect, it } from "bun:test";
import { WIKIPEDIA_LICENSE, parseSummary, parseWikidataId, parseWikipediaUrl } from "./wikipedia.js";

describe("parseWikidataId", () => {
  // The exact relation URL MusicBrainz returns for Genesis Owusu.
  it("reads the item id out of a wikidata relation URL", () => {
    expect(parseWikidataId("https://www.wikidata.org/wiki/Q70855114")).toBe("Q70855114");
  });

  it("accepts the /entity/ form and bare http", () => {
    expect(parseWikidataId("http://wikidata.org/entity/Q1299")).toBe("Q1299");
  });

  it("returns null for anything else", () => {
    expect(parseWikidataId("https://www.discogs.com/artist/5020458")).toBeNull();
    expect(parseWikidataId("https://www.wikidata.org/wiki/Property:P18")).toBeNull();
  });
});

describe("parseWikipediaUrl", () => {
  it("splits language and title", () => {
    expect(parseWikipediaUrl("https://en.wikipedia.org/wiki/Genesis_Owusu")).toEqual({
      lang: "en",
      title: "Genesis_Owusu",
    });
  });

  it("decodes a percent-escaped title", () => {
    expect(parseWikipediaUrl("https://de.wikipedia.org/wiki/Bl%C3%BCte")).toEqual({ lang: "de", title: "Blüte" });
  });

  it("drops a query string or fragment", () => {
    expect(parseWikipediaUrl("https://en.wikipedia.org/wiki/Revolver_(Beatles_album)#Recording")?.title).toBe(
      "Revolver_(Beatles_album)",
    );
  });

  it("returns null for a non-article URL", () => {
    expect(parseWikipediaUrl("https://en.m.wikipedia.org/w/index.php?title=Foo")).toBeNull();
    expect(parseWikipediaUrl("https://www.wikidata.org/wiki/Q1299")).toBeNull();
  });
});

describe("parseSummary", () => {
  const fallback = "https://en.wikipedia.org/wiki/Please_Please_Me";

  it("keeps the extract and the canonical page URL", () => {
    const description = parseSummary(
      {
        type: "standard",
        extract: "Please Please Me is the debut studio album by English rock band the Beatles.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Please_Please_Me" } },
      },
      "https://en.wikipedia.org/wiki/whatever",
    );

    expect(description).toEqual({
      body: "Please Please Me is the debut studio album by English rock band the Beatles.",
      sourceUrl: "https://en.wikipedia.org/wiki/Please_Please_Me",
      license: WIKIPEDIA_LICENSE,
    });
  });

  it("falls back to the requested URL when the response carries none", () => {
    expect(parseSummary({ type: "standard", extract: "Words." }, fallback)?.sourceUrl).toBe(fallback);
  });

  // "Revolver (disambiguation)" has a perfectly good extract that describes
  // nothing — a list of unrelated things. A redirect can land on one, which is
  // why this is checked on the response rather than on the title going in.
  it("rejects a disambiguation page", () => {
    expect(parseSummary({ type: "disambiguation", extract: "Revolver may refer to:" }, fallback)).toBeNull();
  });

  it("rejects an empty or whitespace-only extract", () => {
    expect(parseSummary({ type: "standard" }, fallback)).toBeNull();
    expect(parseSummary({ type: "standard", extract: "   \n " }, fallback)).toBeNull();
  });

  it("trims the extract", () => {
    expect(parseSummary({ type: "standard", extract: "  Words.\n" }, fallback)?.body).toBe("Words.");
  });
});
