# Homebrew formula

`legato.rb` is the formula for the `danielbchurchill/homebrew-legato` tap (issue #109, [plan](../../docs/plans/01-server-distribution.md#install-script--homebrew)). It stays in this repo until that tap repository exists. After that, the tap is where it lives (see [Moving it to the tap](#moving-it-to-the-tap)).

Once the tap is live, a user runs:

```sh
brew install danielbchurchill/legato/legato
brew services start legato
```

## What the formula does

- Downloads the release archive #102 publishes for the machine: `legato-server-<version>-darwin-arm64.tar.gz` or `-darwin-x64-baseline.tar.gz` on a Mac, `-linux-arm64` or `-linux-x64-baseline` under Homebrew on Linux. Each one is pinned by sha256.
- Installs only `legato-server`. The archive also carries its own ffmpeg and fpcalc, but the formula depends on Homebrew's `ffmpeg` and `chromaprint` and leaves the bundled copies out, so `brew upgrade` keeps them patched.
- Installs `bin/legato-server` as a small wrapper around `libexec/legato-server`. The wrapper sets these defaults, and anything already set in the environment still wins:

  | Variable | Value |
  |---|---|
  | `LEGATO_DATA_DIR` | `$(brew --prefix)/var/legato` |
  | `LEGATO_FFMPEG_PATH` | `$(brew --prefix)/opt/ffmpeg/bin/ffmpeg` |
  | `LEGATO_FPCALC_PATH` | `$(brew --prefix)/opt/chromaprint/bin/fpcalc` |
  | `LEGATO_INSTALL_CHANNEL` | `brew`, so #110's update notice shows `brew upgrade legato` |

  The variables live in the wrapper instead of only in the service block. That way, running `legato-server` by hand opens the same database the service does, and never a second, empty one in `~/.local/share/legato`.
- `service do` runs the wrapper under launchd on macOS (`~/Library/LaunchAgents/sh.brew.legato.plist`) or as a systemd user unit on Linux. It restarts the server if it exits and writes the log to `$(brew --prefix)/var/log/legato.log`. The server listens on 8899.
- `brew uninstall legato` leaves `var/legato` in place, because that directory is the user's database. Removing it is a manual `rm -rf "$(brew --prefix)/var/legato"`.

## Releases bump it

`release.yml`'s `homebrew` job runs after `release` on every stable version tag (pre-release tags such as `v1.0.0-rc.1` are skipped). It downloads the release's own `SHA256SUMS` and runs `scripts/bump-homebrew-formula.mjs` on the tap's `Formula/legato.rb`, which rewrites each archive's url to the new version and fills in that archive's sha256. Then it opens a PR against the tap. The job stays skipped until the `HOMEBREW_TAP_REPO` repository variable is set.

The formula has no `version` line. Homebrew reads the version from the `/releases/download/v<version>/` url, and `brew audit --strict` rejects a `version` line that repeats it. The `0.0.0` urls and zero checksums committed here are placeholders, and the first release's bump replaces them.

## Moving it to the tap

Each of these steps is Daniel's to take.

1. **Make the release archives downloadable without a login.** `danielbchurchill/legato` is private, and Homebrew downloads release assets anonymously, so every install would fail with a 404 even after a release exists. Either make the repo (or at least its releases) public, or publish the archives somewhere public and change the formula's url lines and `scripts/bump-homebrew-formula.mjs`'s `URL_LINE` pattern to match.
2. Create `danielbchurchill/homebrew-legato`. Homebrew requires the `homebrew-` prefix, and `brew install danielbchurchill/legato/legato` drops it.
3. Copy `legato.rb` to `Formula/legato.rb` in the tap and commit it. Then `git rm packaging/homebrew/legato.rb` here, and reword this README to point at the tap, so two copies can't drift apart.
4. Create a fine-grained personal access token scoped to the tap only, with Contents and Pull requests set to read and write. Add it to this repo as the Actions secret `HOMEBREW_TAP_TOKEN`.
5. Add the Actions repository variable `HOMEBREW_TAP_REPO` = `danielbchurchill/homebrew-legato`. The next stable tag push then opens a bump PR on the tap.

## Testing it locally

There's no release to download yet, so the formula was tested against a locally built archive. Homebrew only installs formulae from a tap, so a throwaway local one stands in:

```sh
LEGATO_RELEASE_VERSION=0.0.1 npm --prefix server run compile -- darwin-arm64
node scripts/fetch-release-media-binaries.mjs darwin-arm64
node scripts/package-release.mjs 0.0.1 darwin-arm64

brew tap-new legatotest/scratch --no-git
cp packaging/homebrew/legato.rb "$(brew --repository legatotest/scratch)/Formula/legato.rb"
```

Then edit that copy in the tap (the one here stays untouched):

- Point the darwin-arm64 `url` at `file://$PWD/dist-release/legato-server-0.0.1-darwin-arm64.tar.gz` and set its `sha256` from `dist-release/SHA256SUMS`.
- Add `version "0.0.1"` under `homepage`. A `file://` url has no `/download/v<version>/` for Homebrew to read, so it guesses `64` from `darwin-arm64`.
- Add `environment_variables LEGATO_PORT: "<free port>"` to `service do` if 8899 is taken.

Then run:

```sh
brew install --build-from-source legatotest/scratch/legato
brew services start legatotest/scratch/legato
curl http://127.0.0.1:<port>/api/v1/health
brew services stop legatotest/scratch/legato
brew test legatotest/scratch/legato
brew uninstall legato
cp packaging/homebrew/legato.rb "$(brew --repository legatotest/scratch)/Formula/legato.rb"
brew audit --strict legatotest/scratch/legato
brew untap legatotest/scratch
rm -rf "$(brew --prefix)/var/legato" "$(brew --prefix)/var/log/legato.log"
```

Don't set `HOMEBREW_NO_INSTALL_FROM_API` for this. It quietly taps the full `homebrew/core` git repository (about 1.4 GB), which then needs its own `brew untap homebrew/core`.
