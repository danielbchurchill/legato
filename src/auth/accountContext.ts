import { createContext, useContext } from 'react'
import type { AuthStatus } from './useAuth'

/* The signed-in user, for the one piece of chrome that names them: the
 * avatar at the foot of the rail. Null on a server old enough to run
 * ungated (App.tsx's outOfDate path), which has no user to name. */

export type AccountUser = NonNullable<AuthStatus['user']>

export const AccountContext = createContext<AccountUser | null>(null)

export function useAccount(): AccountUser | null {
  return useContext(AccountContext)
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
