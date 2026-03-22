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

# =============================================================================
# FIREBASE SERVICE ACCOUNT (for FCM push notifications)
# =============================================================================
# Downloads Firebase service account JSON from S3 if FIREBASE_SA_S3_URI is set.
# This enables dual-channel delivery (Socket.IO + FCM push).
# Example: FIREBASE_SA_S3_URI=s3://weelo-uploads/config/firebase-service-account.json
# =============================================================================
if [ -n "$FIREBASE_SA_S3_URI" ]; then
    echo "📥 Downloading Firebase service account from S3..."
    aws s3 cp "$FIREBASE_SA_S3_URI" /app/firebase-service-account.json --quiet 2>&1 && {
        export FIREBASE_SERVICE_ACCOUNT_PATH=/app/firebase-service-account.json
        echo "✅ Firebase service account ready (FCM enabled)"
    } || {
        echo "⚠️ Firebase service account download failed — FCM push disabled"
    }
fi

# Check if DATABASE_URL is set and starts with postgres
if [ -n "$DATABASE_URL" ] && echo "$DATABASE_URL" | grep -q "^postgres"; then
    echo "📦 PostgreSQL DATABASE_URL detected"
    echo "🔄 Running Prisma migrations to sync database schema..."

    # Industry-standard: prisma migrate deploy
    # - Tracks applied migrations in _prisma_migrations table
    # - Idempotent: skips already-applied migrations
    # - Does NOT drop data (unlike db push)
    # - If DB has no _prisma_migrations table yet → baseline first, then deploy

    # Step 1: Check if _prisma_migrations table exists (first-time setup)
    MIGRATION_TABLE_EXISTS=$(npx prisma migrate status 2>&1 | grep -c "No migration" || true)

    if echo "$(npx prisma migrate status 2>&1)" | grep -q "P3005\|The database schema is not empty"; then
        echo "📋 Existing DB detected — baselining previous migrations..."
        # Mark all pre-existing migrations as already applied (they were done via db push)
        npx prisma migrate resolve --applied "20260219_add_broadcast_lifecycle_states" 2>&1 || true
        npx prisma migrate resolve --applied "20260225_add_truckrequest_notified_transporters_gin_index" 2>&1 || true
        npx prisma migrate resolve --applied "20260228_phase2_reliability_core" 2>&1 || true
        npx prisma migrate resolve --applied "20260228_phase4_hold_reliability" 2>&1 || true
        npx prisma migrate resolve --applied "20260228_phase5_cancel_reliability" 2>&1 || true
        echo "✅ Baseline complete — existing migrations marked as applied"
    fi

    # Step 2: Deploy any NEW migrations (e.g. 20260321_hold_phase_system)
    npx prisma migrate deploy 2>&1 || {
        echo "❌ Prisma migrate deploy failed — aborting startup to prevent broken state"
        exit 1
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
