import { useState } from 'react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Mosaic } from '../ui/Mosaic'
import { PlayCircle } from '../ui/PlayCircle'
import { Popover } from '../ui/Popover'
import { SectionLabel } from '../ui/SectionLabel'
import { Tabs } from '../ui/Tabs'
import { TextField } from '../ui/TextField'
import { formatHoursMinutes, plural } from '../ui/format'
import { PanelHeader } from '../shell/SidePanel'
import type { LeftView } from '../shell/panels'
import type { usePlayback } from '../playback/usePlayback'
import {
  createPlaylist,
  totalDuration,
  useFavourites,
  usePlaylists,
  usePlaylistTracks,
  type Favourite,
  type PlaylistSummary,
} from './collectionsData'
import { PlaylistPage } from './PlaylistPage'
import { ImportPlaylist } from './ImportPlaylist'

/* Collections: everything the listener made — playlists and favourites —
 * in one panel, where they used to be two rail destinations. A playlist
 * and the import flow open as pages inside it, with a way back. */

type Filter = 'all' | 'playlists' | 'favourites'

const FILTERS = [
  { value: 'all', label: 'all' },
  { value: 'playlists', label: 'playlists' },
  { value: 'favourites', label: 'favourites' },
] as const satisfies readonly { value: Filter; label: string }[]

const FAVOURITES_PREVIEW = 8

type CollectionsPanelProps = {
  view: LeftView
  onNavigate: (view: LeftView | null) => void
  onFocusNode: (id: number) => void
  playback: ReturnType<typeof usePlayback>
}

export function CollectionsPanel({ view, onNavigate, onFocusNode, playback }: CollectionsPanelProps) {
  if (view.kind === 'playlist') {
    return (
      <PlaylistPage
        playlistId={view.playlistId}
        onBack={() => onNavigate({ kind: 'collections' })}
        onFocusNode={onFocusNode}
        playback={playback}
      />
    )
  }
  if (view.kind === 'import') {
    return (
      <ImportPlaylist
        onBack={() => onNavigate({ kind: 'collections' })}
        onOpenPlaylist={(playlistId) => onNavigate({ kind: 'playlist', playlistId })}
      />
    )
  }
  return <CollectionsHome onNavigate={onNavigate} onFocusNode={onFocusNode} playback={playback} />
}

