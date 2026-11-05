# syntax=docker/dockerfile:1

# ---- Build: admin UI (static) + server (TypeScript -> dist) ---------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
COPY apps/example-saas/package.json apps/example-saas/
COPY packages packages
COPY plugins plugins
RUN npm ci --no-audit --no-fund
COPY apps/server apps/server
COPY apps/admin apps/admin
RUN npm run build -w @steward/admin && npm run build -w @steward/server

# ---- Runtime ------------------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
COPY apps/example-saas/package.json apps/example-saas/
COPY packages packages
COPY plugins plugins
# Production dependencies of the server only (the admin UI ships as static files).
RUN npm ci --omit=dev --no-audit --no-fund -w @steward/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/server/runtime apps/server/runtime
COPY --from=build /app/apps/admin/dist apps/admin/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 4000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health > /dev/null || exit 1
# Migrations run automatically at startup (each one once, in a transaction).
CMD ["node", "apps/server/dist/main.js"]
