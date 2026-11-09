# Sightline web app. Build context: the repository root.
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sightline/web build && node scripts/prepare-standalone.mjs

FROM node:22-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 10001 web
COPY --from=build --chown=web /repo/apps/web/.next/standalone ./
USER web
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
