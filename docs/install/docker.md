# Running the Legato server in Docker

The image is `ghcr.io/danielbchurchill/legato-server`, built for `linux/amd64` and `linux/arm64`: a Synology or Unraid box, a Raspberry Pi 4/5, or any Linux machine with Docker. It holds the compiled server plus Debian's `ffmpeg` and `fpcalc`. Nothing else needs installing on the host.

## Quick start

1. Copy [`docker-compose.yml`](docker-compose.yml) into an empty folder.
2. Find the host user that owns your music and note its ids:

   ```sh
   $ id daniel
   uid=1026(daniel) gid=100(users) ...
   ```

3. Start it, pointing at your library:

   ```sh
   LEGATO_MUSIC_DIR=/volume1/music PUID=1026 PGID=100 docker compose up -d
   ```

   Or put those three lines in a `.env` file next to the compose file (`LEGATO_MUSIC_DIR=/volume1/music`, and so on) and run plain `docker compose up -d`. If your tool doesn't read `.env` files, edit the values straight into the compose file.

4. Open `http://<host>:8899` and add **`/music`** as a library folder. That's the path *inside* the container, whatever the folder is called on the host. The first scan starts on its own.

`LEGATO_HOST_PORT` changes the host port if 8899 is taken. The container always listens on 8899 inside.

## What goes where

| Inside the container | What it is | Mounted from |
|---|---|---|
| `/music` | Your library, **read-only** | `LEGATO_MUSIC_DIR` on the host |
| `/data` | Database, cover art, waveform cache | The `legato-data` named volume |

The server runs as `PUID:PGID`, never as root. On start, the container gives `/data` to that user if it isn't theirs yet (a first start, or after you change `PUID`). `PUID=0` is refused. That user needs read access to every folder in the library. On a Synology, check the shared folder's permissions for that user in Control Panel.

## Adding another folder

Legato can only see folders mounted into its container, so the folder picker lists `/music` and any other mount, nothing else from the host. To add a second library (another drive, a share mounted on the host), add a line under `volumes:` in `docker-compose.yml`, with a path inside the container that's yours to pick:

```yaml
      - "/volume2/more-music:/more-music:ro"
```

then `docker compose up -d` to recreate the container. The new folder shows up in the picker straight away; add it there like the first one.

## Tag write-back needs a read-write library

The library is mounted `:ro`, so Legato can't change a single byte of your music, even by mistake. Scanning, playback, enrichment and the hygiene worklist all work read-only. Only the tag write-back feature writes to files: it saves corrected tags back into your FLACs. With the `:ro` mount, a write-back fails with a read-only filesystem error and leaves the file untouched.

To use write-back, remount the library read-write. In `docker-compose.yml`, remove `:ro` from the end of the music line:

```yaml
      - "${LEGATO_MUSIC_DIR:?...}:/music"
```

then `docker compose up -d` to recreate the container. `PUID:PGID` now also needs *write* permission on the library. Do this only once you have a backup of the library you trust. Put `:ro` back when you're done.

## Upgrading

```sh
docker compose pull && docker compose up -d
```

Database migrations run by themselves on the first start of the new version. Check the log for the version line and the database line:

```sh
docker compose logs legato | head
```

The log shows `legato-server <version> (<git sha>)`, then `database: /data/legato.db (<n> files)`. If the count is 0 when it shouldn't be, the data volume didn't get mounted.

## Backups

Only the database matters. Everything else in `/data` is cache the server rebuilds by itself. Stop the container first so SQLite isn't mid-write:

```sh
docker compose stop
docker compose run --rm --no-deps --entrypoint sh -v "$PWD:/backup" legato -c 'cp /data/legato.db* /backup/'
docker compose start
```

## Building the image yourself

From a checkout of the repo:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --build-context client=. -t legato-server server
```

`server/Dockerfile` explains each stage.
