# Running the Legato server in Docker

The image is `ghcr.io/danielbchurchill/legato-server`, built for `linux/amd64` and `linux/arm64`: a Synology or Unraid box, a Raspberry Pi 4/5, or any Linux machine with Docker. It holds the compiled server plus Debian's `ffmpeg` and `fpcalc`. Nothing else needs installing on the host.

On a Synology, follow [synology.md](synology.md) instead: it does the same thing through Container Manager's web interface.

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

4. A new server has no owner account yet, so it logs a short setup code, valid for ten minutes and replaced by a new one after that:

   ```sh
   docker compose logs | grep "setup code"
   ```

5. Open `http://<host>:8899/setup` on a computer on your network. The page shows the setup code itself; through a reverse proxy, it asks you to type the one from the log. Create the owner account, a name and a password, then add **`/music`** as a library folder. That's the path *inside* the container, whatever the folder is called on the host. The first scan starts on its own.

`LEGATO_HOST_PORT` changes the host port if 8899 is taken. The container always listens on 8899 inside.

## What goes where

| Inside the container | What it is | Mounted from |
|---|---|---|
| `/music` | Your library, **read-only** | `LEGATO_MUSIC_DIR` on the host |
| `/data` | Database, cover art, waveform and stream caches | The `legato-data` named volume |

The server runs as `PUID:PGID`, never as root. On start, the container gives `/data` to that user if it isn't theirs yet (a first start, or after you change `PUID`). `PUID=0` is refused. That user needs read access to every folder in the library. On a Synology, check the shared folder's permissions for that user in Control Panel.

## Adding another folder

Legato can only see folders mounted into its container, so the folder picker lists `/music` and any other mount, nothing else from the host. To add a second library (another drive, a share mounted on the host), add a line under `volumes:` in `docker-compose.yml`, with a path inside the container that's yours to pick:

```yaml
      - "/volume2/more-music:/more-music:ro"
```

then `docker compose up -d` to recreate the container. The new folder shows up in the picker straight away; add it there like the first one.

## Appearing on the connect screen

Legato's desktop app, which has no signed builds yet, lists the servers it finds under **on this network** on its connect screen, so nobody has to type an address. The server announces itself over mDNS, but on Docker's default bridge network that announcement stays on Docker's internal network, where other devices can't hear it. With the compose file as it comes, the server works, but you connect to it by address.

To be listed, the container needs the host's network. In `docker-compose.yml`, replace the `ports:` block with `network_mode: host`:

```yaml
    network_mode: host
    environment:
      PUID: "${PUID:-1000}"
      PGID: "${PGID:-1000}"
      LEGATO_SERVER_NAME: "Living room"
```

then `docker compose up -d` to recreate the container. Host networking changes two things:

- **There's no `ports:` mapping.** The server listens on the host's own network, so Docker has nothing to publish.
- **`LEGATO_PORT` takes the place of `LEGATO_HOST_PORT`.** The server listens on 8899 on the host itself. If that's taken, set `LEGATO_PORT: "8900"` under `environment:`. `LEGATO_HOST_PORT` no longer does anything.

Host networking needs Docker Engine on Linux: a NAS, a Raspberry Pi, any Linux machine. Docker Desktop (on macOS, Windows or Linux) runs containers inside a virtual machine, so even with host networking the container isn't on your network and the connect screen can't find it. Connect by address there.

Name the server with `LEGATO_SERVER_NAME`, whichever network it's on. The compose file has the line, commented out. Without it, the apps show the container's hostname: a random id like `15f18b3fbcac` on the bridge network, or the host's own name with host networking.

## Away from home, over Tailscale

If your phone reaches Legato over Tailscale, say behind `tailscale serve` on the host as [https.md](https.md) describes, Legato can tell it when it's left home. A tailnet address counts as being at home wherever the phone is, so it keeps streaming every track as its original file, about 400 MB an hour for a CD-quality FLAC on mobile data. The server finds out where each device is by asking the host's Tailscale (`tailscale status --json`, which talks to tailscaled on the host and nothing else). Once it can, a device away from home gets the notice offering **standard while away**, the **Away from home** choice in Settings takes effect, and the connection indicator in a desktop browser says "Away from home".

The container can't ask as it comes. Until it can, every device counts as "don't know": nothing breaks, the notice never shows, and Away from home in Settings changes nothing. It needs three things:

