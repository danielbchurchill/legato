# syntax=docker/dockerfile:1

# --- deps: installed in its own stage so a source-only change doesn't
# invalidate this layer's cache. Stays on a plain Node image rather than
# Bun's for this one step: better-sqlite3's node-gyp compile step is gone
# (issue #101 moved the relay onto bun:sqlite, built into the Bun runtime),
# so nothing here needs a compiler toolchain, but package-lock.json is
# still the source of truth for exact versions — `bun install` would
# ignore it and generate its own bun.lock instead. Debian's own `npm`
# package pulls in an unrelated (and huge) apt dependency tree, so
# node:slim's bundled npm is the cheaper way to run `npm ci`.
FROM node:24.19.0-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- runtime ---
# Stays on Bun 1.4.2 while the server moves to 1.4.4 (#491). On 1.4.4,
# Bun.serve didn't act on a WebSocket Close that came at the end of a
# multi-MB burst, and Bun's `ws`, which @fastify/websocket uses here, runs
# on the same machinery. The relay moves in a PR of its own, once the
# tunnel route is checked on 1.4.4.
FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 8901

# No compile step: Bun executes TypeScript directly, no separate transpile
# step, matching package.json's "start" script (bun src/index.ts).
CMD ["bun", "src/index.ts"]
