# ── Build stage ───────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production=false

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Production stage ──────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "dist/index.js"]
