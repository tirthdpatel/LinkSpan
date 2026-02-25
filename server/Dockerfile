FROM node:22-alpine AS base
WORKDIR /app

# Copy shared module
COPY shared/ ./shared/

# Copy server files
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm ci --omit=dev

COPY server/src/ ./src/

EXPOSE 10000

ENV NODE_ENV=production
ENV PORT=10000

CMD ["node", "src/server.js"]
