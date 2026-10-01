#!/bin/sh
# Legato server installer for Linux (x64 and arm64), served at legato.fm/install.sh.
#
#   curl -fsSL https://legato.fm/install.sh | sh
#   curl -fsSL https://legato.fm/install.sh | sh -s -- --library=/mnt/music
#
# Downloads the newest legato-server release, checks it against SHA256SUMS,
# installs it to ~/.local/share/legato/bin and runs it as a systemd *user*
# service. Nothing outside your home directory changes, except turning on
# lingering. Re-running it, or `legato update`, upgrades in place.
#
#   --library=<dir>          Where your music lives. If it's a mount point
#                            (a USB drive, NFS), the service waits for it.
#   --library-mount=<dir>    Same, for a drive that isn't mounted right now.
#   LEGATO_PORT=8899         Port to serve on.
#   LEGATO_VERSION=0.4.0     Install this release instead of the newest.
#   LEGATO_RELEASE_BASE_URL  Fetch SHA256SUMS and archives from here instead.
set -eu

say() { printf '%s\n' "$@"; }
die() { printf 'legato install: %s\n' "$*" >&2; exit 1; }

# Everything runs from main, called on the last line, so a download cut off
# halfway through can't run half an installer.
main() {
  DATA_DIR="$HOME/.local/share/legato"   # the server's own fallback, set explicitly anyway
  BIN_DIR="$DATA_DIR/bin"
  UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/legato-server.service"
  RELEASES=https://github.com/danielbchurchill/legato/releases
  if [ -n "${LEGATO_VERSION:-}" ]; then base="$RELEASES/download/v$LEGATO_VERSION"; else base="$RELEASES/latest/download"; fi
  BASE_URL="${LEGATO_RELEASE_BASE_URL:-$base}"

  # A re-run without flags keeps what the last install chose.
  mount_dir=$(sed -n 's/^# legato-library-mount=//p' "$UNIT" 2>/dev/null || true)
  port="${LEGATO_PORT:-$(sed -n 's/^Environment=LEGATO_PORT=//p' "$UNIT" 2>/dev/null || true)}"; port="${port:-8899}"
  for arg in "$@"; do
    case "$arg" in
      --library=*) dir="${arg#*=}"; mount_dir=""; if mountpoint -q "$dir" 2>/dev/null; then mount_dir="$dir"; fi ;;
      --library-mount=*) mount_dir="${arg#*=}" ;;
      *) die "unknown option $arg (see the top of this script)" ;;
    esac
  done
  case "$mount_dir" in
    *[!A-Za-z0-9/._-]*) die "can't write a unit for $mount_dir; use a path without spaces or quotes" ;;
    "" | /*) ;;
    *) die "--library needs an absolute path, got $mount_dir" ;;
  esac

  [ "$(uname -s)" = Linux ] || die "this script is for Linux. On macOS: brew install danielbchurchill/legato/legato"
  [ "$(id -u)" != 0 ] || die "run this as the user who should own Legato, not root (it installs a per-user service)"
  for tool in curl tar awk sha256sum systemctl loginctl; do command -v "$tool" >/dev/null 2>&1 || die "needs $tool, which isn't installed"; done
  case "$(uname -m)" in
    x86_64 | amd64) target=linux-x64-baseline ;;
    aarch64 | arm64) target=linux-arm64 ;;
    *) die "no Legato build for $(uname -m) yet; Linux builds are x86_64 and aarch64 only" ;;
  esac
  # 32-bit Raspberry Pi OS runs a 64-bit kernel over 32-bit userland, so
  # uname says aarch64 but an arm64 binary has nothing to load it.
  [ "$(getconf LONG_BIT)" = 64 ] || die "this is a 32-bit system; Legato needs a 64-bit OS (64-bit Raspberry Pi OS on a Pi)"

  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$BASE_URL/SHA256SUMS" -o "$tmp/SHA256SUMS" || die "couldn't download $BASE_URL/SHA256SUMS"
  archive=$(awk -v t="-$target.tar.gz" 'index($2, "legato-server-") == 1 && substr($2, length($2) - length(t) + 1) == t { print $2 }' "$tmp/SHA256SUMS")
  [ -n "$archive" ] || die "$BASE_URL has no $target build"
  stem="${archive%.tar.gz}"
  version="${stem#legato-server-}"; version="${version%-"$target"}"
  current=$("$BIN_DIR/legato-server" --version 2>/dev/null | cut -d' ' -f2 || true)

  changed=no
  if [ "$current" = "$version" ]; then
    say "Legato $version is already installed."
  else
    say "Downloading Legato $version ($target)..."
    curl -fSL --progress-bar "$BASE_URL/$archive" -o "$tmp/$archive" || die "couldn't download $BASE_URL/$archive"
    (cd "$tmp" && awk -v a="$archive" '$2 == a' SHA256SUMS | sha256sum -c --quiet -) ||
      die "$archive doesn't match SHA256SUMS; nothing was installed. Try again, and report it if it keeps happening"
    tar -xzf "$tmp/$archive" -C "$tmp"
    "$tmp/$stem/legato-server" --version >/dev/null 2>&1 || die "the $target build won't run on this machine"
    mkdir -p "$BIN_DIR"
    # Copy beside, then rename: overwriting a running binary in place fails
    # with "text file busy", and a rename never leaves a half-written one.
    for f in legato-server ffmpeg fpcalc; do
      cp "$tmp/$stem/$f" "$BIN_DIR/.$f.new" && mv -f "$BIN_DIR/.$f.new" "$BIN_DIR/$f"
    done
    changed=yes
  fi

  # install.sh is the file's real path; /install needs a rewrite rule on the host.
  install_url="${LEGATO_INSTALL_URL:-https://legato.fm/install.sh}"; overrides=""
  [ -z "${LEGATO_INSTALL_URL:-}" ] || overrides="LEGATO_INSTALL_URL='$install_url' "
  [ -z "${LEGATO_RELEASE_BASE_URL:-}" ] || overrides="${overrides}LEGATO_RELEASE_BASE_URL='$LEGATO_RELEASE_BASE_URL' "
  cat >"$BIN_DIR/legato" <<EOF
#!/bin/sh
# Written by the Legato installer. Downloads it fresh rather than piping: a failed
# curl piped into sh is an empty script that "succeeds". Settings carry over.
case "\${1:-}" in
  update) f=\$(mktemp) && curl -fsSL '$install_url' -o "\$f" || exit 1
    head -n 1 "\$f" | grep -q '^#!/bin/sh' || { echo "legato update: $install_url isn't the installer" >&2; rm -f "\$f"; exit 1; }
    ${overrides}sh "\$f"; rc=\$?; rm -f "\$f"; exit \$rc ;;
  *) echo "usage: legato update" >&2; exit 2 ;;
esac
EOF
  chmod 755 "$BIN_DIR/legato"
  mkdir -p "$HOME/.local/bin" "$(dirname "$UNIT")" && ln -sf "$BIN_DIR/legato" "$HOME/.local/bin/legato"

  gate=""
  [ -z "$mount_dir" ] ||
    gate="ExecStartPre=/bin/sh -c 'mountpoint -q $mount_dir || { echo \"legato: waiting for $mount_dir to be mounted\"; exit 1; }'"
  cat >"$tmp/unit" <<EOF
# Written by legato.fm/install.sh; re-running it or \`legato update\` replaces this file.
# legato-library-mount=$mount_dir
#   A user service can't depend on a system mount (the user manager ignores RequiresMountsFor=),
#   so ExecStartPre checks for the drive itself and Restart= retries every 15s until it's there.
[Unit]
Description=Legato music server
Documentation=https://legato.fm

[Service]
Environment=LEGATO_DATA_DIR=%h/.local/share/legato
Environment=LEGATO_PORT=$port
Environment=LEGATO_FFMPEG_PATH=%h/.local/share/legato/bin/ffmpeg
Environment=LEGATO_FPCALC_PATH=%h/.local/share/legato/bin/fpcalc
Environment=LEGATO_INSTALL_CHANNEL=script
$gate
ExecStart=%h/.local/share/legato/bin/legato-server
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
EOF
  [ "$(cat "$tmp/unit")" = "$(cat "$UNIT" 2>/dev/null || true)" ] || { cp "$tmp/unit" "$UNIT"; changed=yes; }

  # Without lingering, systemd stops user services at logout and doesn't
  # start them at boot, which is the whole point of a headless server.
  user=$(id -un)
  if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" != yes ]; then
    say "Turning on lingering so Legato runs while you're logged out (this may ask for your sudo password)..."
    loginctl --no-ask-password enable-linger "$user" 2>/dev/null || sudo loginctl enable-linger "$user" ||
      say "Couldn't turn on lingering. Run 'sudo loginctl enable-linger $user', or Legato stops when you log out."
  fi
  systemctl --user show-environment >/dev/null 2>&1 ||
    die "can't reach your systemd user session. Log in directly (SSH or desktop), not through su or sudo, and run this again"
  systemctl --user daemon-reload
  systemctl --user enable legato-server.service >/dev/null 2>&1
  if [ "$changed" = yes ]; then systemctl --user restart --no-block legato-server.service; else systemctl --user start --no-block legato-server.service; fi

  host=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  url="http://${host:-localhost}:$port"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Add ~/.local/bin to your PATH to use 'legato update'." ;; esac
  if [ -n "$mount_dir" ] && ! mountpoint -q "$mount_dir"; then
    say "" "Legato $version is installed, and starts by itself once $mount_dir is mounted." \
      "Then open $url/setup to create the owner; the setup code is on that page and in" \
      "journalctl --user-unit legato-server"
    return
  fi
  i=0
  until curl -fs "http://127.0.0.1:$port/api/v1/health" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 30 ] || die "the service didn't come up; see journalctl --user-unit legato-server"
    sleep 1
  done
  # Loopback is the one place the server hands out its setup code unasked.
  code=$(curl -s "http://127.0.0.1:$port/api/v1/auth/setup" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p' || true)
  if [ -n "$code" ]; then
    say "" "Legato $version is running. Open $url/setup and create the owner." \
      "Setup code: $code (good for 10 minutes; the page always shows the current one)"
  else
    say "" "Legato $version is running. Open $url and sign in."
  fi
}

main "$@"
