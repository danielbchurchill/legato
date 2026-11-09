import { useId } from 'react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { IconButton } from '../ui/IconButton'
import { NOTICE_CLOSE, NOTICE_PRIMARY, NOTICE_SECONDARY, NOTICE_TITLE, noticeBody } from './awayNotice'
import { NoticeExplanation, NoticeRows } from './AwayNoticeParts'
import type { AwayNoticeView } from './useAwayNotice'

/* The away-from-home notice (#412) in a desktop browser: the app's Dialog,
 * inside the shell rather than over the window, so the wash covers the
 * rail, the panels, the capsule and the map, and the player stays above it,
 * playable and in the focus trap. Centred on the stage. The notice itself
 * takes the focus as it opens, not a button, so a screen reader reads it
 * from its title on; Tab goes close, keep original, standard while away,
 * then the player. */
export function AwayNoticeDialog({ view }: { view: AwayNoticeView }) {
  const rowsId = useId()
  return (
    <Dialog
      layer="shell"
      open={view.open}
      onClose={view.onDismiss}
      initialFocus="surface"
      describedBy={rowsId}
      className="relative w-[420px]"
      title={<span className="block pr-[36px]">{NOTICE_TITLE}</span>}
      description={noticeBody(view.server)}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={view.onKeep}>
            {NOTICE_SECONDARY}
          </Button>
          <Button variant="primary" size="md" onClick={view.onStandard}>
            {NOTICE_PRIMARY}
          </Button>
        </>
      }
    >
      {/* First in the content, so first in the tab order; drawn at the
       * title's right. The wrapper is what's placed: IconButton sits in its
       * tooltip's own positioned box. */}
      <div className="absolute top-[16px] right-[16px]">
        <IconButton icon="cancel" label={NOTICE_CLOSE} size={28} tone="ink-2" onClick={view.onDismiss} />
      </div>
      <div className="flex flex-col gap-[16px]">
        <NoticeRows rows={view.rows} id={rowsId} />
        <NoticeExplanation />
      </div>
    </Dialog>
  )
}
