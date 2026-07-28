# Container image for the TradingView x Claude dashboard.
# Works on any container host — Fly.io, Render, Railway, Cloud Run, a VPS.
FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# The server reads PORT and binds all interfaces; /health is the liveness probe.
CMD ["node", "server.js"]
