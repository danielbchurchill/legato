// Test-only: a small library for #468's specs, built straight into the
// tables a scan and recompute would fill, without tags or a scan. Not a
// *.spec.ts, so `bun test` doesn't run it as a suite of its own.
import type { Database } from "../sqlite.js";
import { recomputeEntities } from "../entities/aggregate.js";

export class TestLibrary {
  private root: number;
  private ids = new Map<string, number>();

  constructor(readonly db: Database) {
    this.root = (
      db.prepare("INSERT INTO library_roots (path) VALUES ('/test') RETURNING id").get() as { id: number }
    ).id;
  }

  /** The node of this type and title, made the first time it's asked for. */
  node(type: string, title: string): number {
    const key = `${type}:${title}`;
    let id = this.ids.get(key);
    if (id == null) {
      id = (
        this.db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }
      ).id;
      this.ids.set(key, id);
    }
    return id;
  }

  artist(title: string): number {
    return this.node("artist", title);
  }

  /** Someone credited on a track: the artist of that name if there is one,
   *  as match/edges.ts's findOrCreatePerson finds it (#273), else a credit. */
  person(name: string): number {
    return this.ids.get(`artist:${name}`) ?? this.node("credit", name);
  }

  edge(from: number, to: number, type: string, source = "local"): number {
    return (
      this.db
        .prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, ?) RETURNING id")
        .get(from, to, type, source) as {
        id: number;
      }
    ).id;
  }

  /** An album by `artist`: `tracks` recordings with a file each, on the
   *  label and in the year given, each credited to whoever `credits` names
   *  by edge type ('produced_by': ["George Martin"]). Returns the album id
   *  and its tracks'. */
  album(
    artist: string,
    title: string,
    options: {
      year?: number;
      label?: string;
      tracks?: number;
      credits?: Record<string, string[]>;
      genre?: string[];
      with?: string[];
      featuring?: string[];
      addedAt?: string;
    } = {},
  ): { id: number; tracks: number[] } {
    const album = this.node("release", title);
    if (options.addedAt) this.db.prepare("UPDATE nodes SET created_at = ? WHERE id = ?").run(options.addedAt, album);
    const tracks: number[] = [];
    for (let i = 0; i < (options.tracks ?? 2); i++) {
      const rec = this.node("recording", `${title} ${i + 1}`);
      this.db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(rec);
      this.db
        .prepare(
          `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, duration_ms, genre)
           VALUES (?, ?, ?, datetime('now'), 0, 200000, ?)`,
        )
        .run(rec, this.root, `/test/${rec}.flac`, options.genre ? JSON.stringify(options.genre) : null);
      this.edge(rec, this.artist(artist), "performed_by");
      for (const other of options.with ?? []) this.edge(rec, this.artist(other), "performed_by");
      for (const guest of options.featuring ?? []) this.edge(rec, this.artist(guest), "featured_artist");
      this.edge(rec, album, "appears_on");
      if (options.label) this.edge(rec, this.node("label", options.label), "released_on");
      if (options.year) this.edge(rec, this.node("year", String(options.year)), "released_in");
      for (const [type, people] of Object.entries(options.credits ?? {})) {
        for (const person of people) this.edge(rec, this.person(person), type);
      }
      tracks.push(rec);
    }
    return { id: album, tracks };
  }

  /** `member` is in `group`. Either may be one of your artists. */
  member(member: string, group: string): number {
    return this.edge(this.artist(member), this.artist(group), "member_of", "musicbrainz");
  }

  /** `times` plays of `rec`, `daysAgo` days ago. */
  play(rec: number, times = 1, daysAgo = 0): void {
    const file = this.db.prepare("SELECT id FROM files WHERE recording_node_id = ?").get(rec) as { id: number };
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    for (let i = 0; i < times; i++) {
      this.db
        .prepare("INSERT INTO plays (recording_node_id, file_id, started_at, ms_played) VALUES (?, ?, ?, 200000)")
        .run(rec, file.id, at);
    }
  }

  /** The albums and artists tables, as a recompute fills them. */
  aggregate(): void {
    recomputeEntities(this.db);
  }
}

/** The library most of #468's specs read. The Beatles and George Harrison
 *  share him, and Apple; Harrison, Bob Dylan and Tom Petty are Traveling
 *  Wilburys, whose records Jeff Lynne produced, as he did Harrison's and
 *  Petty's; Dylan and Johnny Cash recorded together, and share Columbia;
 *  Nick Drake and Vashti Bunyan are folk singers of the early seventies
 *  with nobody in common, with each other or anyone. */
export function wilburysLibrary(db: Database) {
  const lib = new TestLibrary(db);
  for (const member of ["George Harrison", "John Lennon"]) lib.member(member, "The Beatles");
  for (const member of ["George Harrison", "Bob Dylan", "Tom Petty", "Roy Orbison", "Jeff Lynne"])
    lib.member(member, "Traveling Wilburys");
  const abbeyRoad = lib.album("The Beatles", "Abbey Road", {
    year: 1969,
    label: "Apple",
    credits: { produced_by: ["George Martin"] },
    genre: ["rock"],
  });
  const allThings = lib.album("George Harrison", "All Things Must Pass", {
    year: 1970,
    label: "Apple",
    credits: { produced_by: ["Phil Spector"] },
    genre: ["rock"],
  });
  const cloudNine = lib.album("George Harrison", "Cloud Nine", {
    year: 1987,
    label: "Dark Horse",
    credits: { produced_by: ["Jeff Lynne"] },
    genre: ["rock"],
  });
  const vol1 = lib.album("Traveling Wilburys", "Vol. 1", {
    year: 1988,
    label: "Wilbury",
    credits: { produced_by: ["Jeff Lynne", "George Harrison"] },
    genre: ["rock"],
  });
  const blonde = lib.album("Bob Dylan", "Blonde on Blonde", { year: 1966, label: "Columbia", genre: ["folk rock"] });
  const nashville = lib.album("Bob Dylan", "Nashville Skyline", {
    year: 1969,
    label: "Columbia",
    tracks: 1,
    with: ["Johnny Cash"],
    genre: ["folk rock"],
  });
  const timeOut = lib.album("Bob Dylan", "Time Out of Mind", { year: 1997, label: "Columbia", genre: ["folk rock"] });
  const fullMoon = lib.album("Tom Petty", "Full Moon Fever", {
    year: 1989,
    label: "MCA",
    credits: { produced_by: ["Jeff Lynne"] },
    genre: ["rock"],
  });
  const folsom = lib.album("Johnny Cash", "At Folsom Prison", { year: 1968, label: "Columbia", genre: ["country"] });
  const pinkMoon = lib.album("Nick Drake", "Pink Moon", {
    year: 1972,
    label: "Island",
    credits: { produced_by: ["John Wood"] },
    genre: ["folk"],
  });
  const diamondDay = lib.album("Vashti Bunyan", "Just Another Diamond Day", {
    year: 1970,
    label: "Philips",
    genre: ["folk"],
  });
  lib.aggregate();
  return {
    lib,
    albums: {
      abbeyRoad,
      allThings,
      cloudNine,
      vol1,
      blonde,
      nashville,
      timeOut,
      fullMoon,
      folsom,
      pinkMoon,
      diamondDay,
    },
    id: (title: string) => lib.artist(title),
  };
}
