import { useSyncExternalStore } from 'react'
import { awayLadder, useAwayFromHome } from '../connect/awayFromHome'
import { useConnectionPath } from '../connect/connectionPath'
import { describeQuality } from '../connect/describeConnection'
import { serverPathOf, type ServerPath } from '../connect/serverPath'
import { IS_TAURI } from '../config/runtime'
import { awayCapsQuality, nextStreamQuality, streamQualitySnapshot, subscribeStreamQuality } from './quality'

/* The stream quality as #118's connection indicator names it: "original",
 * "Opus 160 kbps". The rail's indicator puts it in its tooltip, and the
 * phone's Now playing between elapsed and remaining.
 *
 * It follows the connection-path store and quality.ts's state, so it
 * changes as they do: a new track, a drop, a new pick in Settings, a move
 * to another path, or (#412) the server's home/away answer. */
export function useStreamQuality({
  embedded,
  currentFileId,
  streaming,
}: {
  /** The desktop app started this page's server itself. */
  embedded: boolean
  /** The file playing now, if any. Its stream's quality is the one named. */
  currentFileId: number | null
  /** The desktop app is streaming the track playing, its file not being on
   * this computer (#185). */
  streaming: boolean
}): { path: ServerPath; label: string; sentence: string } {
  const connection = useConnectionPath()
  const path = serverPathOf(connection, embedded)
  const stream = useSyncExternalStore(subscribeStreamQuality, streamQualitySnapshot)
  // #412: standard while away moves the next stream as the server's answer
  // or the pick changes.
  const away = awayLadder(useAwayFromHome())
  const quality = describeQuality(
    path,
    // The desktop app plays files from disk (playback.rs), or the original
    // of one that isn't here, never a rung of the ladder.
    IS_TAURI
      ? null
      : {
          playing: stream.last?.fileId === currentFileId ? stream.last.quality : null,
          next: nextStreamQuality(connection),
          preference: stream.preference,
          drops: stream.drops,
          awayCapped: awayCapsQuality({ path: connection, preference: stream.preference, away: away.away, awayPick: away.pick }),
        },
    streaming,
  )
  return { path, ...quality }
}
