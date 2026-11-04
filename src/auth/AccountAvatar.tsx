import { useState } from 'react'
import { initialsFor, pictureUrl, type AccountUser } from './accountContext'

/* The signed-in user as a circle (#470): their picture, or their initials
 * on the raised fill when there isn't one, or it won't load. The rail draws
 * it at 30px, the phone's Settings row at 44 and the Account panel at 64.
 * The picture is the server's own copy, never Google's or GitHub's, so it
 * loads with the media ticket like a cover. Decorative: whatever holds it
 * names the user. */

const SIZES = {
  rail: 'size-[30px] text-[11px]',
  row: 'size-[44px] text-[16px]',
  panel: 'size-[64px] text-[22px]',
} as const

export function AccountAvatar({ user, size }: { user: AccountUser | null; size: keyof typeof SIZES }) {
  const url = pictureUrl(user)
  // The address that failed, so a new picture gets its own try.
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--color-raised)] font-medium text-[var(--color-ink)] select-none ${SIZES[size]}`}
    >
      {url && failed !== url ? (
        <img src={url} alt="" draggable={false} onError={() => setFailed(url)} className="size-full object-cover" />
      ) : (
        initialsFor(user)
      )}
    </span>
  )
}
