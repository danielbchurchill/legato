import { createContext, useContext } from 'react'
import { API_BASE } from '../config/serverHost'
import { withMediaTicket } from './session'
import type { AuthStatus } from './useAuth'

/* The signed-in user, for the chrome that names them: the avatar at the
 * foot of the rail, and the Account panel it opens (#470). Null on a server
 * old enough to run ungated (App.tsx's outOfDate path), which has no user to
 * name. */

export type AccountUser = NonNullable<AuthStatus['user']>

export const AccountContext = createContext<AccountUser | null>(null)

export function useAccount(): AccountUser | null {
  return useContext(AccountContext)
}

/** Fired when the signed-in user's name or picture changed, so useAuth asks
 * the server who they are again and everything showing them follows. */
export const ACCOUNT_CHANGED_EVENT = 'legato:account-changed'

export function announceAccountChanged(): void {
  window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT))
}

/** Up to two initials from a display name, else the email's first letter. */
export function initialsFor(user: AccountUser | null): string {
  const name = user?.displayName?.trim()
  if (name) {
    const words = name.split(/\s+/).filter(Boolean)
    const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2)
    return letters.toUpperCase()
  }
  const email = user?.email?.trim()
  return email ? email[0].toUpperCase() : '·'
}

/** Where an <img> loads the user's picture from: the server's own copy,
 * uploaded or fetched from legato.fm, with the media ticket. Null when
 * there's none, and from a server too old to say. */
export function pictureUrl(user: AccountUser | null): string | null {
  const hash = user?.picture?.hash
  return hash ? withMediaTicket(`${API_BASE}/account/pictures/${hash}`) : null
}

/** Whether the server can change the name and picture: one that can says
 * what the picture is, even when there's none. */
export function canEditProfile(user: AccountUser | null): user is AccountUser {
  return user != null && user.picture !== undefined
}
