import type { Database } from "../sqlite.js";
import { lookupRecording } from "./mbClient.js";
import { applyMatch } from "./worker.js";

// Issue #272: the way out for a recording MusicBrainz couldn't match on its
// own. Nothing was saved to pick from, so the person finds the track on
// musicbrainz.org and pastes its link (or bare MBID) into the maintenance
// view. One lookup confirms the recording exists, and then it goes through
// applyMatch, the same write a confident automatic match and a resolved
// ambiguous one already use.
//
// Recordings only. A release link would mean guessing which of its tracks
// this file is, and assignTracks' duration fallback has no tolerance, so a
// wrong guess would be written as silently as a right one.

const MBID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BARE_MBID = new RegExp(`^${MBID}$`, "i");
// Any musicbrainz.org host (beta., www.), scheme optional, and anything
// after the MBID ignored: the recording page's own tabs (/fingerprints) and
// tracking queries land there too.
const MB_URL = new RegExp(`^(?:https?://)?(?:[a-z0-9-]+\\.)*musicbrainz\\.org/([a-z-]+)/(${MBID})(?:[/?#].*)?$`, "i");

export type MusicBrainzReference = { entity: string; mbid: string };

// A bare MBID is taken to be a recording: that's what this asks for, and if
// it's really a release ID the lookup simply finds no recording.
export function parseMusicBrainzReference(input: string): MusicBrainzReference | null {
  const text = input.trim();
  if (BARE_MBID.test(text)) return { entity: "recording", mbid: text.toLowerCase() };
  const url = MB_URL.exec(text);
  return url ? { entity: url[1].toLowerCase(), mbid: url[2].toLowerCase() } : null;
}

export type ManualMatchResult = { ok: true; mbid: string } | { ok: false; status: 400 | 404 | 422; error: string };

// The error strings are shown on the card as they are.
export async function matchRecordingByHand(db: Database, nodeId: number, input: string): Promise<ManualMatchResult> {
  const reference = parseMusicBrainzReference(input);
  if (!reference) return { ok: false, status: 400, error: "That isn't a MusicBrainz recording link or ID." };
  if (reference.entity === "release" || reference.entity === "release-group") {
    return {
      ok: false,
      status: 422,
      error: "That's a release link. Open the track on that release and paste its recording link.",
    };
  }
  if (reference.entity !== "recording") {
    return { ok: false, status: 422, error: `That links to a MusicBrainz ${reference.entity}, not a recording.` };
  }

  // Throws on a network failure or a MusicBrainz error, which the route
  // reports as such rather than as "no such recording".
  const recording = await lookupRecording(reference.mbid);
  if (!recording) return { ok: false, status: 404, error: "MusicBrainz has no recording with that ID." };

  // Confidence 1: a person looked at it and said so, which is as sure as
  // this pipeline ever gets.
  applyMatch(db, nodeId, recording.mbid, 1);
  return { ok: true, mbid: recording.mbid };
}
