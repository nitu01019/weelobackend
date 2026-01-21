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
# Stage 1: Builder
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci --legacy-peer-deps

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# -----------------------------------------------------------------------------
# Stage 2: Production
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# Security: Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S weelo -u 1001

WORKDIR /app

# Copy built application
COPY --from=builder --chown=weelo:nodejs /app/dist ./dist
COPY --from=builder --chown=weelo:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=weelo:nodejs /app/package*.json ./

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

# Start server (use cluster mode for production)
CMD ["node", "dist/cluster.js"]

# -----------------------------------------------------------------------------
# Stage 3: Development (optional)
# -----------------------------------------------------------------------------
FROM node:20-alpine AS development

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci --legacy-peer-deps

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Development command
CMD ["npm", "run", "dev"]
