import { useEffect, useState } from 'react'

/* The phone layout's test (Legato Mobile v2): a viewport at most 600px
 * wide. The desktop app's narrowest window is 1100px, so it never matches.
 * The map reads this only when its shell doesn't say which layout it is. */
export const PHONE_WIDTH_QUERY = '(max-width: 600px)'

function matches(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_WIDTH_QUERY).matches
}

export function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(PHONE_WIDTH_QUERY)
    const onChange = () => setPhone(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return phone
}
