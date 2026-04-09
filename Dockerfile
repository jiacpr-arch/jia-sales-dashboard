# ── Build stage ──
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Production stage ──
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# SQLite data volume (mount at /app/data on Railway)
RUN mkdir -p /app/data

ENV NODE_ENV=production

# Railway injects PORT dynamically
EXPOSE ${PORT:-3001}

CMD ["node", "--experimental-sqlite", "dist/index.js"]
