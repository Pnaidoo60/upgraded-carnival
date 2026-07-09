# Portable container image for any host (Fly.io, Railway, Cloud Run, a VPS…).
#   docker build -t tradingview-claude .
#   docker run -p 3000:3000 --env-file .env tradingview-claude
FROM node:20-alpine

WORKDIR /app

# Install production dependencies from the lockfile first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# The server reads PORT from the environment (hosts usually inject their own).
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
