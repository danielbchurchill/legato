#!/usr/bin/env bash
# Deploys the compiled legato-server to a standalone target host that already
# runs it as a systemd *user* unit — issue #194. It's the manual update
# procedure as one command, so a deploy can't stop half-done: a deploy by
# hand once lost a round trip to a forgotten `chmod`, since scp drops the
# executable bit.
#
#   scripts/deploy-server.sh [--allow-dirty] [--health-timeout <s>] <ssh-host>
#   scripts/deploy-server.sh [--allow-dirty] [--health-timeout <s>] --local
#
# Order matters, and is chosen so the server is down for as little time as
# possible and never left down by a bad binary:
#   1. probe the host: OS/arch, the unit's LEGATO_DATA_DIR/LEGATO_PORT, the
#      running binary's SHA and the schema version /health reports
#   2. compile the matching target from a clean tree, at local HEAD
#   3. upload it next to the live binary and run its --version *there* —
#      a wrong-arch or truncated binary fails here, with the server still up
#   4. stop the unit, copy legato.db* to a timestamped backup, keep the old
#      binary as legato-server.prev-<sha>, rename the new one into place
#      (mode 755), start the unit
#   5. wait for /health, then require both `legato-server --version` and
#      /health's gitSha to match local HEAD
# On failure after step 4 it prints the last 40 journal lines and the exact
# rollback command, and exits non-zero. No sudo anywhere: everything lives in
# the deploying user's home and their user unit.
#
# --local runs every host-side step on this machine instead of over SSH. It
# deploys to the local user's own unit, and is also how this script is
# tested without a real host (HOME pointed at a temp dir, fake systemctl and
# journalctl on PATH).

set -euo pipefail

UNIT=legato-server
HEALTH_PATH=/api/v1/health
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

usage() {
  echo "usage:"
  sed -n '8,9s/^#//p' "${BASH_SOURCE[0]}"
}

die() {
  echo "deploy-server: $*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$*"
}

allow_dirty=0
local_mode=0
health_timeout=120
host=""
while (($#)); do
  case $1 in
    --allow-dirty) allow_dirty=1 ;;
    --local) local_mode=1 ;;
    --health-timeout)
      [[ ${2:-} =~ ^[0-9]+$ ]] || die "--health-timeout needs a number of seconds"
      health_timeout=$2
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option $1 (see --help)" ;;
    *)
      [[ -z $host ]] || die "one host at a time — got both '$host' and '$1'"
      host=$1
      ;;
  esac
  shift
done
if ((local_mode)); then
  [[ -z $host ]] || die "--local and an ssh host are mutually exclusive"
  host_label="this machine"
else
  [[ -n $host ]] || { usage >&2; exit 2; }
  host_label=$host
fi

# One multiplexed SSH connection for every step: the whole deploy is about
# six round trips, and a Tailscale SSH check or key passphrase should be
# answered once, not six times.
control_dir=$(mktemp -d "${TMPDIR:-/tmp}/legato-deploy.XXXXXX")
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  if ((!local_mode)); then
    ssh -o ControlPath="$control_dir/cm" -O exit "$host" 2>/dev/null || true
  fi
  rm -rf "$control_dir"
}
trap cleanup EXIT
ssh_opts=(-o ControlMaster=auto -o ControlPath="$control_dir/cm" -o ControlPersist=120)

# Runs a bash script on the host with positional arguments. Arguments are
# %q-quoted because ssh flattens its command line into one string for the
# remote shell.
on_host() {
  local script=$1
  shift
  if ((local_mode)); then
    bash -s -- "$@" <<<"$script"
  else
    # shellcheck disable=SC2029 # expanding locally is the point
    ssh "${ssh_opts[@]}" "$host" "bash -s -- $(printf '%q ' "$@")" <<<"$script"
  fi
}

# The command a person would type to run $1 on the host, for the rollback
# hint — quoted for pasting, not for this script.
host_command() {
  if ((local_mode)); then
    printf '%s' "$1"
  else
    printf "ssh %s '%s'" "$host" "$1"
  fi
}

# Shared by the probe and the health wait: fetch a URL on the host with
# whatever it has: a minimal Debian may only have one of curl/wget/python3.
# shellcheck disable=SC2016 # expanded on the host, not here
fetch_fn='
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- -T 3 "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import sys,urllib.request;sys.stdout.write(urllib.request.urlopen(sys.argv[1],timeout=3).read().decode())" "$1"
  else return 127
  fi
}
'

