import { useState, type ReactNode } from 'react'
import { BackRow } from '../shell/SidePanel'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { Mosaic } from '../ui/Mosaic'
import { Popover } from '../ui/Popover'
import { TextField } from '../ui/TextField'
import { plural } from '../ui/format'
import { EmptyCollections } from '../panels/CollectionsPanel'
import { ImportPlaylist } from '../panels/ImportPlaylist'
import { PlaylistPage } from '../panels/PlaylistPage'
import {
  createPlaylist,
  useFavourites,
  usePlaylists,
  usePlaylistTracks,
  type Favourite,
  type PlaylistSummary,
} from '../panels/collectionsData'
import type { usePlayback } from '../playback/usePlayback'
import { closeSheetView, openSheetView, useSheetView } from './navigation'

/* The phone's collections tab (#389, Legato Mobile v2 screen 3): the count
 * and a "new" pill, then everything the listener made as a grid of 2×2
 * cover mosaics. Favourites come first, as one collection, when there are
 * any; the playlists follow in the server's order.
 *
 * Favourites, a playlist and the import form open inside the tab, with a
 * way back. They're history entries (navigation.ts), so Android's back
 * gesture and the browser's back leave them too. A playlist and the import
 * form are the desktop's own pages: the handoff draws neither. "new" offers
 * what the desktop's add menu does, a new playlist or an imported one, and
 * a new playlist opens once it's named.
 *
 * Like the library tab, the grid scrolls in its own scroller under the
 * count, over the sheet's whole body. */

type Playback = ReturnType<typeof usePlayback>

/* A 36px button's 44px target. */
const TARGET = "relative before:absolute before:inset-x-0 before:-inset-y-[4px] before:content-['']"

type PhoneCollectionsProps = {
  onOpenNode: (id: number) => void
  playback: Playback
}

export function PhoneCollections({ onOpenNode, playback }: PhoneCollectionsProps) {
  const view = useSheetView()

  if (view?.kind === 'playlist') {
    return (
      <Page>
        <PlaylistPage playlistId={view.playlistId} onBack={closeSheetView} onFocusNode={onOpenNode} playback={playback} />
      </Page>
    )
  }
  if (view?.kind === 'import') {
    return (
      <Page>
        <ImportPlaylist onBack={closeSheetView} onOpenPlaylist={(playlistId) => openSheetView({ kind: 'playlist', playlistId })} />
      </Page>
    )
  }
  if (view?.kind === 'favourites') return <FavouritesView onOpenNode={onOpenNode} />
  return <CollectionsHome />
}

/* A view opened from the tab, scrolling on its own over the sheet's body. */
function Page({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain px-[20px] pt-[8px] pb-[calc(env(safe-area-inset-bottom)+24px)]">
      {children}
    </div>
  )
}

function CollectionsHome() {
  const { playlists } = usePlaylists()
  const favourites = useFavourites()
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
    openSheetView({ kind: 'playlist', playlistId: playlist.id })
  }
  const startImport = () => openSheetView({ kind: 'import' })

  // Nothing until both have answered, so the count doesn't step.
  if (playlists == null || favourites == null) return null

  const count = playlists.length + (favourites.length > 0 ? 1 : 0)
  const nameForm = naming && (
    <form
      className="flex shrink-0 items-center gap-[8px] px-[16px] pt-[14px]"
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <TextField
        prose
        size="lg"
        autoFocus
        value={newName}
        onChange={setNewName}
        label="New playlist name"
        placeholder="Playlist name"
        onEscape={() => setNaming(false)}
        className="flex-1"
      />
      <Button variant="primary" size="lg" type="submit" disabled={!newName.trim()} className={TARGET}>
        Create
      </Button>
    </form>
  )

  if (count === 0 && !naming) {
    return (
      <div className="absolute inset-0 overflow-y-auto overscroll-contain px-[20px] pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <EmptyCollections large onNew={startNew} onImport={startImport} />
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center justify-between pt-[14px] pr-[16px] pl-[20px]">
        <span className="text-small text-[var(--color-ink-2)]">{plural(count, 'collection')}</span>
        <NewMenu onNew={startNew} onImport={startImport} />
      </div>
      {nameForm}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[16px] pt-[14px] pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <ul aria-label="Collections" className="grid grid-cols-2 gap-x-[14px] gap-y-[18px]">
          {favourites.length > 0 && (
            <Tile
              name="Favourites"
              count={plural(favourites.length, 'favourite')}
              nodeIds={favourites.slice(0, 4).map((f) => f.id)}
              onOpen={() => openSheetView({ kind: 'favourites' })}
            />
          )}
          {playlists.map((playlist) => (
            <PlaylistTile key={playlist.id} playlist={playlist} />
          ))}
        </ul>
      </div>
    </div>
  )
}