1. **Host networking**, as in [Appearing on the connect screen](#appearing-on-the-connect-screen): replace the `ports:` block with `network_mode: host`. On Docker's bridge network the server can't work out which device is asking, or where it is:
   - `tailscale serve` passes each request to the host's own address, `127.0.0.1`, and names the device in a header. Docker hands the request on from its own network instead, so the server sees it come from Docker and doesn't trust the header. Every device reads "don't know".
   - A device that opens the host's tailnet address directly is seen, but the server compares where Tailscale reaches it against the networks *it* is on. On the bridge network that's only Docker's own, never your home network, so a phone on your Wi-Fi would read as away.
2. **The host's Tailscale socket.** Mount the folder that holds it, read-only. On most Linux hosts that's `/var/run/tailscale`. Mount the folder rather than the `tailscaled.sock` file in it: tailscaled makes a new socket every time it restarts, after an upgrade say, and a mount of the old file goes on pointing at it until the container is recreated.
3. **A `tailscale` command inside the container.** The image doesn't include one, so mount the host's (`command -v tailscale` on the host says where it is). Mounted at `/usr/local/bin/tailscale` it's found by itself; anywhere else, set `LEGATO_TAILSCALE_PATH` to where it is inside the container. Tailscale's own packages, from [pkgs.tailscale.com](https://pkgs.tailscale.com/stable/) (Debian, Ubuntu, Raspberry Pi OS, Fedora and others), are a single self-contained file that runs in the container as it is. Some distributions build their own that needs the host's libraries. If yours does, the check below says `no such file or directory`: download the static build for your machine from that page, unpack it, and mount its `tailscale` instead.

Together, in `docker-compose.yml`:

```yaml
    network_mode: host
    environment:
      PUID: "${PUID:-1000}"
      PGID: "${PGID:-1000}"
    volumes:
      - legato-data:/data
      - "${LEGATO_MUSIC_DIR:?...}:/music:ro"
      - /var/run/tailscale:/var/run/tailscale:ro
      - /usr/bin/tailscale:/usr/local/bin/tailscale:ro
```

The compose file has the two mounts, commented out. Then `docker compose up -d` to recreate the container. To check, ask Tailscale from inside it as the user the server runs as, your `PUID` (1026 in the example above):

```sh
docker compose exec --user 1026 legato tailscale status
```

It lists your tailnet's devices, as `tailscale status` on the host does. `failed to connect to local tailscaled` means the socket folder isn't mounted, or tailscaled isn't running on the host. `executable file not found` means the command isn't mounted where the server looks, and `no such file or directory` that it needs libraries the container doesn't have (see 3 above). The server logs the same reasons once a device on the tailnet opens Legato, in a line that starts `tailscale: can't tell whether devices on the tailnet are at home`; for either of the last two it says `no tailscale CLI found`.

**What the container may do with it.** The server only ever reads Tailscale's status, and tailscaled lets any user on the host do that. It doesn't let them change anything, so the container can't either, `:ro` or not: that's tailscaled's own check, by user id. The exception is when `PUID` is the user you made Tailscale's operator, which [https.md](https.md) suggests as a way to run `tailscale serve` without `sudo`: the operator may change Tailscale's settings, and so then could anything running in the container. Legato never does. If you'd rather it couldn't, use `sudo tailscale serve` and clear the operator with `sudo tailscale set --operator=`.

None of this works in Docker Desktop, on macOS, Windows or Linux: its containers run in a virtual machine, where neither host networking nor the host's Tailscale is your computer's own.

## How much disk the stream cache takes

When a browser or phone plays a track at a lower quality, or the web player asks for it as MP4, the server converts it once and keeps the result in `/data/streams`, so the next play starts straight away. The cache has a budget of 4 GB, every quality together. Past that, the tracks played longest ago go first. Nothing played in the last 10 minutes is removed, so the cache can be over its budget for a little while.

To change the budget, set `LEGATO_STREAM_CACHE_MB` under `environment:`, in whole megabytes (1024 is 1 GB):

```yaml
    environment:
      LEGATO_STREAM_CACHE_MB: "10240"
```

then `docker compose up -d`. A smaller budget takes effect on that start: the server trims the cache down to it and logs how much it removed. A value of 0, or one that isn't a whole number, is ignored with a warning in the log, and the cache keeps the 4 GB default. There's no unlimited setting.

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