# Reads one key=value line from the host scripts' output. Not an associative
# array: macOS still ships bash 3.2.
kv() {
  sed -n "s/^$1=//p" <<<"$2" | head -n 1
}

# Pulls one field out of the /health body without needing jq on either side.
json_field() {
  sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}[,}].*/\1/p" <<<"$2"
}

# --- 1. probe --------------------------------------------------------------

# shellcheck disable=SC2016 # the whole probe is expanded on the host
probe_script=$fetch_fn'
set -u
unit=$1
echo "home=$HOME"
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "load_state=$(systemctl --user show "$unit" -p LoadState --value 2>/dev/null)"
echo "active_state=$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null)"
echo "exec_start=$(systemctl --user show "$unit" -p ExecStart --value 2>/dev/null | tr "\n" " ")"
data_dir="" port=""
for word in $(systemctl --user show "$unit" -p Environment --value 2>/dev/null); do
  case $word in
    LEGATO_DATA_DIR=*) data_dir=${word#LEGATO_DATA_DIR=} ;;
    LEGATO_PORT=*) port=${word#LEGATO_PORT=} ;;
  esac
done
# Same fallbacks as server/src/config.ts, so an unset variable here means
# exactly what it means to the server.
data_dir=${data_dir:-$HOME/.local/share/legato}
data_dir=${data_dir//%h/$HOME}
echo "data_dir=$data_dir"
echo "port=${port:-8899}"
bin=$HOME/.local/bin/legato-server
if [ -x "$bin" ]; then echo "current_version=$("$bin" --version 2>/dev/null | head -n 1)"; fi
echo "current_health=$(fetch "http://127.0.0.1:${port:-8899}'"$HEALTH_PATH"'" 2>/dev/null)"
'

step "Probing $host_label"
probe=$(on_host "$probe_script" "$UNIT") || die "couldn't reach $host_label"

remote_home=$(kv home "$probe")
host_os=$(kv os "$probe")
host_arch=$(kv arch "$probe")
load_state=$(kv load_state "$probe")
active_state=$(kv active_state "$probe")
exec_start=$(kv exec_start "$probe")
[[ -n $remote_home ]] || die "probe of $host_label returned nothing usable:"$'\n'"$probe"
[[ $load_state == loaded ]] ||
  die "$host_label has no loaded '$UNIT' user unit (LoadState=${load_state:-none}). This script updates an existing install; it doesn't write the unit (that's #108's installer)."

case "$host_os/$host_arch" in
  Linux/x86_64 | Linux/amd64) target=linux-x64-baseline ;;
  Linux/aarch64 | Linux/arm64) target=linux-arm64 ;;
  Darwin/arm64) target=darwin-arm64 ;;
  Darwin/x86_64) target=darwin-x64-baseline ;;
  *) die "no compile target for ${host_os:-?} ${host_arch:-?} (server/scripts/compile.ts builds linux-x64-baseline, linux-arm64, darwin-arm64, darwin-x64-baseline, windows-x64-baseline; Windows has no systemd user unit to deploy to)" ;;
esac

bin_dir=$remote_home/.local/bin
live_bin=$bin_dir/legato-server
data_dir=$(kv data_dir "$probe")
port=$(kv port "$probe")
old_version=$(kv current_version "$probe")
old_sha=$(sed -n 's/.*(\([^)]*\)).*/\1/p' <<<"$old_version")
old_schema=$(json_field schemaVersion "$(kv current_health "$probe")")

echo "host:      $host_os $host_arch -> target $target"
echo "unit:      $UNIT (${active_state:-unknown}), port $port"
echo "data dir:  $data_dir"
echo "running:   ${old_version:-no binary at $live_bin}${old_schema:+, schema v$old_schema}"
if [[ $exec_start != *"path=$live_bin "* && $exec_start != *"path=$live_bin;"* ]]; then
  echo "warning:   the unit's ExecStart doesn't run $live_bin, so the new binary may not be what starts:" >&2
  echo "           ${exec_start:-<empty>}" >&2
fi

# --- 2. compile ------------------------------------------------------------

