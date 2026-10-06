# WhatsApp AI Secretary — multi-stage (шаг 9).
# Runtime запускается от root осознанно: том ./data принадлежит
# пользователю хоста, а сервис локальный (слушает 127.0.0.1 по умолчанию).

# --- 1. Фронтенд ---
FROM node:20-alpine AS web-builder
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 2. Бэкенд (сборка TS + нативный better-sqlite3 под musl) ---
FROM node:20-alpine AS api-builder
RUN apk add --no-cache python3 make g++
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json drizzle.config.ts ./
COPY drizzle/ ./drizzle/
COPY src/ ./src/
RUN npm run build

# --- 3. Рантайм ---
# Только продакшен-зависимости + непривилегированный пользователь.
# /app/data — том с хоста: chown делает файлы доступными пользователю node.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=api-builder /build/dist ./dist
COPY --from=api-builder /build/drizzle ./drizzle
COPY --from=web-builder /build/web/dist ./web/dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
