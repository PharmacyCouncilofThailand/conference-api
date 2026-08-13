# ============================================
# Conference API - Production Dockerfile
# ============================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# ============================================
# Stage 2: Production
# ============================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV SERVICE_ROLE=api

# Install postgresql-client for health checks.
# PDF receipts are generated with @react-pdf/renderer (pure JS) — no browser/Chromium needed.
RUN apk add --no-cache \
    postgresql-client \
    python3 \
    py3-pip \
    tzdata \
    && rm -rf /var/cache/apk/*

COPY --from=builder /app/requirements.txt ./requirements.txt
RUN python3 -m venv /opt/pythainlp-venv \
    && /opt/pythainlp-venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PYTHAINLP_PYTHON=/opt/pythainlp-venv/bin/python

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/src/database/schema.ts ./src/database/schema.ts
COPY --from=builder /app/src/scripts/pythainlp-word-count.py ./dist/scripts/pythainlp-word-count.py

# Install production dependencies only
RUN npm install --legacy-peer-deps --omit=dev

# Copy font files for PDF receipt generation (@react-pdf / Sarabun → Thai support)
COPY --from=builder /app/public/Font ./public/Font

# Create public directory for static files (before switching to non-root user)
RUN mkdir -p /app/public

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 api

# Set ownership of app directory to api user
RUN chown -R api:nodejs /app

USER api

EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD if [ "$SERVICE_ROLE" = "worker" ]; then node dist/modules/team-registrations/jobs-runner.js --healthcheck; else wget --no-verbose --tries=1 --spider http://localhost:3002/health/ready; fi

# Run server (run db:push manually via DBeaver or Railway CLI)
CMD ["node", "dist/index.js"]
