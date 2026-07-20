# syntax=docker/dockerfile:1.7

# ---------- deps ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run typecheck && npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# ffmpeg + ffprobe + fonts for template rendering.
# librsvg2-bin (rsvg-convert) is REQUIRED — we rasterize template SVGs with it
# because Debian's ffmpeg build does not include the SVG decoder.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg librsvg2-bin fonts-dejavu-core ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version >/dev/null \
 && ffprobe -version >/dev/null \
 && rsvg-convert --version >/dev/null

WORKDIR /app

# Only prod deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

COPY --from=build /app/dist ./dist

# Non-root user and writable dirs
RUN groupadd --system app && useradd --system --gid app --home /app app \
 && mkdir -p /data /tmp/editor-worker \
 && chown -R app:app /app /data /tmp/editor-worker

USER app
ENV PORT=3000 \
    DATA_DIR=/data \
    TEMP_DIR=/tmp/editor-worker

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
