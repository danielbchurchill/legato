#!/bin/sh
# Drops from root to PUID:PGID before starting the server (issue #105).
#
# PUID/PGID rather than compose's `user:` because the numbers have to match
# whoever owns the music on the host (a Synology user, a Pi's `tapestry`),
# and the data volume has to be owned by that same uid. Only root can fix
# the volume's ownership, so the container starts as root, does that one
# chown, and gives the privilege up before anything else runs.
#
# Started with `--user` already, there's nothing to drop and no chown this
# process could do, so it just runs the server as whoever it is.
set -eu

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID:$PGID" in
  *[!0-9:]* | :* | *:)
    echo "docker-entrypoint: PUID and PGID must be numeric ids (got PUID='$PUID' PGID='$PGID'). Find yours with \`id <user>\` on the host." >&2
    exit 1
    ;;
esac

if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then
  echo "docker-entrypoint: refusing to run the server as root (PUID=$PUID PGID=$PGID). Set them to the host user that owns your music library." >&2
  exit 1
fi

# Only walks the volume when the top-level owner is wrong: first start with
# a non-default PUID, or after PUID changes. The data dir holds gigabytes of
# cover and waveform cache, and chown -R over that on every restart would
# make a NAS take minutes to come up.
if [ "$(stat -c %u:%g "$LEGATO_DATA_DIR")" != "$PUID:$PGID" ]; then
  echo "docker-entrypoint: giving $LEGATO_DATA_DIR to $PUID:$PGID"
  chown -R "$PUID:$PGID" "$LEGATO_DATA_DIR"
fi

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all -- "$@"
