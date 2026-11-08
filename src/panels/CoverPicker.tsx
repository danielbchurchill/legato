import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { withMediaTicket } from '../auth/session'
import { Button } from '../ui/Button'
import { coverChanged, coverChanging } from '../ui/coverVersion'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { SectionLabel } from '../ui/SectionLabel'
import { Skeleton } from '../ui/Skeleton'
import { Spinner } from '../ui/Spinner'
import { TouchLayoutContext } from '../ui/touchLayout'
import { plural } from '../ui/format'
import { API } from './useNodeDetail'

/* Choosing an album's cover (#461), the way SteamGridDB lets you choose a
 * game's art: every image the Cover Art Archive holds for the album's
 * editions, Deezer's covers for it, or your own image. Whatever's chosen is
 * kept by the server as the album's manual cover, above every automatic
 * one, and nothing is written into the music files. "Use the automatic
 * cover" takes the choice away again.
 *
 * Everything goes through this device's own server
 * (server/src/routes/cover.ts): the server looks the album up and proxies
 * the thumbnails, so a phone through legato.fm works the same, and no device
 * talks to the Cover Art Archive or Deezer itself. It looks anything up only
 * while this is open, and with "Look up metadata online" off it offers the
 * upload alone. */

type PickerState = {
  online: boolean
  searchable: boolean
  manual: boolean
  title: string | null
  artist: string | null
  /** The nodes showing this cover, asked for again after a change. */
  nodeIds: number[]
}

type Source = 'caa' | 'deezer'

export type CoverCandidate = { id: string; source: Source; kind: string; edition: string }

type CandidateList = {
  source: Source
  match: { title: string; artist: string | null } | null
  candidates: CoverCandidate[]
  more: number
}

type SourceState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; list: CandidateList; loadingMore: boolean; moreFailed: boolean }

const SOURCE_LABEL: Record<Source, string> = { caa: 'cover art archive', deezer: 'deezer' }
const SOURCE_NAME: Record<Source, string> = { caa: 'The Cover Art Archive', deezer: 'Deezer' }

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

async function errorOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? null
  } catch {
    return null
  }
}

function candidateThumbUrl(id: string): string {
  return withMediaTicket(`${API}/cover-candidates/${encodeURIComponent(id)}/thumb`)
}

/** What the picker reads and does, for `nodeId`: the album whose cover it
 * changes (a track's panel passes its album). Nothing is fetched until
 * `open`. */
