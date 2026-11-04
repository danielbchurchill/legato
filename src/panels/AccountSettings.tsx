import { useRef, useState } from 'react'
import { AccountAvatar } from '../auth/AccountAvatar'
import { announceAccountChanged, canEditProfile, useAccount, type AccountUser } from '../auth/accountContext'
import { signOut } from '../auth/useAuth'
import { API_BASE as API, RELAY_SERVER_ID, SERVER_ORIGIN } from '../config/serverHost'
import { openConnectScreen } from '../connect/openConnect'
import { useWsEvent } from '../hooks/useWs'
import { Button } from '../ui/Button'
import { Shimmer } from '../ui/Skeleton'
import { TextField } from '../ui/TextField'
import { useTouchLayout } from '../ui/touchLayout'
import { LegatoAccountRow } from './LegatoAccountRow'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'

/* The Account panel's cards (#470), which the rail's avatar opens on the
 * desktop and the account row at the top of Settings pushes on the phone:
 * who you are on this server, with your picture and name to change, and
 * the way out; then legato.fm (LegatoAccountRow.tsx): its sign-in, linking
 * this server, and devices. Both used to sit at the foot of Settings.
 *
 * A picture you upload stays on the home server. The one legato.fm sends
 * for a linked server is the server's own copy, so this device never loads
 * it from Google or GitHub (accountContext.ts's pictureUrl). */

// server/src/routes/account.ts's bounds.
const MAX_NAME_LENGTH = 200
const MAX_PICTURE_BYTES = 20 * 1024 * 1024

async function failureOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `The server answered ${res.status}.`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function AccountSettings() {
  const touch = useTouchLayout()
  // A picture legato.fm sends lands after the link that brought it has
  // been answered, and another device can change the name; the server says
  // so on the socket, and the rail follows.
  useWsEvent(['account:changed'], announceAccountChanged)
  return (
    <div className={touch ? 'flex flex-col' : 'flex flex-col gap-[10px]'}>
      <ProfileGroup />
      <LegatoAccountRow />
    </div>
  )
}

/* Who this device is signed in to the server as. */
function ProfileGroup() {
  const user = useAccount()
  const touch = useTouchLayout()
  const [error, setError] = useState<string | null>(null)
  const name = user?.displayName ?? user?.email ?? (user?.role === 'owner' ? 'owner' : 'signed in')
  const role = user?.role === 'owner' ? "this server's owner" : `signed in with ${user?.provider ?? 'unknown'}`
  const editable = canEditProfile(user)
  return (
    <SettingsGroup title="account">
      <div className="flex items-center gap-[14px]">
        <AccountAvatar user={user} size="panel" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-heading text-[var(--color-ink)]" title={name}>
            {name}
          </p>
          <p className="text-small text-[var(--color-ink-2)]">
            {role}
            {user?.picture?.source === 'legato' && <span className="block">picture from legato.fm</span>}
          </p>
          {editable && <PictureButtons user={user} onError={setError} />}
        </div>
      </div>
      {editable && <NameField user={user} onError={setError} />}
      {error && (
        <p role="alert" className="text-small text-[var(--color-ink-2)]">
          {error}
        </p>
      )}
      {/* The phone's Settings has the server and the way to another under
       * library already. */}
      {!touch && <ServerRow />}
      <div className="flex">
        <Button onClick={() => void signOut()}>sign out</Button>
      </div>
    </SettingsGroup>
  )
}

/* Upload a picture, change it, or remove it, which shows legato.fm's again
 * if there is one. */
function PictureButtons({ user, onError }: { user: AccountUser; onError: (message: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const uploaded = user.picture?.source === 'upload'

  const send = async (kind: 'upload' | 'remove', init: RequestInit) => {
    onError(null)
    setBusy(kind)
    try {
      const res = await fetch(`${API}/account/picture`, init)
      if (!res.ok) throw new Error(await failureOf(res))
      announceAccountChanged()
    } catch (err) {
      onError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const upload = (file: File) => {
    if (!file.type.startsWith('image/')) return onError("That file isn't a picture. Pick a JPEG or PNG.")
    if (file.size > MAX_PICTURE_BYTES) return onError('That picture is too big. Pick one under 20 MB.')
    void send('upload', { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
  }

  return (
    <div className="flex flex-wrap items-center gap-x-[14px] pt-[2px]">
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        aria-label="Choose a picture"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Cleared, so choosing the same file again still uploads it.
          event.target.value = ''
          if (file) upload(file)
        }}
      />
      <Button size="sm" onClick={() => input.current?.click()} disabled={busy !== null}>
        {busy === 'upload' ? <Shimmer>uploading…</Shimmer> : uploaded ? 'change picture' : 'upload picture'}
      </Button>
      {uploaded && (
        <Button size="sm" onClick={() => void send('remove', { method: 'DELETE' })} disabled={busy !== null}>
          {busy === 'remove' ? <Shimmer>removing…</Shimmer> : 'remove'}
        </Button>
      )}
    </div>
  )
}

/* The name the initials and every greeting use. Saved on Enter or when the
 * field loses the focus; Escape puts it back. */
function NameField({ user, onError }: { user: AccountUser; onError: (message: string | null) => void }) {
  const touch = useTouchLayout()
  const saved = user.displayName ?? ''
  // An edit remembers the name it started from. Once the server's name is
  // something else, the edit is spent: either it was saved, and the new
  // name is showing, or another device renamed this user meanwhile.
  const [edit, setEdit] = useState<{ text: string; from: string } | null>(null)
  const editing = edit !== null && edit.from === saved
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!editing || saving) return
    const next = edit.text.trim()
    if (next === saved) return setEdit(null)
    onError(null)
    setSaving(true)
    try {
      const res = await fetch(`${API}/account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: next }),
      })
      if (!res.ok) throw new Error(await failureOf(res))
      announceAccountChanged()
    } catch (err) {
      onError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow label="Name" align="start">
      <TextField
        prose
        label="Your name"
        placeholder="your name"
        value={editing ? edit.text : saved}
        onChange={(text) => setEdit({ text, from: saved })}
        onEnter={() => void save()}
        onBlur={() => void save()}
        onEscape={() => setEdit(null)}
        maxLength={MAX_NAME_LENGTH}
        size={touch ? 'lg' : 'md'}
      />
    </SettingsRow>
  )
}

/* #117: which server this is, and the way to another. */
function ServerRow() {
  return (
    <div className="flex items-center justify-between gap-[var(--spacing-sm)]">
      <p className="min-w-0 truncate text-small text-[var(--color-ink-2)]" title={SERVER_ORIGIN}>
        {RELAY_SERVER_ID ? (
          'through legato.fm'
        ) : (
          <>
            on <span className="mono">{new URL(SERVER_ORIGIN).host}</span>
          </>
        )}
      </p>
      <Button onClick={() => openConnectScreen()}>change server</Button>
    </div>
  )
}
