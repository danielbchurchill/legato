# syntax=docker/dockerfile:1

# Issue #105: the Docker install channel (docs/plans/01-server-distribution.md,
# Docker + Synology). Ships issue #102's compiled `legato-server` binary on
# debian:bookworm-slim with Debian's own ffmpeg and fpcalc. There is no Bun,
# Node or source tree in the runtime image.
#
# Lives in server/ with server/ as the build context, the same shape as
# relay/Dockerfile: the image is the server and nothing else, so the context
# stays small and needs no repo-wide .dockerignore. Build it from the repo
# root with:
#   docker buildx build --platform linux/amd64,linux/arm64 server

# --- build: always runs on the builder's own architecture ($BUILDPLATFORM)
# and cross-compiles to the image's ($TARGETARCH) through Bun's --target.
# Running Bun itself under QEMU for the foreign half of a multi-arch build
# would be several times slower, and it is the same cross-compile the
# release workflow already relies on for its five archives.
#
# The Bun stage needs its own --platform pin. `COPY --from=<image>` resolves
# that image for the *target* platform, so copying straight out of
# oven/bun hands an arm64 builder an x64 Bun it can't execute.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim AS bun

FROM --platform=$BUILDPLATFORM node:24.19.0-slim AS build
# npm ci because server/package-lock.json is the dependency source of truth
# (`bun install` would ignore it). Bun because server/scripts/compile.ts is
# a Bun script. Bun is one self-contained executable, so copying it in is
# cheaper than building on a second base image.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG TARGETARCH
# Passed by .github/workflows/release.yml. Left empty, compile.ts falls back
# to package.json's version and "unknown" for the SHA (there is no .git in
# this context), which is what a local build should say about itself.
ARG LEGATO_VERSION=""
ARG LEGATO_GIT_SHA=""
# amd64 gets the baseline build for the same reason the release archive
# does: NAS CPUs like the Synology J4125 lack AVX2.
RUN case "$TARGETARCH" in \
      amd64) target=linux-x64-baseline ;; \
      arm64) target=linux-arm64 ;; \
      *) echo "no legato-server compile target for TARGETARCH=$TARGETARCH (expected amd64 or arm64)" >&2; exit 1 ;; \
    esac \
    && LEGATO_RELEASE_VERSION="$LEGATO_VERSION" LEGATO_RELEASE_GIT_SHA="$LEGATO_GIT_SHA" \
       npm run compile -- "$target" \
    && cp "dist/$target/legato-server" /legato-server

# --- runtime
FROM debian:bookworm-slim AS runtime

# tini is PID 1 because the server installs no SIGTERM handler, and the
# kernel drops default-action signals aimed at PID 1. Without it
# `docker stop` hangs for its full timeout and then SIGKILLs. tini also
# reaps the ffmpeg/fpcalc children.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools tini \
    && rm -rf /var/lib/apt/lists/*

# A real 1000:1000 user so `docker run --user legato` and file listings
# inside the container have a name to show. The entrypoint drops to
# PUID/PGID by number, so a different PUID needs no matching account here.
RUN groupadd --gid 1000 legato \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /data --shell /usr/sbin/nologin legato \
    && mkdir -p /data /music \
    && chown legato:legato /data

COPY --from=build /legato-server /usr/local/bin/legato-server
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# LEGATO_DATA_DIR must match the volume below. The server's fallback is
# ~/.local/share/legato, which here would be an unmounted path inside the
# container layer: every restart would open a fresh, empty database.
ENV LEGATO_DATA_DIR=/data \
    LEGATO_PORT=8899 \
    LEGATO_FFMPEG_PATH=/usr/bin/ffmpeg \
    LEGATO_FPCALC_PATH=/usr/bin/fpcalc \
    PUID=1000 \
    PGID=1000

VOLUME /data
EXPOSE 8899

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/local/bin/legato-server"]
