# Production image for the assistant bot.
#
# Multi-stage: the build stage carries devDependencies (TypeScript, tsx), and
# the runtime stage gets only production dependencies plus compiled output, so
# the deployed image stays small and free of build tooling.
#
# The app binds 0.0.0.0 and reads PORT, so the same image works on Railway,
# Fly.io, or any container host.

# --- Build -----------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so dependency installation is cached independently of
# source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run unprivileged: the image ships a "node" user, and nothing here needs root.
USER node

# Documentation only — the actual port comes from PORT (platform-injected) or
# WEBHOOK_PORT, defaulting to 3000.
EXPOSE 3000

# Liveness only, matching Railway's healthcheck: a database outage must not
# make the container look dead, since restarting cannot repair it.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so Node receives SIGTERM directly and the graceful shutdown in
# bot.ts actually runs.
CMD ["node", "dist/index.js"]
