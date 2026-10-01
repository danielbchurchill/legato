import { useState, type FormEvent } from 'react'
import whiteWordmarkSrc from '../assets/brand/white-wordmark.svg'
import blackWordmarkSrc from '../assets/brand/black-wordmark.svg'
import { Centered } from '../LibrarySetup'
import { Button } from '../ui/Button'
import { API_BASE } from '../config/serverHost'
import type { ResolvedTheme } from '../hooks/useTheme'
import type { AuthStatus, SessionResponse } from './useAuth'
import { QrCode } from './QrCode'
import { formatCountdown, useSetupCode } from './useSetupCode'

/* Issue #112: the two screens between "the server answered" and the app.
 * Both take over the whole window, like first-run library setup (DESIGN.md
 * "Empty and error states"): the wordmark, one sentence that says what's
 * true and what to do, and the fields to do it with. */

type Mode = 'create-owner' | 'sign-in'

// Minimum matches server/src/auth/owner.ts. Checked here only to say so
// before the round trip; the server enforces it.
const MIN_PASSWORD_LENGTH = 8

const FIELD_CLASSES =
  'w-full rounded-[var(--radius-control)] border border-[var(--color-hairline)] bg-[var(--color-inset)] px-[12px] py-[8px] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]'

type ErrorBody = { error?: string; reason?: string; retryAfter?: number }

function describeFailure(status: number, body: ErrorBody): string {
  if (status === 429 && body.retryAfter) {
    const wait = body.retryAfter < 90 ? `${body.retryAfter} seconds` : `${Math.ceil(body.retryAfter / 60)} minutes`
    return `Too many attempts. Try again in ${wait}.`
  }
  return body.error ?? `The server returned ${status}.`
}

export function OwnerGate({
  mode,
  status,
  theme,
  onSession,
}: {
  mode: Mode
  status: AuthStatus
  theme: ResolvedTheme
  onSession: (session: SessionResponse) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const creating = mode === 'create-owner'
  // Issue #113: a server set up from another machine shows its setup code
  // right here (the /setup page) when it trusts where this page is, so
  // nobody has to go and read the log.
  const needsCode = creating && status.setupCodeRequired
  const { state: setupCodeState, reload: reloadSetupCode } = useSetupCode(needsCode)
  const shownCode = setupCodeState.kind === 'shown' ? setupCodeState : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (creating && password.length < MIN_PASSWORD_LENGTH) {
      setError(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (creating && password !== confirm) {
      setError("The two passwords don't match. Type the same one in both fields.")
      return
    }

    setBusy(true)
    try {
      const res = await fetch(`${API_BASE}/auth/${creating ? 'owner' : 'sign-in'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          creating
            ? {
                password,
                displayName: displayName || undefined,
                setupCode: (shownCode?.code ?? setupCode) || undefined,
              }
            : { password },
        ),
      })
      const body = (await res.json().catch(() => ({}))) as ErrorBody & SessionResponse
      if (!res.ok) {
        // Expired between reading it and pressing the button: the page
        // fetches the replacement and says so, and the password fields
        // keep what was typed.
        if (body.reason === 'expired_setup_code' && shownCode) {
          void reloadSetupCode()
          setError("That code expired while you were typing. Here's the new one; press create owner again.")
          return
        }
        setError(describeFailure(res.status, body))
        return
      }
      onSession(body)
    } catch {
      setError("Couldn't reach the server. Check it's still running, then try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <img
        src={theme === 'light' ? blackWordmarkSrc : whiteWordmarkSrc}
        alt="legato"
        className="h-[var(--text-wordmark)] w-auto select-none"
      />

      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-[360px] flex-col items-stretch gap-[12px]">
        {creating ? (
          <>
            <p className="text-[length:var(--text-base)] text-[var(--color-ink)]">Create the owner for this server.</p>
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              This server needs an owner account before it can be used. Your library and settings aren't touched.
              The password stays on this server and works without an internet connection.
            </p>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="your name (optional)"
              aria-label="Your name"
              autoComplete="name"
              className={FIELD_CLASSES}
            />
          </>
        ) : (
          <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
            Sign in with this server's owner password.
          </p>
        )}

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          aria-label="Password"
          autoComplete={creating ? 'new-password' : 'current-password'}
          autoFocus
          className={FIELD_CLASSES}
        />
        {creating && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="password again"
            aria-label="Password again"
            autoComplete="new-password"
            className={FIELD_CLASSES}
          />
        )}

        {needsCode && shownCode && (
          <div className="flex flex-col items-center gap-[12px]">
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              {shownCode.replaced ? "That code expired. Here's a new one:" : "This server's setup code:"}
            </p>
            <p
              aria-live="polite"
              className="font-[family-name:var(--font-mono)] text-[length:var(--text-wordmark-header)] tracking-[0.08em] text-[var(--color-ink)]"
            >
              {shownCode.code}
            </p>
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              expires in {formatCountdown(shownCode.remainingMs)}, then a new one appears here
            </p>
          </div>
        )}
        {needsCode && setupCodeState.kind === 'hidden' && (
          <>
            <input
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              placeholder="setup code, like K7QM-4XRD"
              aria-label="Setup code"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD_CLASSES} font-[family-name:var(--font-mono)] uppercase placeholder:normal-case`}
            />
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              You're setting this server up from another machine, so it needs its setup code.{' '}
              {setupCodeState.message} The code changes every ten minutes; the log shows each new one.
            </p>
          </>
        )}

        {error && <p className="text-[length:var(--text-base)] text-[var(--color-ink)]">{error}</p>}

        <div className="flex justify-center">
          <Button type="submit" disabled={busy || !password || (needsCode && setupCodeState.kind === 'loading')}>
            {creating ? 'create owner' : 'sign in'}
          </Button>
        </div>
      </form>

      {/* The legato.fm half of plan 02's claim isn't built yet (see the
       * seam in server/src/index.ts), so the QR sits below the real step,
       * muted, and says plainly that it doesn't work yet. The URL is
       * already the final one, so nothing changes here once it does. */}
      {shownCode && (
        <div className="flex flex-col items-center gap-[8px] pt-[12px]">
          <QrCode value={shownCode.claimUrl} theme={theme} label={`QR code for ${shownCode.claimUrl}`} />
          <p className="max-w-[360px] text-[length:var(--text-base)] text-[var(--color-muted)]">
            Claiming this server for a legato.fm account by scanning this is coming soon. For now, creating the
            owner above is all it needs.
          </p>
        </div>
      )}

      {!status.user && (status.oauth.google || status.oauth.github) && (
        <div className="flex items-center gap-[16px] text-[var(--color-muted)]">
          <span className="text-[length:var(--text-base)]">or, if you used one before:</span>
          {status.oauth.google && (
            <Button onClick={() => window.open(`${API_BASE}/auth/google`, '_blank')}>sign in with google</Button>
          )}
          {status.oauth.github && (
            <Button onClick={() => window.open(`${API_BASE}/auth/github`, '_blank')}>sign in with github</Button>
          )}
        </div>
      )}
    </Centered>
  )
}