function useCoverPicker(nodeId: number, open: boolean, onDone: () => void) {
  const [state, setState] = useState<PickerState | null>(null)
  const [stateFailed, setStateFailed] = useState(false)
  const [sources, setSources] = useState<Record<Source, SourceState>>({ caa: { status: 'loading' }, deezer: { status: 'loading' } })
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Requests still out when the picker closes are abandoned: the server
  // stops a lookup whose answer nobody is waiting for.
  const aborts = useRef(new Set<AbortController>())

  const request = useCallback((path: string, init?: RequestInit) => {
    const controller = new AbortController()
    aborts.current.add(controller)
    return fetch(`${API}${path}`, { ...init, signal: controller.signal }).finally(() => aborts.current.delete(controller))
  }, [])

  const loadSource = useCallback(
    async (source: Source, all = false) => {
      if (all) setSources((s) => (s[source].status === 'ready' ? { ...s, [source]: { ...s[source], loadingMore: true, moreFailed: false } } : s))
      else setSources((s) => ({ ...s, [source]: { status: 'loading' } }))
      try {
        const res = await request(`/nodes/${nodeId}/cover/candidates?source=${source}${all ? '&all=1' : ''}`)
        if (!res.ok) throw new Error((await errorOf(res)) ?? `${SOURCE_NAME[source]} didn't answer`)
        const list = (await res.json()) as CandidateList
        setSources((s) => ({ ...s, [source]: { status: 'ready', list, loadingMore: false, moreFailed: false } }))
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        if (all) {
          setSources((s) => (s[source].status === 'ready' ? { ...s, [source]: { ...s[source], loadingMore: false, moreFailed: true } } : s))
        } else {
          setSources((s) => ({ ...s, [source]: { status: 'failed', message: `${SOURCE_NAME[source]} didn't answer.` } }))
        }
      }
    },
    [nodeId, request],
  )

  useEffect(() => {
    if (!open) return
    const pending = aborts.current
    // A fresh look each time it opens: the cover may have changed since.
    // oxlint-disable-next-line react/set-state-in-effect
    setState(null)
    setStateFailed(false)
    setProblem(null)
    setBusy(null)
    request(`/nodes/${nodeId}/cover/picker`)
      .then((res) => (res.ok ? (res.json() as Promise<PickerState>) : Promise.reject(new Error())))
      .then((next) => {
        setState(next)
        if (next.online && next.searchable) {
          void loadSource('caa')
          void loadSource('deezer')
        }
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setStateFailed(true)
      })
    return () => {
      for (const controller of pending) controller.abort()
      pending.clear()
    }
  }, [open, nodeId, request, loadSource])

  const finish = (nodeIds: number[]) => {
    coverChanged(nodeId, nodeIds)
    onDone()
  }

  // Every change goes through here, so the cover store knows one is coming
  // and fetches each cover once whichever of the answer and the server's
  // event arrives first (coverVersion.ts).
  const change = async (send: () => Promise<Response>, ok: (res: Response) => boolean) => {
    coverChanging(nodeId)
    let res: Response | null = null
    try {
      res = await send()
      return res
    } finally {
      if (!res || !ok(res)) coverChanged(nodeId, [], false)
    }
  }

  const choose = async (candidate: CoverCandidate) => {
    if (busy) return
    setBusy(candidate.id)
    setProblem(null)
    try {
      const res = await change(
        () =>
          request(`/nodes/${nodeId}/cover/candidate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidate: candidate.id }),
          }),
        (r) => r.ok,
      )
      if (!res.ok) throw new Error((await errorOf(res)) ?? 'the server refused it')
      finish(state?.nodeIds ?? [])
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setProblem(`Couldn't use that image: ${(err as Error).message}.`)
    } finally {
      setBusy(null)
    }
  }

  const upload = async (file: File) => {
    if (busy) return
    setProblem(null)
    if (file.type && !file.type.startsWith('image/')) {
      setProblem(`${file.name} isn't an image.`)
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setProblem('That image is over 20 MB.')
      return
    }
    setBusy('upload')
    try {
      const res = await change(
        () =>
          request(`/nodes/${nodeId}/cover`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'image/jpeg' },
            body: file,
          }),
        (r) => r.ok,
      )
      if (res.status === 400) throw new Error(`Legato couldn't read ${file.name} as an image. Try a JPEG or PNG.`)
      if (res.status === 413) throw new Error('That image is over 20 MB.')
      if (!res.ok) throw new Error("The upload didn't go through. Try again.")
      finish(state?.nodeIds ?? [])
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setProblem((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const reset = async () => {
    if (busy) return
    setBusy('reset')
    setProblem(null)
    try {
      const res = await change(() => request(`/nodes/${nodeId}/cover`, { method: 'DELETE' }), (r) => r.ok)
      // 404: nothing to remove, which is where a reset was going anyway.
      if (!res.ok && res.status !== 404) throw new Error()
      finish(state?.nodeIds ?? [])
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setProblem("Couldn't go back to the automatic cover. Try again.")
    } finally {
      setBusy(null)
    }
  }

  return { state, stateFailed, sources, busy, problem, loadSource, choose, upload, reset }
}

type CoverPickerProps = {
  open: boolean
  onClose: () => void
  /** The album whose cover changes; a track's panel passes its album. */
  nodeId: number
  /** The phone's: 44px targets, the file picker alone, a full-width box. */
  sheet?: boolean
}

export function CoverPicker({ open, onClose, nodeId, sheet = false }: CoverPickerProps) {
  const picker = useCoverPicker(nodeId, open, onClose)
  const { state, stateFailed, sources, busy, problem } = picker
  const title = state?.title
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change cover"
      description={
        title
          ? `For ${title}${state?.artist ? ` by ${state.artist}` : ''}. It's kept in Legato; your music files aren't changed.`
          : "It's kept in Legato; your music files aren't changed."
      }
      className={sheet ? 'w-[calc(100vw-24px)] max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-24px)]!' : 'w-[720px]'}
      footer={
        <>
          {state?.manual && (
            <Button variant="secondary" size={sheet ? 'sheet' : 'md'} disabled={busy != null} onClick={() => void picker.reset()}>
              {busy === 'reset' ? 'Going back…' : 'Use the automatic cover'}
            </Button>
          )}
          <Button variant="secondary" size={sheet ? 'sheet' : 'md'} onClick={onClose}>
            close
          </Button>
        </>
      }
    >
      <TouchLayoutContext.Provider value={sheet}>
        <div className="flex flex-col gap-[20px] pb-[4px]">
          <Upload sheet={sheet} busy={busy === 'upload'} disabled={busy != null} onFile={(file) => void picker.upload(file)} />
          {problem && (
            <p role="alert" className="text-small text-[var(--color-bad)]">
              {problem}
            </p>
          )}
          {stateFailed && <p className="text-small text-[var(--color-ink-2)]">Couldn't reach the server for this album's covers.</p>}
          {state && !state.online && (
            <p className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
              Looking up metadata online is off, so there are no covers from the Cover Art Archive or Deezer to choose from. It's in
              Settings.
            </p>
          )}
          {state && state.online && !state.searchable && (
            <p className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
              Only an album's cover can be looked up, and this track isn't on one.
            </p>
          )}
          {state?.online &&
            state.searchable &&
            (['caa', 'deezer'] as const).map((source) => (
              <SourceSection
                key={source}
                source={source}
                albumTitle={state.title ?? ''}
                state={sources[source]}
                busy={busy}
                sheet={sheet}
                onRetry={() => void picker.loadSource(source)}
                onMore={() => void picker.loadSource(source, true)}
                onChoose={(candidate) => void picker.choose(candidate)}
              />
            ))}
        </div>
      </TouchLayoutContext.Provider>
    </Dialog>
  )
}

/* Your own image: a drop zone on the desktop, which is also the button that
 * opens the file picker, and the file picker alone on a phone. */
function Upload({ sheet, busy, disabled, onFile }: { sheet: boolean; busy: boolean; disabled: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      data-testid="cover-upload-input"
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) onFile(file)
        e.target.value = ''
      }}
    />
  )

  if (sheet) {
    return (
      <div className="flex flex-col gap-[8px]">
        <SectionLabel>your own</SectionLabel>
        <Button variant="secondary" size="sheet" icon="add" className="self-start" disabled={disabled} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading…' : 'Choose an image'}
        </Button>
        {input}
      </div>
    )
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && !disabled) onFile(file)
  }

  return (
    <div className="flex flex-col gap-[8px]">
      <SectionLabel>your own</SectionLabel>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex h-[72px] items-center justify-center gap-[10px] rounded-[var(--radius-card)] border-[1.5px] border-dashed transition-colors duration-[var(--motion-fast)] disabled:opacity-60 ${
          dragging ? 'border-[var(--color-accent)] bg-[var(--color-wash-2)]' : 'border-[var(--color-line-strong)] bg-[var(--color-wash)]'
        }`}
      >
        {busy ? <Spinner size={18} label="Uploading" /> : <Icon name="add" size={18} className="text-[var(--color-ink-2)]" />}
        <span className="text-[length:var(--text-body)] leading-[20px] text-[var(--color-ink)]">
          {busy ? 'Uploading…' : 'Drop an image here'}
          {!busy && <span className="text-[var(--color-ink-2)]"> or </span>}
          {!busy && <span className="font-medium">choose a file</span>}
        </span>
      </button>
      {input}
    </div>
  )
}

function SourceSection({
  source,
  albumTitle,
  state,
  busy,
  sheet,
  onRetry,
  onMore,
  onChoose,
}: {
  source: Source
  albumTitle: string
  state: SourceState
  busy: string | null
  sheet: boolean
  onRetry: () => void
  onMore: () => void
  onChoose: (candidate: CoverCandidate) => void
}) {
  const grid = sheet ? 'grid grid-cols-3 gap-x-[10px] gap-y-[14px]' : 'grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-[14px] gap-y-[16px]'
  const note = 'text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]'
  return (
    <section aria-label={SOURCE_NAME[source]} aria-busy={state.status === 'loading'} className="flex flex-col gap-[10px]">
      <SectionLabel count={state.status === 'ready' && state.list.candidates.length > 0 ? state.list.candidates.length : undefined}>
        {SOURCE_LABEL[source]}
      </SectionLabel>
      {state.status === 'loading' && (
        <div className={grid}>
          {Array.from({ length: sheet ? 3 : 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-[6px]">
              <Skeleton className="aspect-square w-full rounded-[var(--radius-art)]" />
              <Skeleton tone="faint" className="h-[10px] w-[60%] rounded-[5px]" />
            </div>
          ))}
        </div>
      )}
      {state.status === 'failed' && (
        <p className={note}>
          {state.message}{' '}
          <Button size={sheet ? 'sheet' : 'sm'} onClick={onRetry}>
            try again
          </Button>
        </p>
      )}
      {state.status === 'ready' && state.list.match == null && (
        <p className={note}>
          Nothing on {source === 'caa' ? 'the Cover Art Archive' : 'Deezer'} matches {albumTitle || 'this album'}.
        </p>
      )}
      {state.status === 'ready' && state.list.match != null && state.list.candidates.length === 0 && (
        <p className={note}>{SOURCE_NAME[source]} has this album, but no art for it.</p>
      )}
      {state.status === 'ready' && state.list.candidates.length > 0 && (
        <ul className={grid}>
          {state.list.candidates.map((candidate) => (
            <li key={candidate.id}>
              <CandidateTile candidate={candidate} choosing={busy === candidate.id} disabled={busy != null} onChoose={onChoose} />
            </li>
          ))}
        </ul>
      )}
      {state.status === 'ready' && (state.list.more > 0 || state.moreFailed) && (
        <div className="flex items-center gap-[8px]">
          {state.loadingMore ? (
            <span className="flex items-center gap-[8px] text-small text-[var(--color-ink-2)]">
              <Spinner size={14} />
              Listing every edition's images…
            </span>
          ) : (
            <Button size={sheet ? 'sheet' : 'sm'} onClick={onMore}>
              {state.moreFailed ? "Couldn't list them. try again" : `show ${plural(state.list.more, 'more image')}`}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

function CandidateTile({
  candidate,
  choosing,
  disabled,
  onChoose,
}: {
  candidate: CoverCandidate
  choosing: boolean
  disabled: boolean
  onChoose: (candidate: CoverCandidate) => void
}) {
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChoose(candidate)}
      aria-label={`Use the ${candidate.kind} from ${candidate.edition}`}
      title={candidate.edition}
      className="group flex w-full flex-col gap-[6px] text-left disabled:cursor-default"
    >
      <span className="relative block aspect-square w-full rounded-[var(--radius-art)] bg-[var(--color-wash-2)] transition-[translate,box-shadow] duration-[var(--motion-fast)] ease-[var(--ease-out)] group-enabled:group-hover:-translate-y-[3px] group-enabled:group-hover:shadow-[var(--shadow-panel)] motion-reduce:group-hover:translate-y-0">
        {!failed && (
          <img
            src={candidateThumbUrl(candidate.id)}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full rounded-[var(--radius-art)] object-cover"
          />
        )}
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[var(--radius-art)] shadow-[var(--shadow-art-edge)]" />
        {choosing && (
          <span className="absolute inset-0 grid place-items-center">
            <span className="glass grid size-[36px] place-items-center rounded-full text-[var(--color-ink)]">
              <Spinner size={18} label="Using this image" />
            </span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-small text-[var(--color-ink)]">{candidate.kind}</span>
        <span className="truncate text-small text-[var(--color-ink-3)]">{candidate.edition}</span>
      </span>
    </button>
  )
}

/* The details panel's cover, as the way into the picker: a click on it, or
 * Enter on it, opens the picker. On hover or keyboard focus it says so, in
 * a glass pill over the bottom of the art (an icon alone on the 96px cover
 * the other tabs show), which leaves the art itself untouched. */
export function ChangeCover({
  nodeId,
  label,
  compact = false,
  className = '',
  children,
}: {
  /** The album whose cover changes. */
  nodeId: number
  label: string
  compact?: boolean
  className?: string
  /** The cover. */
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" aria-label={label} title={label} onClick={() => setOpen(true)} className={`group/cover relative block shrink-0 rounded-[10px] ${className}`}>
        {children}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute flex opacity-0 transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)] group-hover/cover:opacity-100 group-focus-visible/cover:opacity-100 ${
            compact ? 'right-[6px] bottom-[6px]' : 'inset-x-0 bottom-[12px] justify-center'
          }`}
        >
          <span
            className={`glass flex h-[28px] items-center gap-[6px] rounded-full text-small font-medium text-[var(--color-ink)] shadow-[var(--shadow-sm)] ${
              compact ? 'w-[28px] justify-center' : 'px-[10px]'
            }`}
          >
            <Icon name="pencil" size={14} />
            {!compact && 'change cover'}
          </span>
        </span>
      </button>
      <CoverPicker open={open} onClose={() => setOpen(false)} nodeId={nodeId} />
    </>
  )
}
