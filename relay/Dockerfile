# syntax=docker/dockerfile:1

# --- deps: installed in its own stage so a source-only change doesn't
# invalidate this layer's cache ---
FROM node:24.19.0-slim AS deps
WORKDIR /app
# better-sqlite3 (added alongside the relay's account/pairing system) compiles
# a native addon via node-gyp at install time — a plain slim image has no
# compiler toolchain, so npm ci fails without these. Deliberately not in the
# runtime stage below: only the already-compiled node_modules gets copied
# forward, so the runtime image stays free of the build toolchain's bulk.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# --- runtime ---
FROM node:24.19.0-slim AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 8901

# No compile step: package.json's "start" script runs src/index.ts directly
# via tsx, the same convention server/'s embedded deployment already uses
# (see repo CLAUDE.md).
CMD ["npm", "start"]
