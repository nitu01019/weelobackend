# =============================================================================
# WEELO BACKEND - Production Docker Image
# =============================================================================
#
# Multi-stage build for optimal image size and security.
#
# BUILD:
#   docker build -t weelo-backend:latest .
#
# RUN (Development):
#   docker run -p 3000:3000 --env-file .env weelo-backend:latest
#
# RUN (Production - with external services):
#   docker run -p 3000:3000 \
#     -e NODE_ENV=production \
#     -e RDS_HOST=your-rds-endpoint \
#     -e REDIS_HOST=your-redis-endpoint \
#     weelo-backend:latest
#
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build TypeScript + Generate Prisma (self-contained)
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files and prisma schema first (layer cache)
COPY package*.json ./
COPY prisma ./prisma

# Install ALL dependencies (devDeps needed for tsc + prisma)
RUN npm ci --legacy-peer-deps

# Generate Prisma client for linux-musl (Alpine)
RUN npx prisma generate

# Copy source code and tsconfig
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
# PRODUCTION: Build happens inside Docker — no local build needed
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Production Dependencies Only
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --legacy-peer-deps --omit=dev

# -----------------------------------------------------------------------------
# Stage 3: Production Runtime
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# Install OpenSSL for Prisma runtime + wget for healthcheck
RUN apk add --no-cache openssl

# Security: Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S weelo -u 1001

WORKDIR /app

# Copy production dependencies
COPY --from=deps --chown=weelo:nodejs /app/node_modules ./node_modules

# Copy generated Prisma client from builder stage
COPY --from=builder --chown=weelo:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=weelo:nodejs /app/node_modules/@prisma ./node_modules/@prisma

# Copy compiled dist from builder (NOT local — built inside Docker)
COPY --from=builder --chown=weelo:nodejs /app/dist ./dist

# Copy prisma schema and package files
COPY --chown=weelo:nodejs prisma ./prisma
COPY --chown=weelo:nodejs package*.json ./
COPY --chown=weelo:nodejs scripts/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

# Create logs directory
RUN mkdir -p logs && chown weelo:nodejs logs

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Switch to non-root user
USER weelo

# Start server via entrypoint (runs migration first, then starts server)
CMD ["./docker-entrypoint.sh"]

# -----------------------------------------------------------------------------
# Stage 3: Development (optional)
# -----------------------------------------------------------------------------
FROM node:20-alpine AS development

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files and prisma schema
COPY package*.json ./
COPY prisma ./prisma

# Install all dependencies
RUN npm ci --legacy-peer-deps

# CRITICAL FIX: Generate Prisma client for development
RUN npx prisma generate

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Development command
CMD ["npm", "run", "dev"]
