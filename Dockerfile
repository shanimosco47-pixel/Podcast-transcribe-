# Build stage: dev dependencies are needed to compile, but must not ship.
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage.
FROM node:22-bookworm-slim AS runtime

# ffmpeg is a hard runtime dependency for splitting long episodes, so it is
# installed explicitly rather than assumed to exist on the host.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Unprivileged: the app writes only to temporary directories.
USER node

ENV PORT=10000
EXPOSE 10000

# Liveness only. It reports nothing about configuration; see src/server/app.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]
