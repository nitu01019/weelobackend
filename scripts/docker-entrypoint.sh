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
    
    # ONE-TIME MIGRATION: Reset preferredLanguage for users who had the old
    # Prisma @default("en") auto-assigned (not explicitly chosen by user).
    # SAFETY: Uses a migrations tracking table so this runs EXACTLY ONCE,
    # never on subsequent container restarts — prevents wiping explicit choices.
    echo "🔄 Running one-time language migration (if not already applied)..."
    node -e "
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      async function run() {
        try {
          // Create migrations tracking table if it doesn't exist
          await prisma.\$executeRawUnsafe(\`
            CREATE TABLE IF NOT EXISTS \"_MigrationFlags\" (
              key VARCHAR(100) PRIMARY KEY,
              applied_at TIMESTAMPTZ DEFAULT NOW()
            )
          \`);
          // Check if this migration has already run
          const rows = await prisma.\$queryRawUnsafe(
            \`SELECT key FROM \"_MigrationFlags\" WHERE key = 'reset_default_language_en'\`
          );
          if (rows.length > 0) {
            console.log('✅ Language migration already applied, skipping');
            return;
          }
          // Run migration
          const count = await prisma.\$executeRawUnsafe(\`
            UPDATE \"User\" 
            SET \"preferredLanguage\" = NULL 
            WHERE \"preferredLanguage\" = 'en'
          \`);
          // Mark as applied
          await prisma.\$executeRawUnsafe(
            \`INSERT INTO \"_MigrationFlags\" (key) VALUES ('reset_default_language_en') ON CONFLICT DO NOTHING\`
          );
          console.log('✅ Reset preferredLanguage for', count, 'users (one-time migration complete)');
        } catch (err) {
          console.log('⚠️ Language migration skipped:', err.message);
        } finally {
          await prisma.\$disconnect();
        }
      }
      run();
    " 2>&1 || echo "⚠️ Language migration skipped"
    
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
