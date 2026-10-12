import { sourceLabel, usePlaylistName } from '../panels/queueSource'
import { performer, release, useNodeDetail, type NodeDetail } from '../panels/useNodeDetail'
import type { usePlayback } from '../playback/usePlayback'

/* What the phone's players say about the track playing (#389): its details,
 * its artist and album, and where the queue came from. The mini player, up
 * next's transport and Now playing all read it, from the same playback
 * state as the desktop's player. */

type Playback = ReturnType<typeof usePlayback>

export type PlayingTrack = {
  nodeId: number | null
  /** The recording's details, once they've arrived for this track. */
  detail: NodeDetail | null
  artist: string | null
  artistId: number | null
  album: string | null
  albumId: number | null
}

/** `graphArtist` is the artist the map's graph names, shown until the
 * track's details arrive. */
export function usePlayingTrack(playback: Playback, graphArtist: string | null): PlayingTrack {
  const nodeId = playback.status.currentRecordingNodeId
  const { node } = useNodeDetail(playback.currentTitle != null ? nodeId : null)
  const detail = node != null && node.id === nodeId ? node : null
  const artist = detail ? performer(detail) : null
  const album = detail ? release(detail) : null
  return {
    nodeId,
    detail,
    artist: artist?.other_title ?? graphArtist,
    artistId: artist?.other_id ?? null,
    album: album?.other_title ?? null,
    albumId: album?.other_id ?? null,
  }
}

/** "Playing from …"'s source: an album, a playlist or the shuffled
 * library, as the desktop's up next names it, or null when the queue came
 * from nowhere in particular. */
export function usePlayingFrom(playback: Playback, album: string | null): string | null {
  const playlistNames = usePlaylistName(playback.queueSource)
  return sourceLabel(playback.queueSource, album, playlistNames)
}
