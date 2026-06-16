# NOTE: nginx:alpine runs its master process as root to manage workers (no USER here →
# Trivy AVD-DS-0002). This image is deployed only via k8s/client-deployment.yaml, which
# enforces non-root at runtime (runAsNonRoot, runAsUser 101, readOnlyRootFilesystem, drop
# ALL caps, NET_BIND_SERVICE for :80). The finding is suppressed + dated in
# .trivyignore.yaml; preferred fix is the nginxinc/nginx-unprivileged base (listen 8080),
# pending a Docker build/run to verify (no Docker in the current dev env).

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY client/package*.json ./client/
COPY shared/ ./shared/

WORKDIR /app/client
RUN npm ci

COPY client/ ./

RUN npm run build

# ── Stage 2: Serve with Nginx ──────────────────────────────────
FROM nginx:alpine AS runtime

# Remove default nginx site
RUN rm -rf /usr/share/nginx/html/*

# Copy built SPA
COPY --from=builder /app/client/dist /usr/share/nginx/html

# Nginx config for SPA + security headers
COPY client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
