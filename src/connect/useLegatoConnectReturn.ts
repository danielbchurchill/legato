import { useEffect } from 'react'
import { openConnectScreen } from './openConnect'
import { describeConnectFailure, finishBrowserConnect, hasConnectReturn, noteConnectFailure } from './legatoConnect'

/* Finishes the web client's legato.fm sign-in (issue #365) when the page
 * comes back from legato.fm, and opens the connect screen, where it started:
 * "your servers" then lists this server and how to reach it, or the account
 * section says why the sign-in didn't finish. It needs no server session, so
 * it runs as soon as the app does, signed in to the server or not. */
export function useLegatoConnectReturn(): void {
  useEffect(() => {
    if (!hasConnectReturn()) return
    void finishBrowserConnect().then((result) => {
      if (!result) return
      noteConnectFailure(result.ok ? null : describeConnectFailure(result.failure))
      openConnectScreen('switch')
    })
  }, [])
}