step "Compiling $target at local HEAD"
dirty=$(git -C "$REPO_ROOT" status --porcelain)
if [[ -n $dirty ]]; then
  if ((allow_dirty)); then
    echo "warning: deploying uncommitted changes; the binary will still report HEAD's SHA, so --version can't tell this build from a clean one" >&2
  else
    die "working tree has uncommitted changes — commit them, or pass --allow-dirty:"$'\n'"$dirty"
  fi
fi
# Same command compile.ts uses to stamp the binary, so the comparison in
# step 5 is like for like.
head_sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
# The release-pinning variables would stamp a SHA other than HEAD, and
# LEGATO_WEB_DIST would embed a client built from some other checkout.
env -u LEGATO_RELEASE_GIT_SHA -u LEGATO_RELEASE_VERSION -u LEGATO_WEB_DIST \
  npm --prefix "$REPO_ROOT/server" run compile -- "$target"
artifact=$REPO_ROOT/server/dist/$target/legato-server
[[ -f $artifact ]] || die "compile reported success but $artifact doesn't exist"
if [[ $old_sha == "$head_sha" ]]; then
  echo "note: $host_label already runs $head_sha; redeploying the same commit"
fi

# --- 3. upload and pre-flight ---------------------------------------------

staged_name=legato-server.new-$head_sha
step "Uploading to $bin_dir/$staged_name"
# Piped through ssh rather than scp: one connection, and the chmod happens
# in the same command as the write, so it can't be the step that's skipped.
# shellcheck disable=SC2016 # expanded on the host
upload_script='set -eu; mkdir -p "$1"; cat > "$1/$2.part"; chmod 755 "$1/$2.part"; mv -f "$1/$2.part" "$1/$2"'
if ((local_mode)); then
  bash -c "$upload_script" upload "$bin_dir" "$staged_name" <"$artifact"
else
  # shellcheck disable=SC2029
  ssh "${ssh_opts[@]}" "$host" "bash -c $(printf '%q' "$upload_script") upload $(printf '%q ' "$bin_dir" "$staged_name")" <"$artifact"
fi
# shellcheck disable=SC2016
staged_version=$(on_host '"$1" --version' "$bin_dir/$staged_name") ||
  die "the uploaded binary won't run on $host_label (wrong architecture, or a truncated upload?). Nothing was stopped; $bin_dir/$staged_name is left for inspection."
[[ $staged_version == *"($head_sha)"* ]] ||
  die "uploaded binary reports '$staged_version', expected $head_sha. Nothing was stopped."
echo "$staged_version runs on $host_label"

# --- 4. install ------------------------------------------------------------

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=$data_dir/backups/deploy-$timestamp${old_sha:+-$old_sha}
prev_bin=$live_bin.prev-${old_sha:-unknown}

