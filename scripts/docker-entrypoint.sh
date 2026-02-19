#!/bin/sh
# =============================================================================
# WEELO BACKEND - Docker Entrypoint
# =============================================================================
# 
# This script runs when the container starts:
# 1. Runs Prisma db push to create/update tables (if DATABASE_URL is set)
# 2. Starts the Node.js server
# 
# =============================================================================

set -e

echo "🚀 Starting Weelo Backend..."

# Check if DATABASE_URL is set and starts with postgres
if [ -n "$DATABASE_URL" ] && echo "$DATABASE_URL" | grep -q "^postgres"; then
    echo "📦 PostgreSQL DATABASE_URL detected"
    echo "🔄 Running Prisma db push to sync database schema..."
    
    # Run prisma db push to create/update tables
    # --accept-data-loss is NOT used - this will fail if there's data loss
    # --skip-generate because we already generated in Docker build
    npx prisma db push --skip-generate 2>&1 || {
        echo "⚠️ Prisma db push failed, but continuing..."
        echo "   Tables may already exist or there's a connection issue"
    }
    
    # Create OtpStore table (for cross-task OTP fallback when Redis is unavailable)
    # This table is NOT managed by Prisma — it's a simple key-value store for OTPs
    echo "🔑 Ensuring OtpStore table exists..."
    node -e "
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      prisma.\$executeRawUnsafe(\`
        CREATE TABLE IF NOT EXISTS \"OtpStore\" (
          phone VARCHAR(20) NOT NULL,
          role VARCHAR(20) NOT NULL,
          otp VARCHAR(100) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          attempts INT DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (phone, role)
        )
      \`).then(() => {
        console.log('✅ OtpStore table ready');
        return prisma.\$disconnect();
      }).catch(err => {
        console.log('⚠️ OtpStore table creation skipped:', err.message);
        return prisma.\$disconnect();
      });
    " 2>&1 || echo "⚠️ OtpStore setup skipped"
    
    # ONE-TIME MIGRATION: Reset preferredLanguage for ALL users who have the
    # old Prisma default "en". No user ever explicitly selected "en" via the
    # language screen — it was auto-assigned by @default("en") in the schema.
    # After reset, users will see the language selection screen on next login
    # and their explicit choice will be saved to backend (persists forever).
    # New schema has no default — new users will get NULL (shows language screen).
    echo "🔄 Resetting default language for all users with auto-assigned 'en'..."
    node -e "
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      prisma.\$executeRawUnsafe(\`
        UPDATE \"User\" 
        SET \"preferredLanguage\" = NULL 
        WHERE \"preferredLanguage\" = 'en'
      \`).then((count) => {
        console.log('✅ Reset preferredLanguage for', count, 'users (was auto-assigned en)');
        return prisma.\$disconnect();
      }).catch(err => {
        console.log('⚠️ Language reset skipped:', err.message);
        return prisma.\$disconnect();
      });
    " 2>&1 || echo "⚠️ Language reset skipped"
    
    echo "✅ Database sync complete"
else
    echo "📦 No PostgreSQL DATABASE_URL - Using JSON file database"
fi

echo "🚀 Starting server..."

# SCALABILITY: Use cluster mode in production for multi-core utilization
# Each worker handles requests independently, Redis provides shared state
if [ "$NODE_ENV" = "production" ] && [ -f "dist/cluster.js" ]; then
    echo "🏭 Starting in CLUSTER mode (production) ..."
    exec node dist/cluster.js
else
    echo "🔧 Starting in SINGLE process mode ..."
    exec node dist/server.js
fi
