import { useAwayFromHome, type Whereabouts } from '../connect/awayFromHome'
import { neverUseRelay } from '../connect/connectionPath'
import { pathSentence, placeLabel } from '../connect/describeConnection'
import { readLastSeen } from '../connect/lastSeen'
import type { ServerPath } from '../connect/serverPath'
import { SERVER_ORIGIN } from '../config/serverHost'
import { useStreamQuality } from '../playback/useStreamQuality'
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
 * While the server says this device is away from home (#495), the glyph is
 * `globe` and the name "Away from home · original", whatever the path: a
 * Tailscale address counts as the home path even on a train. The popover's
 * heading and sentences say so too (describeConnection.ts).
 *
 * The path and the quality come from the connection-path store
 * (connect/connectionPath.ts) and quality.ts's state, through
 * useStreamQuality, so the indicator changes as they do: a new track, a
 * drop, a new pick in Settings, or a move to another path. The popover
 * reads the rest (the server's name, the pin) as it opens. */

const PATH_ICON: Record<ServerPath, IconName> = {
  embedded: 'computer',
  'this-device': 'computer',
  home: 'home',
  relay: 'cloud',
  custom: 'globe',
}

/** The glyph for the path, or `globe` while this device is away (#495). */
function placeIcon(path: ServerPath, where: Whereabouts): IconName {
  return where === 'away' ? 'globe' : PATH_ICON[path]
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
  const { path, ...quality } = useStreamQuality({ embedded, currentFileId, streaming })
  // The server's home/away answer for this device (#412). The desktop app
  // never asks for it, so there it stays `unknown`.
  const { where } = useAwayFromHome()
  const place = placeLabel(path, where)
  const label = `${place} · ${quality.label}`
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
            <Icon name={placeIcon(path, where)} size={22} />
          </button>
        </Tooltip>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-[6px] text-left">
          <h2 className="text-heading text-[var(--color-ink)]">{place}</h2>
          {/* What the server called itself when it last answered
           * (useServerReady.ts writes it down). */}
          <p className="text-secondary [text-wrap:pretty] text-[var(--color-ink-2)]">
            {pathSentence(path, readLastSeen(SERVER_ORIGIN)?.name ?? null, where)}
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
