/* Any surface can ask for the connect screen (issue #117): the sign-in
 * screen, the "can't reach the server" screen, and Settings. App.tsx
 * listens and shows it over everything else. */

export const OPEN_CONNECT_EVENT = 'legato:open-connect'

export type ConnectReason = 'switch' | 'signed-out' | 'unreachable'

export function openConnectScreen(reason: ConnectReason = 'switch'): void {
  window.dispatchEvent(new CustomEvent<ConnectReason>(OPEN_CONNECT_EVENT, { detail: reason }))
}
