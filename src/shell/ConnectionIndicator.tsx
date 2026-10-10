import { useSyncExternalStore } from 'react'
import { neverUseRelay, useConnectionPath } from '../connect/connectionPath'
import { describeQuality, PATH_LABEL, pathSentence } from '../connect/describeConnection'
import { readLastSeen } from '../connect/lastSeen'
import { serverPathOf, type ServerPath } from '../connect/serverPath'
import { IS_TAURI } from '../config/runtime'
import { SERVER_ORIGIN } from '../config/serverHost'
import { nextStreamQuality, streamQualitySnapshot, subscribeStreamQuality } from '../playback/quality'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import { railButtonClass } from './railButton'

/* The connection-path indicator (issue #118, plan 03): always on screen, in
 * the rail above Settings, since the rail is the one part of the shell that
 * never goes away. The glyph names the path. Its tooltip, which is also the
 * button's accessible name, adds the stream quality: "Home network ·
 * original". A click or tap opens the explanation: why it's that path, what
 * the quality is and why, and this device's "never use the relay".
 *
 * The path and the quality come from the connection-path store
 * (connect/connectionPath.ts) and quality.ts's state, so the indicator
 * changes as they do: a new track, a drop, a new pick in Settings, or a
 * move to another path. The popover reads the rest (the server's name, the
 * pin) as it opens. */

const PATH_ICON: Record<ServerPath, IconName> = {
  embedded: 'computer',
  'this-device': 'computer',
  home: 'home',
  relay: 'cloud',
  custom: 'globe',
}

type ConnectionIndicatorProps = {
  /** The desktop app started this page's server itself. */
  embedded: boolean
  /** The file playing now, if any. Its stream's quality is the one shown. */
  currentFileId: number | null
  /** The desktop app is streaming the track playing, its file not being on
   * this computer (#185). */
  streaming: boolean
  onOpenSettings: () => void
}

export function ConnectionIndicator({ embedded, currentFileId, streaming, onOpenSettings }: ConnectionIndicatorProps) {
  const connection = useConnectionPath()
  const path = serverPathOf(connection, embedded)
  const stream = useSyncExternalStore(subscribeStreamQuality, streamQualitySnapshot)
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
        },
    streaming,
  )
  const label = `${PATH_LABEL[path]} · ${quality.label}`
  // The address is data worth showing where it's the server's own. The
  // desktop app's server and the relay's are implementation details.
  const address = path === 'embedded' || path === 'relay' ? null : new URL(SERVER_ORIGIN).host

  return (
    <Popover
      label="Connection"
      placement="right"
      align="end"
      trigger={({ open, ...trigger }) => (
        <Tooltip label={label} placement="right" disabled={open}>
          <button type="button" aria-label={label} {...trigger} className={railButtonClass(open)}>
            <Icon name={PATH_ICON[path]} size={22} />
          </button>
        </Tooltip>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-[6px] text-left">
          <h2 className="text-heading text-[var(--color-ink)]">{PATH_LABEL[path]}</h2>
          {/* What the server called itself when it last answered
           * (useServerReady.ts writes it down). */}
          <p className="text-secondary [text-wrap:pretty] text-[var(--color-ink-2)]">
            {pathSentence(path, readLastSeen(SERVER_ORIGIN)?.name ?? null)}
          </p>
          {address && <p className="mono text-[var(--color-ink-3)]">{address}</p>}
          <p className="text-secondary [text-wrap:pretty] text-[var(--color-ink-2)]">{quality.sentence}</p>
          {neverUseRelay() && (
            <p className="text-secondary [text-wrap:pretty] text-[var(--color-ink-3)]">This device never uses legato.fm's relay.</p>
          )}
          <Button
            className="self-start pt-[4px]"
            onClick={() => {
              close()
              onOpenSettings()
            }}
          >
            settings
          </Button>
        </div>
      )}
    </Popover>
  )
}
