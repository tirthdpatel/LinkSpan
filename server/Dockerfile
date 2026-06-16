# ══════════════════════════════════════════════════════════════
# LinkSpan Signaling Server — Multi-stage Production Dockerfile
# Stages: deps → build → production
# ══════════════════════════════════════════════════════════════

# ── Stage 1: deps ─────────────────────────────────────────────
# Install only production dependencies (cached layer)
FROM node:22-alpine AS deps

WORKDIR /app

# Copy manifests first for optimal layer caching
COPY server/package*.json ./server/
COPY shared/ ./shared/

WORKDIR /app/server
# Install only production dependencies (no devDeps)
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: build ────────────────────────────────────────────
# Copy source code (separate stage so source changes don't invalidate deps cache)
FROM node:22-alpine AS build

WORKDIR /app

# Bring in deps from previous stage
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/shared ./shared

# Copy source files
COPY server/src ./server/src
COPY server/package.json ./server/

# ── Stage 3: production ───────────────────────────────────────
# Minimal runtime image — non-root, read-only filesystem
FROM node:22-alpine AS production

# Security: create non-root user
RUN addgroup -S linkspan && adduser -S -G linkspan linkspan

WORKDIR /app

# Copy only the essentials from build stage
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/server/package.json ./server/
# Admin scripts (e.g. minting API keys) — not on the runtime path but handy in the image.
COPY server/scripts ./server/scripts

# Share-link blob storage directory. Created here and owned by the non-root user so a
# named volume / PVC mounted at this path inherits writable ownership on first init.
# Override the location with SHARE_STORAGE_DIR (mount a volume there in production).
RUN mkdir -p /data/blobs

# Set ownership to non-root user (app + blob storage), after all copies.
RUN chown -R linkspan:linkspan /app /data

ENV SHARE_STORAGE=filesystem \
    SHARE_STORAGE_DIR=/data/blobs

# Expose signaling port
EXPOSE 10000

# Persist uploaded share-link blobs across container restarts.
VOLUME ["/data/blobs"]

# Drop to non-root user
USER linkspan

# Health check — lightweight wget (available in alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:10000/health || exit 1

# Start the signaling server
CMD ["node", "--max-old-space-size=256", "server/src/server.js"]
