import { useState } from 'react'
import { IconButton } from '../ui/IconButton'
import { Tooltip } from '../ui/Tooltip'
import { dismissDesktopUpdate, releasePage, restartToUpdate, useDesktopUpdate, type DesktopUpdate } from './desktopUpdate'
import { PILL_ACTION, ServerUpdatePill, UpdatePillFrame } from './ServerUpdateNotice'

const RESTART_HINT = 'Restarts Legato and its server, so anything playing from this computer stops for a moment'

/* The update pill's one place under the capsule (#405) holds one notice at
 * a time. The desktop app's own update (#129) goes first: it's the one this
 * window can act on. A newer server release, which the app may be offered
 * by a server elsewhere, shows once that's dismissed or installed. The
 * app's own server never offers one, since it skips the release check
 * (server/src/update/installChannel.ts, channel desktop). */
export function UpdatePill({ hidden }: { hidden: boolean }) {
  const update = useDesktopUpdate()
  return update ? <DesktopUpdatePill update={update} hidden={hidden} /> : <ServerUpdatePill hidden={hidden} />
}

/* "Legato 0.3.0 is available — restart to update". The update has already
 * downloaded and its signature checked (src-tauri/src/updater.rs), so the
 * click installs and restarts at once. Nothing restarts without that click:
 * it stops the server any phones are playing from. A .deb, which its
 * package manager updates, links to the release instead, and so does an
 * update that didn't install. × hides that release on this device until a
 * newer one, as the server's pill does. */
function DesktopUpdatePill({ update, hidden }: { update: DesktopUpdate; hidden: boolean }) {
  const [restart, setRestart] = useState<'idle' | 'restarting' | 'failed'>('idle')
  const link = update.action.kind === 'link' ? update.action.url : restart === 'failed' ? releasePage(update.version) : null

  const onRestart = () => {
    setRestart('restarting')
    restartToUpdate().catch(() => setRestart('failed'))
  }

  return (
    <UpdatePillFrame hidden={hidden}>
      <span className="min-w-0 select-text">
        Legato {update.version} {restart === 'failed' ? "didn't install" : 'is available'} —{' '}
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className={PILL_ACTION}>
            download the latest release
          </a>
        ) : (
          <Tooltip label={RESTART_HINT}>
            <button
              type="button"
              className={`${PILL_ACTION} disabled:no-underline`}
              aria-description={RESTART_HINT}
              disabled={restart === 'restarting'}
              onClick={onRestart}
            >
              {restart === 'restarting' ? 'restarting…' : 'restart to update'}
            </button>
          </Tooltip>
        )}
      </span>
      <IconButton
        icon="cancel"
        label="Dismiss until a newer release"
        size={24}
        tone="ink-3"
        round
        className="-my-[2px]"
        onClick={() => dismissDesktopUpdate(update.version)}
      />
    </UpdatePillFrame>
  )
}