/* "new", the handoff's secondary pill: 36px on --color-wash-2, inside a
 * 44px target. It opens the desktop's add menu. */
function NewMenu({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <Popover
      label="New collection"
      placement="bottom"
      align="end"
      className="w-[200px] p-[6px]"
      trigger={({ open, ...props }) => (
        <button
          type="button"
          {...props}
          className={`relative inline-flex h-[36px] items-center gap-[6px] rounded-full pr-[14px] pl-[10px] text-[length:var(--text-secondary)] leading-none font-medium text-[var(--color-ink)] transition-colors duration-[var(--motion-fast)] before:absolute before:inset-x-0 before:-inset-y-[4px] before:content-[''] ${
            open ? 'bg-[var(--color-line-strong)]' : 'bg-[var(--color-wash-2)]'
          }`}
        >
          <Icon name="add" size={16} />
          new
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col">
          <MenuItem
            onClick={() => {
              close()
              onNew()
            }}
          >
            New playlist
          </MenuItem>
          <MenuItem
            onClick={() => {
              close()
              onImport()
            }}
          >
            Import .m3u
          </MenuItem>
        </div>
      )}
    </Popover>
  )
}

function MenuItem({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[44px] w-full items-center rounded-[8px] px-[10px] text-left text-[length:var(--text-body)] text-[var(--color-ink)]"
    >
      {children}
    </button>
  )
}

/* A collection: its mosaic, radius 10 with 2px between the covers, its
 * name and how much it holds, as the frame draws one. */
function Tile({ name, count, nodeIds, onOpen }: { name: string; count: string; nodeIds: number[]; onOpen: () => void }) {
  return (
    <li className="min-w-0">
      <button type="button" onClick={onOpen} className="flex w-full min-w-0 flex-col gap-[8px] text-left">
        <Mosaic nodeIds={nodeIds} radius={10} gap={2} className="aspect-square w-full" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[length:var(--text-body)] leading-[19px] font-medium text-[var(--color-ink)]">{name}</span>
          <span className="truncate text-small text-[var(--color-ink-2)]">{count}</span>
        </span>
      </button>
    </li>
  )
}

/* A playlist's tracks are fetched per tile for its mosaic, as the desktop's
 * rows fetch them: a library's playlists are tens, not thousands. */
function PlaylistTile({ playlist }: { playlist: PlaylistSummary }) {
  const { tracks } = usePlaylistTracks(playlist.id)
  return (
    <Tile
      name={playlist.name}
      count={plural(playlist.track_count, 'track')}
      nodeIds={(tracks ?? []).slice(0, 4).map((t) => t.id)}
      onOpen={() => openSheetView({ kind: 'playlist', playlistId: playlist.id })}
    />
  )
}

/* ---- Favourites --------------------------------------------------------- */

/* What each favourite is, in the words the library uses. */
const KIND: Record<string, string> = { artist: 'artist', release: 'album', recording: 'track', credit: 'producer' }

function FavouritesView({ onOpenNode }: { onOpenNode: (id: number) => void }) {
  const favourites = useFavourites()
  return (
    <Page>
      <BackRow large label="Collections" onBack={closeSheetView} />
      <h2 className="mt-[8px] text-[22px] leading-[28px] font-medium text-[var(--color-ink)]">Favourites</h2>
      <span className="text-small text-[var(--color-ink-2)]">{favourites ? plural(favourites.length, 'favourite') : ' '}</span>
      {favourites != null &&
        (favourites.length === 0 ? (
          <p className="mt-[16px] text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
            Anything you favourite with ♡ collects here.
          </p>
        ) : (
          // 16px from the sheet's sides, as the library's grid is.
          <ul aria-label="Favourites" className="-mx-[4px] mt-[16px] grid grid-cols-2 gap-x-[14px] gap-y-[16px]">
            {favourites.map((item) => (
              <FavouriteTile key={item.id} item={item} onOpen={() => onOpenNode(item.id)} />
            ))}
          </ul>
        ))}
    </Page>
  )
}

/* The library grid's cell: an artist's photo round, anything else square. */
function FavouriteTile({ item, onOpen }: { item: Favourite; onOpen: () => void }) {
  const round = item.type === 'artist'
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full min-w-0 flex-col gap-[8px] ${round ? 'items-center text-center' : 'text-left'}`}
      >
        <CoverArt
          nodeId={item.id}
          size="thumb"
          radius={round ? 'round' : 'none'}
          className={`aspect-square w-full ${round ? '' : 'rounded-[8px]'}`}
        />
        <span className="flex w-full min-w-0 flex-col">
          <span className="truncate text-[length:var(--text-body)] leading-[19px] font-medium text-[var(--color-ink)]">{item.title}</span>
          <span className="truncate text-small text-[var(--color-ink-2)]">{KIND[item.type] ?? item.type}</span>
        </span>
      </button>
    </li>
  )
}
