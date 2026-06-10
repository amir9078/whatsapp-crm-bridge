# syntax=docker/dockerfile:1
# One image runs both services (docker-compose.yml picks the command):
#   server → node apps/server/dist/index.js   (API + WebSocket + WhatsApp connector)
#   web    → pnpm -F @wcb/web start           (Next.js UI)
# Inside Docker the Prisma client is generated for Postgres (dev stays on SQLite).
FROM node:22-alpine

RUN corepack enable
WORKDIR /app

# Layer-cache dependencies: manifests first, source later.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/connector/package.json packages/connector/
COPY packages/db/package.json packages/db/
COPY packages/crm/package.json packages/crm/
RUN pnpm install --frozen-lockfile

COPY . .

# Postgres flavour of the Prisma client + build everything.
# NEXT_PUBLIC_* is baked at build time: set it to the URL the BROWSER uses for the API,
# e.g. http://your-server-ip:4000 or https://api.your-domain.com
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm -F @wcb/db schema:postgres \
 && pnpm -F @wcb/db exec prisma generate --schema prisma/schema.postgres.prisma \
 && pnpm -F @wcb/shared build \
 && pnpm -F @wcb/connector build \
 && pnpm -F @wcb/db exec tsc -b \
 && pnpm -F @wcb/crm build \
 && pnpm -F @wcb/server build \
 && pnpm -F @wcb/web build

ENV NODE_ENV=production
EXPOSE 3000 4000
CMD ["node", "apps/server/dist/index.js"]
