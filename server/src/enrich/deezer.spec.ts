import { describe, expect, it } from "bun:test";
import { deezerCoverUrl, isPlaceholderImageUrl, parseDeezerAlbums, pickArtistImageUrl } from "./deezer.js";

// Both URL shapes are verbatim from live responses — the real one for Genesis
// Owusu, the placeholder one for "The Beatles With Billy Preston (Karaoke)".
const REAL = "https://cdn-images.dzcdn.net/images/artist/e65bf9bd67bd94e684955799c6a10e3a/1000x1000-000000-80-0-0.jpg";
const PLACEHOLDER = "https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg";

describe("isPlaceholderImageUrl", () => {
  it("recognises the missing-image URL by its empty path segment", () => {
    expect(isPlaceholderImageUrl(PLACEHOLDER)).toBe(true);
  });

  it("passes a real image URL through", () => {
    expect(isPlaceholderImageUrl(REAL)).toBe(false);
  });
});

describe("pickArtistImageUrl", () => {
  it("takes the result whose name matches, not simply the first one", () => {
    const url = pickArtistImageUrl("Pussy Riot", [
      { name: "Pussyfoot", picture_xl: PLACEHOLDER.replace("artist//", "artist/aaa/") },
      { name: "Pussy Riot", picture_xl: REAL },
    ]);
    expect(url).toBe(REAL);
  });

  it("returns nothing when no result names the same artist", () => {
    expect(pickArtistImageUrl("Pussy Riot", [{ name: "Pussyfoot", picture_xl: REAL }])).toBeNull();
  });

  // Deezer answers 200 with a grey silhouette for an artist it has no photo
  // of. Storing that would both show a stock outline and mark the node as
  // having art, so it would never be looked at again.
  it("treats a matched artist with only a placeholder as having no image", () => {
    expect(pickArtistImageUrl("Genesis Owusu", [{ name: "Genesis Owusu", picture_xl: PLACEHOLDER }])).toBeNull();
  });

  // The matched artist's *own* answer is final: a lower-ranked artist who
  // happens to normalize the same way is not a substitute for the one Deezer
  // ranked first.
  it("does not fall through to a later result after matching one without a photo", () => {
    const url = pickArtistImageUrl("Nirvana", [
      { name: "Nirvana", picture_xl: PLACEHOLDER },
      { name: "Nirvana", picture_xl: REAL },
    ]);
    expect(url).toBeNull();
  });

  it("skips results missing a name or an image entirely", () => {
    expect(pickArtistImageUrl("Genesis Owusu", [{}, { name: "Genesis Owusu" }, { picture_xl: REAL }])).toBeNull();
  });

  it("returns nothing for an empty result set", () => {
    expect(pickArtistImageUrl("Genesis Owusu", [])).toBeNull();
  });
});

// Issue #461: album search results, trimmed from a live answer for
// artist:"Fleetwood Mac" album:"Rumours".
describe("parseDeezerAlbums", () => {
  it("reads each album's id, title, artist and cover md5", () => {
    const albums = parseDeezerAlbums({
      data: [
        {
          id: 6612817,
          title: "Rumours (Super Deluxe)",
          md5_image: "0199f3f00d23ed0916cf748d9b5d5030",
          record_type: "album",
          nb_tracks: 58,
          artist: { name: "Fleetwood Mac" },
        },
      ],
    });
    expect(albums).toEqual([
      {
        id: 6612817,
        title: "Rumours (Super Deluxe)",
        artist: "Fleetwood Mac",
        md5: "0199f3f00d23ed0916cf748d9b5d5030",
        recordType: "album",
        tracks: 58,
      },
    ]);
  });

  // The album twin of the artist placeholder: no md5, and a cover URL with
  // an empty path segment, which serves a grey square.
  it("leaves out an album with no cover", () => {
    const albums = parseDeezerAlbums({
      data: [{ id: 1, title: "Untitled", md5_image: "", cover_xl: "https://cdn-images.dzcdn.net/images/cover//1000x1000-000000-80-0-0.jpg" }],
    });
    expect(albums).toEqual([]);
  });
});

describe("deezerCoverUrl", () => {
  it("names the size the CDN serves under the md5", () => {
    expect(deezerCoverUrl("9732751ce91d786dcf30069853697078", 1000)).toBe(
      "https://cdn-images.dzcdn.net/images/cover/9732751ce91d786dcf30069853697078/1000x1000-000000-80-0-0.jpg",
    );
  });
});
