# syntax=docker/dockerfile:1

# Multi-stage build for self-hosting usageratio. Vercel does not use this file
# (it builds directly from the repo); this is only for `docker build` /
# `docker compose up` on your own host. See docs/self-hosting.md.

FROM node:24-alpine AS base
WORKDIR /app

# ---- deps: install once, reused by the build stage ------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile the standalone Next.js server --------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Only this build sets DOCKER_BUILD=1, which flips next.config.ts to
# `output: "standalone"`; a plain `npm run build` (Vercel) never sets it.
# `prebuild` regenerates i18n/locales.generated.ts from messages/*.json first.
ENV DOCKER_BUILD=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: the smallest image that can serve the app --------------------
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# `node` is the built-in non-root user of the official Alpine Node image.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/scripts/docker-healthcheck.mjs ./scripts/docker-healthcheck.mjs

# `clients/**` (read by /setup and /api/setup at request time) is already
# inside .next/standalone/clients: next.config.ts's outputFileTracingIncludes
# makes `next build` trace and copy it there, verified during development —
# no separate COPY of clients/ is needed.

USER node
EXPOSE 3000

# Alpine has wget, but Node's own fetch avoids the extra dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "scripts/docker-healthcheck.mjs"]

CMD ["node", "server.js"]