# shellcheck disable=SC2016 # the whole install runs on the host
install_script='
set -euo pipefail
unit=$1 bin_dir=$2 staged=$3 prev=$4 data_dir=$5 backup_dir=$6
live=$bin_dir/legato-server
# Until the rename below, the old binary is still in place, so any failure
# (a full disk during the DB copy, say) can safely bring the old server back.
trap '"'"'echo "install failed before the new binary went in; starting the previous one again" >&2; systemctl --user start "$unit" || true'"'"' ERR
systemctl --user stop "$unit"
mkdir -p "$backup_dir"
shopt -s nullglob
dbs=("$data_dir"/legato.db*)
if ((${#dbs[@]})); then cp -p "${dbs[@]}" "$backup_dir"/; fi
echo "backed up ${#dbs[@]} file(s) to $backup_dir"
if [ -e "$live" ]; then cp -p "$live" "$prev"; echo "kept previous binary as $prev"; fi
mv -f "$bin_dir/$staged" "$live"
trap - ERR
chmod 755 "$live"
# Keep the three newest previous binaries (matching the server'"'"'s own
# pre-migration backup policy); each is tens of MB on what is often an SD card.
# Guarded on the count: with nullglob, an empty match would hand ls no
# arguments and it would list the working directory instead.
prevs=("$bin_dir"/legato-server.prev-*)
if ((${#prevs[@]} > 3)); then
  ls -1t -- "${prevs[@]}" | tail -n +4 | while IFS= read -r old; do rm -f -- "$old"; done
fi
systemctl --user start "$unit"
'

step "Installing on $host_label"
install_ok=1
on_host "$install_script" "$UNIT" "$bin_dir" "$staged_name" "$prev_bin" "$data_dir" "$backup_dir" || install_ok=0

# --- 5. verify -------------------------------------------------------------

# shellcheck disable=SC2016 # expanded on the host
wait_script=$fetch_fn'
set -u
unit=$1 url=$2 timeout=$3 bin=$4
deadline=$(( $(date +%s) + timeout ))
body=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  if body=$(fetch "$url" 2>/dev/null) && [ -n "$body" ]; then break; fi
  body=""
  # A failed Condition (say ConditionPathIsMountPoint= on a library mount
  # such as /mnt/music) leaves the unit inactive without an error; waiting
  # longer will not help.
  if [ "$(systemctl --user show "$unit" -p ConditionResult --value 2>/dev/null)" = no ]; then break; fi
  sleep 1
done
echo "health=$body"
echo "version=$("$bin" --version 2>&1 | head -n 1)"
echo "active_state=$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null)"
echo "condition=$(systemctl --user show "$unit" -p ConditionResult --value 2>/dev/null)"
'

verified=0
new_schema=""
failure=""
if ((install_ok)); then
  step "Waiting up to ${health_timeout}s for $HEALTH_PATH"
  after=$(on_host "$wait_script" "$UNIT" "http://127.0.0.1:$port$HEALTH_PATH" "$health_timeout" "$live_bin" || true)
  after_health=$(kv health "$after")
  after_version=$(kv version "$after")
  after_active=$(kv active_state "$after")
  after_condition=$(kv condition "$after")
  health_sha=$(json_field gitSha "$after_health")
  new_schema=$(json_field schemaVersion "$after_health")
  echo "--version: ${after_version:-<no output>}"
  echo "/health:   ${after_health:-<no answer>}"
  if [[ $after_condition == no ]]; then
    failure="the unit was skipped because a Condition failed — if the unit is gated on a mount point, check the drive is mounted"
  elif [[ -z $after_health ]]; then
    failure="no answer from $HEALTH_PATH on port $port within ${health_timeout}s (unit ${after_active:-unknown})"
  elif [[ $after_version != *"($head_sha)"* ]]; then
    failure="installed binary reports '$after_version', expected $head_sha"
  elif [[ $health_sha != "$head_sha" ]]; then
    failure="the server answering on port $port reports gitSha '$health_sha', expected $head_sha — is the unit's ExecStart pointing at $live_bin?"
  else
    verified=1
  fi
else
  failure="the install step on $host_label failed (see its output above)"
fi

# --- rollback hint ---------------------------------------------------------

print_rollback() {
  local restore_bin="cp -p $prev_bin $live_bin"
  local restore_db="rm -f $data_dir/legato.db-wal $data_dir/legato.db-shm && cp -p $backup_dir/legato.db* $data_dir/"
  if [[ -z $old_sha && -z $old_version ]]; then
    echo "There was no previous binary at $live_bin, so there's nothing to roll back to."
    return
  fi
  echo "Rollback to ${old_sha:-the previous binary}, binary only (when no migration ran):"
  echo "  $(host_command "systemctl --user stop $UNIT && $restore_bin && systemctl --user start $UNIT")"
  echo "Rollback with the database (needed if this deploy applied a migration — the old binary can't read a newer schema; anything written since the deploy is lost):"
  echo "  $(host_command "systemctl --user stop $UNIT && $restore_db && $restore_bin && systemctl --user start $UNIT")"
  if [[ -n $old_schema && -n $new_schema ]]; then
    if ((new_schema > old_schema)); then
      echo "This deploy moved the schema from v$old_schema to v$new_schema, so use the second one."
    else
      echo "The schema stayed at v$old_schema, so the first one is enough."
    fi
  else
    echo "Couldn't compare schema versions (before: ${old_schema:-unknown}, after: ${new_schema:-unknown}); if in doubt, use the second one."
  fi
}

if ((verified)); then
  step "Deployed $head_sha to $host_label"
  echo "schema: v${old_schema:-?} -> v${new_schema:-?}"
  echo "DB backup: $backup_dir"
  echo
  print_rollback
  exit 0
fi

echo >&2
echo "deploy-server: FAILED — $failure" >&2
step "Last 40 lines of the $UNIT journal" >&2
# shellcheck disable=SC2016 # expanded on the host
on_host 'journalctl --user-unit "$1" -n 40 --no-pager' "$UNIT" >&2 || echo "(journalctl failed)" >&2
echo >&2
print_rollback >&2
exit 1
