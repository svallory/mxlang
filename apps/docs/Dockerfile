# Production image for the docs site (https://mx.saulo.tech), built by Coolify.
#
# The build context is the REPOSITORY ROOT (Coolify: base directory `/`,
# Dockerfile location `/apps/docs/Dockerfile`): the docs build needs the
# workspace packages and the tree-sitter grammar, not just apps/docs.
#
# Stage 1 runs exactly what CI's `pack-probe-docs` runs for the docs:
# `bun install --frozen-lockfile`, then `apps/docs build` (which builds both
# grammar wasms first). Stage 2 serves `apps/docs/site` with nginx on :8080.
FROM node:26.7.0-trixie-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl unzip util-linux \
  && rm -rf /var/lib/apt/lists/*
# Bun is pinned to the repo's `packageManager` version.
RUN npm install -g bun@1.3.14
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile
# `@mxlang/html` (and what it imports) resolve through `dist/`, so the packages
# the landing-page generator uses are built first; CI builds all of them.
RUN bun run --cwd packages/core build \
  && bun run --cwd packages/targets/data build \
  && bun run --cwd packages/tsx-bridge build \
  && bun run --cwd packages/targets/html build
RUN bun run --cwd apps/docs build

FROM nginx:1.29-alpine
COPY apps/docs/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/docs/site /usr/share/nginx/html
EXPOSE 8080
