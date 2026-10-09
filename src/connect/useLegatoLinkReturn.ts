import { useEffect } from 'react'
import { useToast } from '../ui/toastContext'
import { describeLinkFailure, LINK_CHANGED_EVENT } from './legatoLink'
import { finishBrowserLink, hasLinkReturn } from './legatoLinkReturn'

/* Finishes the web client's link (issue #325) once the owner is signed in,
 * which may be after a sign-in screen if the session ran out while they were
 * on legato.fm. The outcome is a toast, since the page legato.fm came back to
 * is the app, not the Settings panel the link started from; Settings reads
 * the new state when it next draws, or at once if it's open. A failure stays
 * until it's closed, so its reason can be read. When legato.fm couldn't be
 * reached, or asked this address to wait, the code is still good, so the
 * toast offers to try it again; otherwise trying again is the same button in
 * Settings the owner just used. */
export function useLegatoLinkReturn(signedIn: boolean) {
  const toast = useToast()
  useEffect(() => {
    if (!signedIn || !hasLinkReturn()) return
    const finish = () =>
      void finishBrowserLink().then((result) => {
        if (!result) return
        if (result.ok) {
          const { name, email } = result.linked
          toast.show({
            title: 'linked to legato.fm',
            description: `This server is linked to ${name ?? email ?? 'your legato.fm account'}.`,
          })
          window.dispatchEvent(new Event(LINK_CHANGED_EVENT))
          return
        }
        // Their own choice, so it's said and then it goes.
        if (result.failure.step === 'cancelled') {
          toast.show({ title: 'nothing linked', description: describeLinkFailure(result.failure) })
          return
        }
        if (result.failure.step === 'lost') {
          toast.show({ title: "link didn't finish", description: describeLinkFailure(result.failure), duration: null })
          return
        }
        toast.show({
          title: "couldn't link to legato.fm",
          description: describeLinkFailure(result.failure),
          duration: null,
          ...(hasLinkReturn() ? { action: { label: 'try again', onClick: finish } } : {}),
        })
      })
    finish()
  }, [signedIn, toast])
}