function CollectionsHome({ onNavigate, onFocusNode, playback }: Omit<CollectionsPanelProps, 'view'>) {
  const { playlists } = usePlaylists()
  const favourites = useFavourites()
  const [filter, setFilter] = useState<Filter>('all')
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState('')

  const startNew = () => {
    setNewName('')
    setNaming(true)
  }
  const create = async () => {
    const name = newName.trim()
    if (!name) return
    const playlist = await createPlaylist(name)
    setNaming(false)
    onNavigate({ kind: 'playlist', playlistId: playlist.id })
  }

  const addMenu = (
    <Popover
      label="Add to collections"
      placement="bottom"
      align="end"
      className="w-[200px] p-[6px]"
      trigger={({ open, ...props }) => <IconButton icon="add" label="New playlist or import" active={open} {...props} />}
    >
      {(close) => (
        <div className="flex flex-col">
          <MenuItem
            onClick={() => {
              close()
              startNew()
            }}
          >
            New playlist
          </MenuItem>
          <MenuItem
            onClick={() => {
              close()
              onNavigate({ kind: 'import' })
            }}
          >
            Import .m3u
          </MenuItem>
        </div>
      )}
    </Popover>
  )

  const loaded = playlists != null && favourites != null
  const empty = loaded && playlists.length === 0 && favourites.length === 0 && !naming

  return (
    <div className="flex flex-col">
      <PanelHeader title="Collections" actions={addMenu} />

      {naming && (
        <form
          className="mt-[14px] flex items-center gap-[8px]"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <TextField
            prose
            autoFocus
            value={newName}
            onChange={setNewName}
            label="New playlist name"
            placeholder="Playlist name"
            onEscape={() => setNaming(false)}
            className="flex-1"
          />
          <Button variant="primary" type="submit" disabled={!newName.trim()}>
            Create
          </Button>
        </form>
      )}

      {empty ? (
        <EmptyCollections onNew={startNew} onImport={() => onNavigate({ kind: 'import' })} />
      ) : (
        <>
          <Tabs label="show" options={FILTERS} value={filter} onChange={setFilter} className="mt-[14px] self-start" />

          {filter !== 'favourites' && playlists != null && (
            <section className="mt-[20px]">
              <SectionLabel count={playlists.length} className="h-[24px]">
                playlists
              </SectionLabel>
              {playlists.length === 0 ? (
                <p className="mt-[6px] text-small text-[var(--color-ink-3)]">No playlists yet.</p>
              ) : (
                <ul className="-mx-[8px] mt-[6px] flex flex-col gap-[2px]">
                  {playlists.map((playlist) => (
                    <PlaylistRow
                      key={playlist.id}
                      playlist={playlist}
                      onOpen={() => onNavigate({ kind: 'playlist', playlistId: playlist.id })}
                      onPlay={() => void playback.playPlaylist(playlist.id)}
                      busy={playback.queueBusy}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {filter !== 'playlists' && favourites != null && (
            <section className="mt-[22px]">
              <SectionLabel
                className="h-[24px]"
                action={
                  filter === 'all' && favourites.length > FAVOURITES_PREVIEW ? (
                    <Button onClick={() => setFilter('favourites')}>see all</Button>
                  ) : undefined
                }
              >
                favourites
              </SectionLabel>
              {favourites.length === 0 ? (
                <p className="mt-[6px] text-small text-[var(--color-ink-3)]">Anything you favourite with ♡ collects here.</p>
              ) : (
                <ul className="mt-[10px] grid grid-cols-4 gap-[10px]">
                  {(filter === 'all' ? favourites.slice(0, FAVOURITES_PREVIEW) : favourites).map((item) => (
                    <FavouriteTile key={item.id} item={item} onOpen={() => onFocusNode(item.id)} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

function MenuItem({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[32px] w-full items-center rounded-[8px] px-[10px] text-left text-[length:var(--text-secondary)] text-[var(--color-ink)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]"
    >
      {children}
    </button>
  )
}

/* A playlist: its mosaic, its name, how much music it holds. The tracks are
 * fetched per row for the mosaic and the length — a library's playlists
 * are tens, not thousands. Hover shows the play button. */
function PlaylistRow({
  playlist,
  onOpen,
  onPlay,
  busy,
}: {
  playlist: PlaylistSummary
  onOpen: () => void
  onPlay: () => void
  busy: boolean
}) {
  const { tracks } = usePlaylistTracks(playlist.id)
  const length = tracks ? ` · ${formatHoursMinutes(totalDuration(tracks))}` : ''
  return (
    <li className="group relative flex items-center gap-[12px] rounded-[12px] px-[8px] py-[6px] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-[12px] text-left">
        <Mosaic nodeIds={(tracks ?? []).slice(0, 4).map((t) => t.id)} size={48} />
        <span className="flex min-w-0 flex-col">
          <span
            title={playlist.name}
            className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
          >
            {playlist.name}
          </span>
          <span className="truncate text-small text-[var(--color-ink-2)]">
            {plural(playlist.track_count, 'track')}
            {length}
          </span>
        </span>
      </button>
      {playlist.track_count > 0 && (
        <span className="opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
          <PlayCircle size={30} label={`Play ${playlist.name}`} onClick={onPlay} disabled={busy} />
        </span>
      )}
    </li>
  )
}

function FavouriteTile({ item, onOpen }: { item: Favourite; onOpen: () => void }) {
  return (
    <li className="min-w-0">
      <button type="button" onClick={onOpen} className="group flex w-full min-w-0 flex-col gap-[6px] text-left" title={item.title}>
        <CoverArt
          nodeId={item.id}
          size="thumb"
          radius={item.type === 'artist' ? 'round' : 'art'}
          alt=""
          className="aspect-square w-full transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] group-hover:-translate-y-[2px]"
        />
        <span className="truncate text-[11px] leading-[14px] text-[var(--color-ink-2)] group-hover:text-[var(--color-ink)]">
          {item.title}
        </span>
      </button>
    </li>
  )
}

function EmptyCollections({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <div className="flex flex-col items-center gap-[10px] px-[12px] pt-[48px] text-center">
      <span aria-hidden="true" className="grid size-[64px] grid-cols-2 overflow-hidden rounded-[10px] shadow-[var(--shadow-art-edge)]">
        <span className="bg-[var(--color-wash-2)]" />
        <span className="bg-[var(--color-wash)]" />
        <span className="bg-[var(--color-wash)]" />
        <span className="bg-[var(--color-wash-2)]" />
      </span>
      <span className="text-heading text-[var(--color-ink)]">No playlists yet</span>
      <span className="text-[length:var(--text-secondary)] leading-[18px] [text-wrap:pretty] text-[var(--color-ink-2)]">
        Start one here, bring one in from another app, or favourite anything with{' '}
        <Icon name="heart" size={13} className="relative top-[2px]" /> and it collects here.
      </span>
      <div className="mt-[6px] flex gap-[8px]">
        <Button variant="primary" onClick={onNew}>
          New playlist
        </Button>
        <Button variant="secondary" onClick={onImport}>
          Import .m3u
        </Button>
      </div>
    </div>
  )
}
