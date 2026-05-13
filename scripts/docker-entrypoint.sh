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
set -o pipefail

# =============================================================================
# Migration-harness env-var hooks (Fix #25 + #30 — shellspec-pluggable)
# =============================================================================
# Tests inject SLEEP_FN=:, AWS_CLI=stub-aws, RAND_FN=__rand_zero, DATE_FN=frozen-date
# to make the migrate_with_retry + emit_migration_metric functions unit-testable.
# Production defaults preserve current behavior. Alpine ash supports `set -o pipefail`
# (without it, `cmd | tee` returns tee's rc=0 → silent migration-failure emitted as
# `migration_status=success` to CloudWatch).
: "${SLEEP_FN:=sleep}"
: "${AWS_CLI:=aws}"
: "${RAND_FN:=__rand_default}"
: "${DATE_FN:=date}"
__rand_default() { echo "$((RANDOM % 3))"; }

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
    # - Always baseline all known migrations first (resolve --applied is idempotent)
    #   This handles: empty _prisma_migrations table, P3005, or fresh DB scenarios

    # Step 1: Always baseline all known migrations (safe — idempotent, skips if already recorded)
    echo "📋 Baselining all known migrations (idempotent)..."
    npx prisma migrate resolve --applied "20260219_add_broadcast_lifecycle_states" 2>&1 || true
    npx prisma migrate resolve --applied "20260225_add_truckrequest_notified_transporters_gin_index" 2>&1 || true
    npx prisma migrate resolve --applied "20260228_phase2_reliability_core" 2>&1 || true
    npx prisma migrate resolve --applied "20260228_phase4_hold_reliability" 2>&1 || true
    npx prisma migrate resolve --applied "20260228_phase5_cancel_reliability" 2>&1 || true
    npx prisma migrate resolve --applied "20260321_hold_phase_system" 2>&1 || true
    npx prisma migrate resolve --applied "20260329_add_on_hold_status_and_vehicle_index" 2>&1 || true
    echo "✅ Baseline complete — all known migrations marked as applied"

    # =========================================================================
    # MIGRATION RETRY HARNESS (Fix #25) + ALARM EMIT WRAPPER (Fix #30)
    # =========================================================================
    # FF-gated: FF_MIGRATION_RETRY_HARNESS_ENABLED defaults OFF — current behavior
    # preserved byte-equivalent (raw `prisma migrate deploy` with same error message
    # and exit 1). FF=true engages retry-on-55P03 + CloudWatch metric emission.
    # Prereq for FF=true: Bootstrap PR-0 (scripts/bootstrap-prisma-migrations.sh)
    # must run first to create _prisma_migrations table on the prod DB
    # (CLAUDE.md L477-485). Without it, prisma migrate deploy hot-loops 5× then fails
    # with P3005.
    # =========================================================================
    migrate_with_retry() {
      # Mandatory #5: feature-flag the entire harness OFF until Bootstrap PR-0 completes.
      if [ "${FF_MIGRATION_RETRY_HARNESS_ENABLED:-false}" != "true" ]; then
        echo "[MIGRATE] harness disabled (FF_MIGRATION_RETRY_HARNESS_ENABLED!=true) — skipping"
        return 0
      fi

      local attempt=1 max=5
      while [ $attempt -le $max ]; do
        if npx prisma migrate deploy 2>&1 | tee /tmp/mig.log; then
          $AWS_CLI cloudwatch put-metric-data --namespace Weelo/Backend \
            --metric-name migration_status --value 1 \
            --dimensions result=success --region "${AWS_REGION:-ap-south-1}" || true
          echo "[MIGRATE] success attempt=$attempt"
          return 0
        fi
        if grep -qE "55P03|lock_not_available" /tmp/mig.log; then
          $AWS_CLI cloudwatch put-metric-data --namespace Weelo/Backend \
            --metric-name migration_lock_not_available_total --value 1 \
            --region "${AWS_REGION:-ap-south-1}" || true
          local jitter; jitter=$($RAND_FN)
          $SLEEP_FN $((5 * attempt + jitter))
          echo "[MIGRATE] retry attempt=$attempt reason=lock_not_available"
          attempt=$((attempt + 1))
        else
          echo "[MIGRATE] fail attempt=$attempt reason=non_lock_error"
          return 1
        fi
      done
      echo "[MIGRATE] giveup attempts=$max"
      return 1
    }

    emit_migration_metric() {
      local name=$1 value=$2 result=$3
      # || true neutralizes set -e for CloudWatch throttle/network blips; transient
      # API failures must not block boot. The [MIGRATE] log lines from migrate_with_retry
      # are the primary signal; CloudWatch is the alarm channel only.
      $AWS_CLI cloudwatch put-metric-data \
        --namespace Weelo/Backend \
        --metric-name "$name" --value "$value" \
        --dimensions "result=$result" \
        --region "${AWS_REGION:-ap-south-1}" 2>/dev/null || true
    }

    # Step 2: Deploy any NEW migrations added after the baseline
    if [ "${FF_MIGRATION_RETRY_HARNESS_ENABLED:-false}" = "true" ]; then
      start=$($DATE_FN +%s)
      if migrate_with_retry; then
        duration=$(( $($DATE_FN +%s) - start ))
        emit_migration_metric migration_duration_seconds "$duration" success
        emit_migration_metric migration_status 1 success
      else
        duration=$(( $($DATE_FN +%s) - start ))
        emit_migration_metric migration_duration_seconds "$duration" failed
        emit_migration_metric migration_status 1 failed
        exit 1
      fi
    else
      # FF=false: current behavior unchanged (legacy direct deploy)
      npx prisma migrate deploy 2>&1 || {
        echo "❌ Prisma migrate deploy failed — aborting startup to prevent broken state"
        exit 1
      }
    fi
    
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
