// =============================================================================
// FCM SERVICE ROTATION RUNBOOK
// =============================================================================
//
// CREDENTIAL ROTATION (perform during low-traffic window, ~03:00 IST):
//   1. Generate new service-account key in Firebase Console (IAM → Service Accounts).
//   2. Base64-encode: base64 -w0 new-key.json > new-key.b64
//   3. Store in AWS Secrets Manager as FIREBASE_PRIVATE_KEY_B64 (new version).
//   4. Update ECS Task Definition env with new secret version ARN — do NOT redeploy yet.
//   5. Verify staging ECS task picks up new key (watch fcm_init_missing_config counter).
//   6. Boot dry-run fires on startup — confirm fcm_boot_dry_run_latency_ms histogram
//      has a new data point with no auth-error class in CloudWatch.
//   7. Promote to production with blue-green swap. Old key still valid ~24h.
//   8. After 24h with no fcm_init_missing_config events, revoke old key in Firebase Console.
//
// MONITORING ALERTS (CloudWatch / Datadog):
//   - fcm_init_missing_config > 0 for 1 min   → CRITICAL: credential pipeline broken
//   - fcm_egress_rate_limited_total > 0        → WARN: burst exceeds 8K/s token bucket
//   - fcm_multicast_failure_ratio > 0.02       → AUTO-REVERT: set FF_FCM_MULTICAST_ENABLED=false
//   - fcm_send_connection_reuse_ratio < 0.8    → WARN: HTTP keep-alive not working
//   - fcm_dead_token_cleanup_total spike        → INFO: token churn expected after app update
//
// EMERGENCY KILL SWITCHES:
//   FF_FCM_MULTICAST_ENABLED=false  → revert to per-user sendToUser path
//   FF_FCM_DATA_ONLY_FULLSCREEN=false → revert to notification+data payload
//   FCM_FAIL_FAST_IN_PROD=false     → allow mock mode if credentials unavailable
// =============================================================================

/**
 * =============================================================================
 * FCM SERVICE - Firebase Cloud Messaging for Push Notifications
 * =============================================================================
 * 
 * Sends push notifications to mobile apps when:
 * - New booking broadcast is created
 * - Assignment status changes
 * - Trip status updates
 * - Payment received
 * 
 * SETUP REQUIRED:
 * 1. Create Firebase project at https://console.firebase.google.com
 * 2. Download service account key JSON
 * 3. Set FIREBASE_SERVICE_ACCOUNT_PATH in .env
 * 
 * FOR BACKEND DEVELOPERS:
 * - Use sendToUser() for targeted notifications
 * - Use sendToTopic() for broadcast to vehicle types
 * - Always include 'type' in data for client-side routing
 * 
 * SCALABILITY:
 * - FCM handles millions of messages automatically
 * - Use topics for efficient broadcast to groups
 * - Batch notifications when possible
 * =============================================================================
 */

import fs from 'fs';
import * as https from 'https';
import { createHash } from 'crypto';
import { logger } from './logger.service';
import { redisService } from './redis.service';
import { prismaClient } from '../database/prisma.service';
import { Prisma } from '@prisma/client';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { FLAGS, isEnabled } from '../config/feature-flags';
import { notifyUpgradeRequired } from './fcm-upgrade-campaign';
import { shouldSkipForVersion } from './fcm-version-gate';
import { maskName } from '../utils/pii.utils';

// Notification types - must match mobile apps
export const NotificationType = {
  NEW_BROADCAST: 'new_broadcast',
  ASSIGNMENT_UPDATE: 'assignment_update',
  TRIP_UPDATE: 'trip_update',
  PAYMENT: 'payment_received',
  GENERAL: 'general'
} as const;

// =============================================================================
// W-5 D3.T3 (A05-015 / Wave-0 D) — Firebase error-code normalization
// =============================================================================
// Maps the 10 well-known Firebase Admin SDK `messaging/*` error codes onto a
// closed enum of 7 categories. Used as the `category` label on
// `fcm_send_failure_total{category=<normalized>}` so the label cardinality is
// bounded (Prom OOMs at >1000 unique label values; raw FB codes can drift).
// Pure function — no I/O, no clock. Safe to import everywhere.
// =============================================================================
export type FcmErrorCategory =
  | 'INVALID_TOKEN'
  | 'NOT_REGISTERED'
  | 'INVALID_ARGUMENT'
  | 'QUOTA_EXCEEDED'
  | 'SERVER_UNAVAILABLE'
  | 'SERVER_ERROR'
  | 'AUTH_ERROR';

const FCM_ERROR_CODE_MAP: Record<string, FcmErrorCategory> = {
  'messaging/invalid-registration-token': 'INVALID_TOKEN',
  'messaging/registration-token-not-registered': 'NOT_REGISTERED',
  'messaging/invalid-argument': 'INVALID_ARGUMENT',
  'messaging/quota-exceeded': 'QUOTA_EXCEEDED',
  'messaging/server-unavailable': 'SERVER_UNAVAILABLE',
  'messaging/internal-error': 'SERVER_ERROR',
  'messaging/unknown-error': 'SERVER_ERROR',
  'messaging/too-many-topics': 'QUOTA_EXCEEDED',
  'messaging/invalid-apns-credentials': 'AUTH_ERROR',
  'messaging/mismatched-credential': 'AUTH_ERROR',
};

export function normalizeFirebaseErrorCode(fbCode: string): FcmErrorCategory {
  return FCM_ERROR_CODE_MAP[fbCode] ?? 'SERVER_ERROR';
}

// =============================================================================
// FCM TOKEN STORAGE
// =============================================================================
//
// SCALABILITY:
// - Primary: Redis SET per userId — shared across all ECS instances
// - 90-day TTL on Redis keys (FCM tokens expire ~60 days)
//
// EASY UNDERSTANDING:
// - registerToken() → Add token to user's set (Redis SADD = no duplicates)
// - removeToken() → Remove token from user's set (Redis SREM)
// - getTokens() → Get all tokens for a user (Redis SMEMBERS)
//
// MODULARITY:
// - Uses existing redisService singleton (no new connections)
// =============================================================================

// Redis key pattern for FCM tokens
const FCM_TOKEN_KEY = (userId: string) => `fcm:tokens:${userId}`;

// FCM tokens expire after ~60 days, we set 90-day TTL for safety
const FCM_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

// =============================================================================
// INIT-PATH LOG REDACTOR
// Removes PEM blocks and long base64 runs from strings before logging.
// Prevents private-key material from appearing in structured log payloads
// (CloudWatch, Datadog, etc.) which could be scraped by observability tools.
// =============================================================================

/**
 * Redact PEM blocks and long base64 sequences from a string or Error.
 * Used exclusively on FCM init/catch/dry-run log paths.
 *
 * @param input - raw error message or arbitrary string
 * @returns sanitised string safe to pass to logger
 */
function redactInitLog(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input ?? '');
  return raw
    // Remove PEM-formatted key blocks (-----BEGIN ... -----END ...-----)
    .replace(/-----BEGIN [^\n]+-----[\s\S]*?-----END [^\n]+-----/g, '[PEM_REDACTED]')
    // Remove runs of 40+ base64 characters (private key fragments, tokens)
    .replace(/[A-Za-z0-9+/=]{40,}/g, '[B64_REDACTED]');
}

/**
 * FCM Service class
 *
 * SCALABILITY:
 * - FCM tokens stored in Redis (shared across ECS instances)
 * - Falls back to in-memory Map if Redis is unavailable
 * - Firebase Admin SDK handles millions of messages automatically
 *
 * EASY UNDERSTANDING:
 * - Firebase Admin SDK integration is optional
 * - Works without it by logging notifications (useful for development)
 * - Token storage is transparent — Redis or in-memory, same API
 *
 * MODULARITY:
 * - Token storage is decoupled from notification sending
 * - Can switch storage backend without changing notification logic
 *
 * To enable real push notifications:
 * 1. npm install firebase-admin
 * 2. Set FIREBASE_SERVICE_ACCOUNT_PATH in .env
 * 3. Uncomment Firebase Admin initialization below
 */
class FCMService {
  private isInitialized = false;
  private admin: any = null;
  private mockModeReason?: string;

  /**
   * FCM error codes that should never be retried.
   * P7-T02 (A05-011): Added authentication-error, unauthorized, sender-id-mismatch.
   * These indicate a permanent credential or project mismatch — retrying wastes
   * ~450K API calls/day at Weelo's volume and never recovers without operator action.
   */
  private static readonly NON_RETRYABLE_FCM_ERRORS = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
    'messaging/mismatched-credential',
    'messaging/third-party-auth-error',
    // P7-T02 additions — credential/project mismatches are permanent errors
    'messaging/authentication-error',
    'messaging/unauthorized',
    'messaging/sender-id-mismatch',
  ]);

  // ===========================================================================
  // P7-T01 (A05-002 / Part B P7-F): In-process egress token bucket for FCM.
  // Google's FCM quota is 10K msgs/s per project. At 100 concurrent goroutines
  // × 500 tokens = 50K msgs/s burst is possible without a gate.
  // We gate at 8K/s (80% of Google's cap) to leave headroom for transient spikes.
  //
  // Implementation: lazy-refill token bucket (same pattern as rate-limiter.middleware.ts).
  //   tokens       : number of tokens currently available (max = FCM_EGRESS_BUCKET_MAX)
  //   lastRefill   : last refill timestamp (ms)
  // Thread safety: JS is single-threaded — no CAS needed for in-process bucket.
  // ===========================================================================
  private _fcmEgressTokens = 8000;          // start full
  private _fcmEgressLastRefill = Date.now();
  /** Max tokens == rate per second == 8000 msgs/s */
  private static readonly FCM_EGRESS_RATE_PER_SEC = 8000;

  /**
   * P7-T01: Consume `count` egress tokens. Returns true if allowed, false if
   * rate-limited (caller should back off or drop the batch).
   * Emits `fcm_egress_rate_limited_total` counter on reject.
   */
  private _consumeEgressTokens(count: number): boolean {
    const now = Date.now();
    const elapsedSec = (now - this._fcmEgressLastRefill) / 1000;
    // Refill tokens proportional to elapsed time (capped at bucket max)
    this._fcmEgressTokens = Math.min(
      FCMService.FCM_EGRESS_RATE_PER_SEC,
      this._fcmEgressTokens + elapsedSec * FCMService.FCM_EGRESS_RATE_PER_SEC
    );
    this._fcmEgressLastRefill = now;
    if (this._fcmEgressTokens >= count) {
      this._fcmEgressTokens -= count;
      return true;
    }
    // Rate limited — emit metric and reject
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { metrics } = require('../monitoring/metrics.service');
      metrics.incrementCounter('fcm_egress_rate_limited_total', { batch_size: count > 500 ? '>500' : String(count) });
    } catch { /* non-fatal */ }
    return false;
  }

  /**
   * Initialize Firebase Admin SDK
   * Call this on server startup
   *
   * Credential resolution order:
   * 1. File-based: FIREBASE_SERVICE_ACCOUNT_PATH (local dev, existing behavior)
   * 2. Inline env vars: FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY (or FIREBASE_PRIVATE_KEY_B64) + FIREBASE_CLIENT_EMAIL (production ECS)
   * 3. Mock mode: no credentials — notifications logged to console only
   *
   * P1-T20: If FIREBASE_PRIVATE_KEY_B64 is set and non-empty, it takes precedence
   *         over FIREBASE_PRIVATE_KEY (base64-decoded, Prime Video re:Invent pattern).
   * P1-T21: In production, credential init failure triggers process.exit(1) unless
   *         FCM_FAIL_FAST_IN_PROD=false (rollback gate).
   * P1-T22: After successful init in production, a dry-run send validates the
   *         credential pipeline end-to-end.
   * P1-T23: Every failure path emits fcm_init_missing_config with an enum reason label.
   * P1-T46: Dry-run send latency is observed as fcm_boot_dry_run_latency_ms histogram.
   */
  async initialize(): Promise<void> {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const isProduction = process.env.NODE_ENV === 'production';
    const failFastEnabled = process.env.FCM_FAIL_FAST_IN_PROD !== 'false';

    // P1-T20: Prefer base64-encoded private key (FIREBASE_PRIVATE_KEY_B64) over
    // the literal-\n variant (FIREBASE_PRIVATE_KEY). Resolves ECS secret injection
    // environments where newlines get double-escaped.
    let resolvedPrivateKey: string | undefined;
    const privateKeyB64 = process.env.FIREBASE_PRIVATE_KEY_B64;
    if (privateKeyB64 && privateKeyB64.trim().length > 0) {
      try {
        resolvedPrivateKey = Buffer.from(privateKeyB64, 'base64').toString('utf8');
      } catch (b64Err) {
        // Decoding failed — fall through to FIREBASE_PRIVATE_KEY fallback
        logger.warn('[FCM] FIREBASE_PRIVATE_KEY_B64 decode failed, falling back to FIREBASE_PRIVATE_KEY', {
          error: redactInitLog(b64Err),
        });
        this._emitInitFailureMetric('base64_decode_failed');
        if (isProduction && failFastEnabled) {
          logger.error('[FCM] CRITICAL: base64 key decode failed in production — exiting');
          process.exit(1);
        }
      }
    }
    // Fallback: literal \n → real newlines (existing behaviour)
    if (!resolvedPrivateKey) {
      const rawKey = process.env.FIREBASE_PRIVATE_KEY;
      if (rawKey) {
        resolvedPrivateKey = rawKey.replace(/\\n/g, '\n');
      }
    }

    const hasFileCreds = !!serviceAccountPath;
    const hasInlineCreds = !!(projectId && resolvedPrivateKey && clientEmail);

    // --- Strategy 1: File-based credentials ---
    if (hasFileCreds) {
      try {
        const firebaseAdmin = await import('firebase-admin');
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        // P7-T03 (A13-003 / Part B P7-G): Top-level httpAgent with keep-alive and
        // maxSockets:400 reduces connection-setup overhead by reusing TCP connections
        // for messaging().send() calls. NOTE: credential-level httpAgent only covers
        // token minting (OAuth2 token fetch), NOT the messaging send path.
        // AppOptions.httpAgent covers the full Firebase Admin SDK HTTP transport.
        const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 400, maxFreeSockets: 50 });
        firebaseAdmin.initializeApp({
          credential: firebaseAdmin.credential.cert(serviceAccount),
          httpAgent: _httpsAgent,
        });
        this.admin = firebaseAdmin;
        this.isInitialized = true;
        logger.info('[FCM] Firebase: file credentials — SDK initialized');
        // P1-T22: boot dry-run (production only)
        await this._bootDryRun(isProduction, failFastEnabled);
        return;
      } catch (error) {
        logger.warn('[FCM] File-based init failed, trying inline credentials...', {
          error: redactInitLog(error),
        });
        // Fall through to inline
      }
    }

    // --- Strategy 2: Inline environment variable credentials ---
    if (hasInlineCreds) {
      try {
        const firebaseAdmin = await import('firebase-admin');
        // P7-T03 (A13-003 / Part B P7-G): Top-level httpAgent — same as file-based path.
        const _httpsAgent2 = new https.Agent({ keepAlive: true, maxSockets: 400, maxFreeSockets: 50 });
        firebaseAdmin.initializeApp({
          credential: firebaseAdmin.credential.cert({
            projectId: projectId!,
            privateKey: resolvedPrivateKey!,
            clientEmail: clientEmail!,
          } as any),
          httpAgent: _httpsAgent2,
        });
        this.admin = firebaseAdmin;
        this.isInitialized = true;
        logger.info('[FCM] Firebase: inline credentials — SDK initialized');
        // P1-T22: boot dry-run (production only)
        await this._bootDryRun(isProduction, failFastEnabled);
        return;
      } catch (error) {
        this._emitInitFailureMetric('pem_parse_failed');
        logger.warn('[FCM] Inline credential init failed. Falling back to mock mode.', {
          error: redactInitLog(error),
        });
        // P1-T21: fail-fast in production
        if (isProduction && failFastEnabled) {
          logger.error('[FCM] CRITICAL: inline credential init failed in production — exiting');
          process.exit(1);
        }
      }
    }

    // --- Strategy 3: Mock mode ---
    if (isProduction) {
      this.mockModeReason = 'No Firebase credentials found in production environment';
      this._emitInitFailureMetric('env_missing');
      logger.error('[FCM] Firebase: MOCK MODE — no credentials found in production. Push notifications DISABLED.');
      // P1-T21: fail-fast in production on missing credentials
      if (failFastEnabled) {
        logger.error('[FCM] CRITICAL: no FCM credentials in production — exiting');
        process.exit(1);
      }
    } else {
      this.mockModeReason = 'Development mode — no Firebase credentials configured';
      logger.warn('[FCM] Firebase: MOCK MODE (console only). Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID+FIREBASE_PRIVATE_KEY+FIREBASE_CLIENT_EMAIL to enable.');
    }
  }

  /**
   * P1-T23: Emit fcm_init_missing_config counter with an enum reason label.
   * Reason values are a closed enum — never pass raw error messages (high-cardinality/PII).
   */
  private _emitInitFailureMetric(
    reason: 'base64_decode_failed' | 'pem_parse_failed' | 'dry_run_failed' | 'env_missing'
  ): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { metrics } = require('../monitoring/metrics.service');
      metrics.incrementCounter('fcm_init_missing_config', { reason });
    } catch { /* metrics not available during early boot */ }
  }

  /**
   * P1-T22 / P1-T46: Boot dry-run to validate credential pipeline end-to-end.
   * Only runs in production. Sends a dry-run message to a known-invalid token —
   * Firebase validates the credential and OAuth minting path without delivering.
   *
   * On Firebase auth / OAuth error in production → process.exit(1).
   * On token-not-found (expected) → success, credential is valid.
   * Non-production: skipped entirely (no-op).
   */
  private async _bootDryRun(isProduction: boolean, failFastEnabled: boolean): Promise<void> {
    // P1-T22: dry-run is production-only
    if (!isProduction || !this.admin) return;
    const dryRunStart = Date.now();
    try {
      await this.admin.messaging().send(
        { token: 'invalid-dry-run-token', dryRun: true },
      );
      // Unexpected success (shouldn't happen with invalid token), treat as OK
      const elapsedMs = Date.now() - dryRunStart;
      this._observeDryRunLatency(elapsedMs);
    } catch (dryRunErr: any) {
      const elapsedMs = Date.now() - dryRunStart;
      const code: string = dryRunErr?.errorInfo?.code || dryRunErr?.code || '';
      // messaging/registration-token-not-registered = expected with invalid token
      // This means the credential pipeline works correctly.
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        this._observeDryRunLatency(elapsedMs);
        logger.info('[FCM] Boot dry-run: credential pipeline OK (invalid-token response as expected)');
        return;
      }
      // Any other error = auth/OAuth failure — credentials did not pass Firebase validation
      this._emitInitFailureMetric('dry_run_failed');
      logger.error('[FCM] Boot dry-run failed — credential pipeline error', {
        code,
        error: redactInitLog(dryRunErr),
      });
      if (isProduction && failFastEnabled) {
        logger.error('[FCM] CRITICAL: boot dry-run failed in production — exiting');
        process.exit(1);
      }
    }
  }

  /**
   * P1-T46: Emit boot dry-run latency histogram.
   */
  private _observeDryRunLatency(elapsedMs: number): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { metrics } = require('../monitoring/metrics.service');
      metrics.observeHistogram('fcm_boot_dry_run_latency_ms', elapsedMs);
    } catch { /* metrics not available during early boot */ }
  }

  // ===========================================================================
  // HEALTH / STATUS (C-1, H-2)
  // ===========================================================================

  /**
   * Returns true when the Firebase Admin SDK initialized successfully.
   * Use in health-check endpoints to gate readiness.
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Returns true when running in mock mode (notifications are logged, not sent).
   */
  getMockModeActive(): boolean {
    return !this.isInitialized;
  }

  /**
   * Structured status for health-check and diagnostics endpoints.
   */
  getStatus(): { initialized: boolean; mockMode: boolean; reason?: string } {
    return {
      initialized: this.isInitialized,
      mockMode: !this.isInitialized,
      ...(this.mockModeReason ? { reason: this.mockModeReason } : {}),
    };
  }

  // ===========================================================================
  // TOKEN MANAGEMENT (Redis-backed with in-memory fallback)
  // ===========================================================================

  /**
   * Check if Redis is available for token storage
   * 
   * EASY UNDERSTANDING: Simple boolean check — no complex logic
   * MODULARITY: Centralized check used by all token methods
   */
  private isRedisAvailable(): boolean {
    return redisService.isRedisEnabled() && redisService.isConnected();
  }

  /**
   * Register FCM token for a user
   * Called when mobile app sends its FCM token after login
   * 
   * SCALABILITY: Uses Redis SADD — atomic, no duplicates, O(1)
   * - Token is added to user's set in Redis (shared across all servers)
   * - 90-day TTL ensures stale tokens are cleaned up automatically
   * - Falls back to in-memory Map if Redis is unavailable
   * 
   * EASY UNDERSTANDING: SADD = Set Add. If token already exists, it's a no-op.
   */
  async registerToken(
    userId: string,
    token: string,
    platform: string = 'android',
    appVersionCode?: number | null,
    installId?: string | null,
    previousToken?: string | null
  ): Promise<boolean> {
    let redisOk = false;

    // Try Redis first (primary storage)
    if (this.isRedisAvailable()) {
      try {
        const key = FCM_TOKEN_KEY(userId);
        // F-FCM-01 (Phase 4): symmetric token rotation. SREM the stale
        // previousToken BEFORE SADD'ing the new token. Order matters — if SADD
        // throws after SREM succeeds the user has zero tokens for one request
        // cycle (acceptable; better than two divergent tokens). previousToken
        // and token are different values so SREM cannot drop the new entry.
        if (typeof previousToken === 'string' && previousToken.length > 0 && previousToken !== token) {
          try {
            await redisService.sRem(key, previousToken);
          } catch (sremErr: unknown) {
            // Non-fatal — best-effort prune of stale token. Fall through to SADD.
            logger.warn(`FCM: Redis sRem(previousToken) failed during rotation`, {
              userId,
              error: sremErr instanceof Error ? sremErr.message : String(sremErr),
            });
          }
        }
        await redisService.sAdd(key, token);
        await redisService.expire(key, FCM_TOKEN_TTL_SECONDS);
        logger.info(`FCM: Token registered for user ${userId} [Redis]`);
        redisOk = true;
      } catch (error: any) {
        // FIX A5#20: Remove in-memory write fallback — unbounded Map is a memory leak
        // on long-running ECS instances and tokens written here are invisible to other
        // instances. Log error and fall through to DB fallback.
        logger.error(`FCM: Redis registerToken failed`, {
          userId,
          error: error.message,
        });
      }
    }

    // Fix H15: Always persist to DB as durable fallback (even if Redis succeeded).
    // If Redis loses data (restart/eviction), getTokens() recovers from here.
    //
    // ADR: A05-027 — dual-strategy upsert for mixed-fleet rollout.
    //   - New clients send installId → upsert keys off (userId, installId)
    //     (matches partial unique applied via A05-022 SQL).
    //   - Legacy clients (no installId, pre-rollout binaries) → upsert keys
    //     off the existing UNIQUE(token) so multi-device legacy users no
    //     longer collapse onto a single 'legacy' sentinel row.
    //
    // A05-015: appVersionCode written only when the caller supplied it;
    // null/undefined skips the column so callers on the legacy 3-arg
    // signature stay backward-compatible.
    try {
      const versionPatch =
        typeof appVersionCode === 'number' ? { appVersionCode } : {};
      const hasInstallId =
        typeof installId === 'string' && installId.length > 0 && installId !== 'legacy';
      const now = new Date();

      if (hasInstallId) {
        // New-client path: stable per-install identity. The Prisma `@@unique
        // ([userId, installId])` directive was intentionally removed (council
        // finding from code-quality review — see Phase 2 Task 2.A) so we
        // can't `upsert` keyed on a synthetic compound. Instead we do a
        // find-then-update/create with a race-fallback that re-reads on
        // unique-violation. The DB-side partial unique
        // (DeviceToken_userId_installId_partial_key WHERE installId IS NOT
        // NULL AND installId <> 'legacy') guarantees at most one active row
        // per device, even under concurrent registration.
        const installIdValue = installId as string;
        const existing = await prismaClient.deviceToken.findFirst({
          where: { userId, installId: installIdValue },
          select: { id: true },
        });
        if (existing) {
          await prismaClient.deviceToken.update({
            where: { id: existing.id },
            data: { token, platform, lastSeenAt: now, ...versionPatch },
          });
        } else {
          try {
            await prismaClient.deviceToken.create({
              data: {
                userId,
                token,
                platform,
                installId: installIdValue,
                lastSeenAt: now,
                ...versionPatch,
              },
            });
          } catch (createErr: unknown) {
            // Race fallback — narrowed to Prisma's UNIQUE-violation (P2002)
            // so genuine connection / constraint / disk errors propagate
            // instead of being silently swallowed by the re-read path.
            const isUniqueViolation =
              createErr instanceof Prisma.PrismaClientKnownRequestError &&
              createErr.code === 'P2002';
            if (!isUniqueViolation) throw createErr;
            const raced = await prismaClient.deviceToken.findFirst({
              where: { userId, installId: installIdValue },
              select: { id: true },
            });
            if (!raced) throw createErr;
            await prismaClient.deviceToken.update({
              where: { id: raced.id },
              data: { token, platform, lastSeenAt: now, ...versionPatch },
            });
          }
        }
      } else {
        // Legacy-client path: per-token uniqueness (existing @unique(token)).
        // installId stored as NULL so the partial unique excludes it; refresh
        // re-attaches the row to the current userId if it migrated devices.
        await prismaClient.deviceToken.upsert({
          where: { userId_token: { userId, token } },
          update: { platform, lastSeenAt: now, ...versionPatch },
          create: {
            userId,
            token,
            platform,
            installId: null,
            lastSeenAt: now,
            ...versionPatch,
          },
        });
      }
    } catch (dbErr: unknown) {
      // Non-fatal: DB fallback is best-effort. Redis is primary.
      logger.warn('FCM: DB fallback write failed', {
        userId,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    if (!redisOk && !this.isRedisAvailable()) {
      logger.error(`FCM: Redis unavailable — token stored in DB only for user ${userId}`);
    }

    return redisOk;
  }

  /**
   * Remove FCM token (on logout or token refresh)
   * 
   * SCALABILITY: Uses Redis SREM — atomic removal, O(1)
   * EASY UNDERSTANDING: SREM = Set Remove. If token doesn't exist, it's a no-op.
   */
  async removeToken(userId: string, token: string): Promise<void> {
    // Try Redis first
    if (this.isRedisAvailable()) {
      try {
        const key = FCM_TOKEN_KEY(userId);
        await redisService.sRem(key, token);
        logger.info(`FCM: Token removed for user ${userId} [Redis]`);
      } catch (error: any) {
        logger.warn(`FCM: Redis removeToken failed: ${error.message}. Using fallback.`);
      }
    } else {
      logger.warn(`[FCM] Redis unavailable — cannot remove token from Redis for user ${userId}`);
    }

    // Also clean PostgreSQL (prevents stale token resurrection after Redis restart)
    try {
      await prismaClient.deviceToken.deleteMany({ where: { userId, token } });
    } catch (dbErr: any) {
      logger.warn(`FCM: DB token cleanup failed: ${dbErr.message}`, { userId });
    }
  }

  /**
   * Remove all FCM tokens for a user (logout hard cleanup).
   *
   * Keeps backward compatibility with token-specific unregister while allowing
   * server-side fail-safe cleanup when client logout sequence is interrupted.
   */
  async removeAllTokens(userId: string): Promise<void> {
    if (this.isRedisAvailable()) {
      try {
        await redisService.del(FCM_TOKEN_KEY(userId));
        logger.info(`FCM: All tokens removed for user ${userId} [Redis]`);
      } catch (error: any) {
        logger.warn(`FCM: Redis removeAllTokens failed: ${error.message}. Using fallback.`);
      }
    } else {
      logger.warn(`[FCM] Redis unavailable — cannot remove all tokens from Redis for user ${userId}`);
    }

    // Also clean PostgreSQL (prevents stale token resurrection after Redis restart)
    try {
      await prismaClient.deviceToken.deleteMany({ where: { userId } });
    } catch (dbErr: any) {
      logger.warn(`FCM: DB token cleanup failed: ${dbErr.message}`, { userId });
    }
  }

  /**
   * Get all tokens for a user
   * 
   * SCALABILITY: Uses Redis SMEMBERS — returns all set members, O(N)
   * EASY UNDERSTANDING: Returns array of FCM tokens for the user's devices
   * 
   * NOTE: This is async now (Redis operations are async).
   * All callers already use `await` or `.then()` patterns.
   */
  async getTokens(userId: string): Promise<string[]> {
    // Try Redis first
    if (this.isRedisAvailable()) {
      try {
        const key = FCM_TOKEN_KEY(userId);
        const tokens = await redisService.sMembers(key);
        if (tokens.length > 0) {
          return tokens;
        }
        // Redis returned empty — fall through to DB fallback
      } catch (error: any) {
        logger.warn(`FCM: Redis getTokens failed: ${error.message}. Trying DB fallback.`);
      }
    }

    // Fix H15: Fall back to PostgreSQL if Redis returned empty or is unavailable.
    // This recovers tokens after Redis restart/eviction without losing push capability.
    try {
      // P7-T06 (A05-004): Filter revoked tokens and tokens unseen in 90 days.
      // revokedAt IS NULL excludes tokens explicitly soft-revoked on UNREGISTERED errors.
      // lastSeenAt > 90d excludes tokens not refreshed recently (token likely expired).
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const dbTokens = await prismaClient.deviceToken.findMany({
        where: {
          userId,
          // P7-T06: revokedAt and lastSeenAt filters — column added via direct SQL (see schema.prisma).
          // Cast to any because Prisma-generated types predate the direct-SQL column addition.
          // CLAUDE.md DB rule: never use prisma migrate deploy / prisma db push on this DB.
          revokedAt: null,
          lastSeenAt: { gt: ninetyDaysAgo },
        } as any,
        select: { token: true }
      });
      if (dbTokens.length > 0) {
        logger.info(`FCM: Retrieved ${dbTokens.length} token(s) from DB fallback`, { userId });
        return dbTokens.map(t => t.token);
      }
    } catch (dbErr: any) {
      logger.warn('FCM: DB fallback read failed', { userId, error: dbErr.message });
    }

    logger.warn('[FCM] No tokens found in Redis or DB', { userId });
    return [];
  }

  /**
   * Send notification to a specific user
   * 
   * SCALABILITY: Fetches tokens from Redis (shared across instances)
   * EASY UNDERSTANDING: Get tokens → send to all devices → return success
   */
  async sendToUser(
    userId: string,
    notification: FCMNotification
  ): Promise<boolean> {
    // H-04 FIX: Check notification preferences before sending.
    // Transactional types (trip status, payments, security, assignments) always send.
    // For non-transactional types, respect user opt-out stored in Redis.
    const notifType = notification.data?.type || 'general';
    // L-03 FIX: Expanded transactional types list to cover all driver/customer critical notifications.
    // These always send regardless of notification preferences (user cannot opt out of trip-critical comms).
    // H-18 Fix B (Phase 1): broadcasts are revenue-gating — always send.
    const ALWAYS_SEND = ['trip_status', 'payment', 'security', 'assignment_update', 'trip_assigned', 'driver_timeout', 'driver_assigned', 'trip_update', 'new_broadcast'];
    if (!ALWAYS_SEND.includes(notifType)) {
      try {
        const prefsStr = await redisService.get(`notification_prefs:${userId}`);
        if (prefsStr) {
          const prefs = JSON.parse(prefsStr);
          if (prefs[notifType] === false || prefs.push?.[notifType] === false) {
            logger.debug(`FCM: User ${userId} opted out of ${notifType}`);
            return false;
          }
        }
      } catch { /* prefs check non-fatal */ }
    }

    const tokens = await this.getTokens(userId);

    if (tokens.length === 0) {
      logger.debug(`FCM: No tokens found for user ${userId}`);
      return false;
    }

    return this.sendToTokens(tokens, notification, userId);
  }

  /**
   * Send notification to multiple users
   */
  async sendToUsers(
    userIds: string[],
    notification: FCMNotification
  ): Promise<number> {
    // Batch FCM sends to avoid overwhelming Firebase (max 50 concurrent)
    const BATCH_SIZE = 50;
    const results: PromiseSettledResult<boolean>[] = [];
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(userId => this.sendToUser(userId, notification))
      );
      results.push(...batchResults);
    }
    return results.filter(r => r.status === 'fulfilled' && r.value).length;
  }

  /**
   * Send notification to FCM tokens
   */
  async sendToTokens(
    tokens: string[],
    notification: FCMNotification,
    userId?: string
  ): Promise<boolean> {
    if (tokens.length === 0) return false;

    const message = this.buildMessage(notification, tokens);

    if (!this.isInitialized || !this.admin) {
      // Mock mode - log notification instead
      this.logNotification(notification, tokens);
      // C-1: Track mock-mode drops so dashboards surface silent failures
      try {
        const { metrics } = require('../monitoring/metrics.service');
        metrics.incrementCounter('fcm_mock_mode_drop_total');
      } catch { /* metrics not available */ }
      // M20 FIX: Mock mode returns false — notification was NOT delivered
      return false;
    }

    try {
      // H-28 FIX: Wrap Firebase SDK calls with executeWithRetry so transient
      // errors (503, network hiccups) are retried automatically with backoff.
      await this.executeWithRetry(async () => {
        if (tokens.length === 1) {
          await this.admin.messaging().send({
            ...message,
            token: tokens[0]
          });
        } else {
          // =====================================================================
          // INDUSTRY PATTERN (Uber/Grab): Clean dead FCM tokens on multicast.
          // FCM returns per-token responses. If a token gets UNREGISTERED or
          // NOT_FOUND, the app was uninstalled or token rotated — remove it.
          // Without cleanup, every future notification to this user fails silently.
          // =====================================================================
          const sendLatencyStart = Date.now();
          const sendResult = await this.admin.messaging().sendEachForMulticast({
            ...message,
            tokens
          });
          // M-16 (Phase 5): FCM observability — success/failure/latency
          // counters + dead-token cleanup counter. `tokens_bucket` is a
          // low-cardinality label (1|2-10|11-50|51-250|251-500).
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { metrics } = require('../monitoring/metrics.service');
            const bucket =
              tokens.length === 1 ? '1' :
              tokens.length <= 10 ? '2-10' :
              tokens.length <= 50 ? '11-50' :
              tokens.length <= 250 ? '51-250' : '251-500';
            const latencyMs = Date.now() - sendLatencyStart;
            metrics.observeHistogram?.('fcm_send_latency_ms', latencyMs, { type: notification.type });
            const successes = sendResult.successCount || 0;
            const failures = sendResult.failureCount || 0;
            if (successes > 0) {
              metrics.incrementCounter('fcm_send_success_total', { type: notification.type, tokens_bucket: bucket }, successes);
              metrics.incrementCounter('fcm_quota_consumed_total', { type: notification.type, tokens_bucket: bucket }, successes);
            }
            if (failures > 0) {
              metrics.incrementCounter('fcm_send_failure_total', { type: notification.type, error_code: 'multicast_partial' }, failures);
            }
          } catch { /* metrics unavailable — never break the send */ }
          // Clean up dead tokens
          if (sendResult.failureCount > 0 && userId) {
            const deadTokens: string[] = [];
            sendResult.responses.forEach((resp: any, idx: number) => {
              if (
                resp.error &&
                (resp.error.code === 'messaging/registration-token-not-registered' ||
                 resp.error.code === 'messaging/invalid-registration-token')
              ) {
                deadTokens.push(tokens[idx]);
              }
            });
            if (deadTokens.length > 0) {
              logger.info(`FCM: Cleaning ${deadTokens.length} dead token(s) for user ${userId}`);
              try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { metrics } = require('../monitoring/metrics.service');
                metrics.incrementCounter('fcm_dead_token_cleanup_total', {}, deadTokens.length);
              } catch { /* non-fatal */ }
              for (const deadToken of deadTokens) {
                this.removeToken(userId, deadToken).catch((err) => logger.warn('[FCM] Token cleanup failed', { userId, error: err instanceof Error ? err.message : String(err) }));
              }
            }
          }
        }
      }, 2);

      logger.info(`FCM: Notification sent to ${tokens.length} device(s)`);
      return true;
    } catch (error: any) {
      // =====================================================================
      // SINGLE TOKEN: If error is UNREGISTERED/NOT_FOUND, clean it up
      // This happens when app is uninstalled or token rotated.
      // Uber/Grab/Gojek pattern: always clean dead tokens on send failure.
      // =====================================================================
      if (
        userId &&
        tokens.length === 1 &&
        (error?.code === 'messaging/registration-token-not-registered' ||
         error?.code === 'messaging/invalid-registration-token')
      ) {
        logger.info(`FCM: Removing dead token for user ${userId}`);
        // P7-T06 (A05-004): Soft-revoke the token in DB so the revokedAt filter
        // immediately excludes it from future getTokens() DB fallback calls.
        // removeToken deletes the DB row; revokedAt update is belt-and-braces
        // for any concurrent reader that obtained the token before the delete.
        prismaClient.deviceToken.updateMany({
          where: { userId, token: tokens[0] } as any,
          // P7-T06: revokedAt column added via direct SQL — cast data as any (Prisma types predate column).
          data: { revokedAt: new Date() } as any,
        }).catch((err: Error) => logger.warn('[FCM] revokedAt update failed', { userId, error: err.message }));
        this.removeToken(userId, tokens[0]).catch((err) => logger.warn('[FCM] Token cleanup failed', { userId, error: err instanceof Error ? err.message : String(err) }));
      }
      logger.error('FCM: Failed to send notification', error);
      return false;
    }
  }

  /**
   * P2 F6.2: Parse Retry-After header from FCM quota/unavailable errors.
   * Handles integer-seconds ("30") and HTTP-date formats. Capped at maxMs.
   * Returns null when header is missing or unparseable (caller should fall
   * back to exponential backoff).
   */
  private static parseRetryAfter(header: string | undefined, maxMs: number): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    const asInt = parseInt(trimmed, 10);
    if (!Number.isNaN(asInt) && String(asInt) === trimmed) {
      return Math.min(Math.max(0, asInt * 1000), maxMs);
    }
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(0, asDate - Date.now()), maxMs);
    }
    return null;
  }

  /**
   * H-28 FIX: Generic retry wrapper with exponential backoff + jitter.
   * Non-retryable FCM errors (invalid token, credential mismatch) bail immediately.
   * All primary send paths now route through this to get automatic retries.
   *
   * P2 F6.2: On quota/unavailable errors (messaging/quota-exceeded,
   * messaging/server-unavailable, HTTP 429/503) honor the server's
   * Retry-After header when present instead of exponential backoff.
   */
  private async executeWithRetry(
    fn: () => Promise<void>,
    maxRetries: number = 2
  ): Promise<void> {
    const MAX_BACKOFF_MS = 30000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await fn();
        return;
      } catch (err: any) {
        const code = err?.errorInfo?.code || err?.code || '';

        // Non-retryable: don't waste time retrying
        if (FCMService.NON_RETRYABLE_FCM_ERRORS.has(code)) {
          throw err; // Let caller handle token cleanup
        }

        // Last attempt: propagate error
        if (attempt === maxRetries) {
          throw err;
        }

        // P2 F6.2: Prefer Retry-After header on quota/unavailable errors.
        const httpStatus = err?.errorInfo?.httpResponse?.status;
        const isQuotaOrUnavailable =
          code === 'messaging/quota-exceeded' ||
          code === 'messaging/server-unavailable' ||
          httpStatus === 429 ||
          httpStatus === 503;
        const retryAfterHeader: string | undefined =
          err?.errorInfo?.httpResponse?.headers?.['retry-after'] ??
          err?.errorInfo?.httpResponse?.headers?.['Retry-After'];
        const retryAfterMs = isQuotaOrUnavailable
          ? FCMService.parseRetryAfter(retryAfterHeader, MAX_BACKOFF_MS)
          : null;

        let delayMs: number;
        if (retryAfterMs !== null) {
          delayMs = retryAfterMs;
        } else {
          // Exponential backoff with jitter (AWS pattern)
          const baseDelay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
          const cappedDelay = Math.min(MAX_BACKOFF_MS, baseDelay);
          delayMs = Math.random() * cappedDelay;
        }

        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { metrics } = require('../monitoring/metrics.service');
          metrics.incrementCounter('fcm_retry_backoff_source_total', {
            source: retryAfterMs !== null ? 'retry_after_header' : 'exponential',
          });
        } catch { /* non-fatal */ }

        logger.info('[FCM] Retrying after transient error', {
          attempt: attempt + 1,
          maxRetries,
          delayMs: Math.round(delayMs),
          code,
          backoffSource: retryAfterMs !== null ? 'retry_after_header' : 'exponential',
        });

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Send push notification with retry and exponential backoff.
   * Non-retryable errors (invalid token, etc.) fail immediately.
   *
   * NOTE: sendToTokens now internally uses executeWithRetry (H-28 fix).
   * This method remains as a public convenience API — it delegates to
   * sendToTokens which handles its own retry loop. The maxRetries param
   * is kept for backward compatibility but the inner retry count is
   * controlled by executeWithRetry (2 retries).
   */
  async sendWithRetry(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
    maxRetries: number = 3,
    type: string = NotificationType.GENERAL
  ): Promise<boolean> {
    return this.sendToTokens(tokens, {
      type,
      title,
      body,
      data: data || {},
    });
  }

  /**
   * Fix M-3: Send push notification with retry (fire-and-forget but with retries and logging).
   * Bridges the interface gap between FCMNotification callers and sendWithRetry internals.
   * Accepts the canonical FCMNotification type used throughout the codebase.
   */
  async sendReliable(
    tokens: string[],
    notification: FCMNotification,
    userId?: string
  ): Promise<void> {
    try {
      await this.sendWithRetry(tokens, notification.title, notification.body, notification.data, 3, notification.type);
    } catch (err: unknown) {
      logger.error('[FCM] Push failed after all retries', {
        userId,
        tokenCount: tokens.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Send notification to a topic (e.g., all transporters with specific vehicle type)
   * 
   * Topics:
   * - transporter_all: All transporters
   * - transporter_mini: Transporters with Mini trucks
   * - transporter_open: Transporters with Open trucks
   * - driver_all: All drivers
   */
  async sendToTopic(
    topic: string,
    notification: FCMNotification
  ): Promise<boolean> {
    const message = this.buildMessage(notification);

    if (!this.isInitialized || !this.admin) {
      this.logNotification(notification, [], topic);
      // M20 FIX: Mock mode returns false — notification was NOT delivered
      return false;
    }

    try {
      await this.admin.messaging().send({
        ...message,
        topic
      });
      
      logger.info(`FCM: Notification sent to topic: ${topic}`);
      return true;
    } catch (error) {
      logger.error(`FCM: Failed to send to topic ${topic}`, error);
      return false;
    }
  }

  /**
   * Subscribe user to a topic
   * 
   * SCALABILITY: Fetches tokens from Redis before subscribing
   */
  async subscribeToTopic(userId: string, topic: string): Promise<boolean> {
    const tokens = await this.getTokens(userId);
    
    if (tokens.length === 0 || !this.isInitialized || !this.admin) {
      logger.debug(`FCM: Cannot subscribe ${userId} to ${topic}`);
      return false;
    }

    try {
      await this.admin.messaging().subscribeToTopic(tokens, topic);
      logger.info(`FCM: User ${userId} subscribed to topic: ${topic}`);
      return true;
    } catch (error) {
      logger.error(`FCM: Failed to subscribe to topic ${topic}`, error);
      return false;
    }
  }

  /**
   * Build FCM message payload
   */
  /** Notification types that target drivers and should wake the screen */
  private static readonly FULLSCREEN_TYPES = new Set([
    'trip_assigned',
    'assignment_update',
    'driver_assigned',
    'driver_timeout',
    'new_broadcast',
  ]);

  /**
   * Build FCM message payload
   */
  private buildMessage(notification: FCMNotification, tokens?: string[]): any {
    // FCM 4KB hard limit -- truncate long fields to stay safe
    const truncate = (s: string | undefined, max: number): string | undefined =>
      s && s.length > max ? s.slice(0, max) + '\u2026' : s;

    const truncatedData = notification.data
      ? Object.fromEntries(
          Object.entries(notification.data).map(([k, v]) => {
            const strVal = String(v);
            // Truncate address fields to 100 chars, other strings to 200
            const limit = k.toLowerCase().includes('address') ? 100 : 200;
            return [k, strVal.length > limit ? strVal.slice(0, limit) + '\u2026' : strVal];
          })
        )
      : {};

    // H11 FIX: Driver-targeted notifications include fullScreen flag so Android
    // can launch a full-screen intent (wake screen + heads-up overlay).
    const isFullScreen = FCMService.FULLSCREEN_TYPES.has(notification.type);

    // W0-4: Canary metric for the priority that actually ships on the wire.
    // The same conditional used below for `android.priority` is mirrored here
    // so the counter and the outgoing payload can never drift. The counter
    // lets us verify in prod that W0-1's high-priority fix is actually
    // reaching Android drivers.
    // H3 / A05-017: When FF_FCM_PRIORITY_HIGH_DEFAULT is ON (default=true per
    // H3 council verdict) unset producers default to 'high' so customer-
    // direction FCMs wake devices through Doze/OEM-throttle. When OFF the
    // original legacy behaviour (unset → 'normal') is preserved exactly.
    const priorityHighDefault = isEnabled(FLAGS.FCM_PRIORITY_HIGH_DEFAULT);
    const effectivePriority: 'high' | 'normal' = priorityHighDefault
      ? (notification.priority ?? 'high')
      : (notification.priority === 'high' ? 'high' : 'normal');
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { metrics } = require('../monitoring/metrics.service');
      metrics.incrementCounter('fcm_push_priority_total', {
        priority: effectivePriority,
        type: notification.type,
      });
    } catch { /* metrics not available — never break a send over a counter */ }

    // C-4 (Phase 2): Android + APNs TTL so stale broadcasts don't land after
    // the booking TTL (108s) has already expired. FCM default is 4 weeks,
    // which produced confusing UX and wasted quota. Pattern: Uber dispatch
    // TTL=60s, Lyft=90s. Defaults to 600s for non-dispatch lifecycle types.
    const ttlMap: Record<string, number> = {
      new_broadcast: 90,
      driver_timeout: 90,
      assignment_update: 90,
      trip_update: 600,
      driver_assigned: 600,
      // A03-001: TTL MUST equal driver-accept window so FCM never lands
      // after assignment has already auto-declined & reassigned.
      trip_assigned: HOLD_CONFIG.driverAcceptTimeoutSeconds,
    };
    const ttlSeconds = ttlMap[notification.type] ?? 600;
    const apnsExpiration = Math.floor(Date.now() / 1000) + ttlSeconds;

    // P2 F6.3 / A03-010: Collapse retries/duplicates with the same business key into a
    // single visible notification (one buzz per booking, not N).
    // Namespaced by event type so trip_assigned and order_cancelled with the same
    // bookingId do NOT collapse to the same tray slot.
    const collapseKeyRaw = `${notification.type}:${
      (notification.data?.bookingId as string | undefined) ??
      (notification.data?.orderId as string | undefined) ??
      (notification.data?.assignmentId as string | undefined) ??
      'unkeyed'
    }`;
    // P6-T38: FCM collapseKey length bound — 128 chars is well within the 1 KB
    // FCM maximum and safe across all Android / APNs versions.
    const collapseKey = collapseKeyRaw.length <= 128
      ? collapseKeyRaw
      : `${collapseKeyRaw.slice(0, 100)}.${createHash('sha256').update(collapseKeyRaw).digest('hex').slice(0, 8)}`;

    // A03-002 / A05-001 / A13-004: When FF_FCM_DATA_ONLY_FULLSCREEN is ON AND the
    // notification type is in FULLSCREEN_TYPES, omit the top-level `notification:`
    // AND `android.notification:` blocks so Android Doze delivers via
    // onMessageReceived (not tray-only). Captain then launches its full-screen
    // overlay via BroadcastFullScreenNotifier. Title/body are mirrored into the
    // `data` bag for the client to render. APNs path is preserved unchanged —
    // iOS wakes via `notification` + background-mode. Default OFF until Captain
    // bbc22c9+ at ≥90% DAU.
    const dataOnlyFullscreen = isFullScreen && isEnabled(FLAGS.FCM_DATA_ONLY_FULLSCREEN);

    const titleTruncated = truncate(notification.title, 100) || '';
    const bodyTruncated = truncate(notification.body, 200) || '';

    return {
      ...(dataOnlyFullscreen ? {} : {
        notification: {
          title: titleTruncated,
          body: bodyTruncated,
        },
      }),
      data: {
        type: notification.type,
        // A03-002: mirror title/body inside data so data-only clients can render.
        ...(dataOnlyFullscreen ? { title: titleTruncated, body: bodyTruncated } : {}),
        ...truncatedData,
        ...(isFullScreen ? { fullScreen: 'true' } : {}),
      },
      android: {
        priority: effectivePriority,
        ttl: `${ttlSeconds}s`,
        ...(collapseKey ? { collapseKey } : {}),
        // A03-002: Android data-only payloads must not include android.notification.
        ...(dataOnlyFullscreen ? {} : {
          notification: {
            channelId: this.getChannelId(notification.type),
            sound: 'default',
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            // H11: Lock-screen visibility for driver notifications
            ...(isFullScreen ? { visibility: 'public' as const } : {}),
          },
        }),
      },
      apns: {
        headers: {
          'apns-expiration': String(apnsExpiration),
          ...(effectivePriority === 'high' ? { 'apns-priority': '10' } : { 'apns-priority': '5' }),
          ...(collapseKey ? { 'apns-collapse-id': collapseKey } : {}),
        },
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };
  }

  /**
   * Get notification channel ID based on type
   */
  private getChannelId(type: string): string {
    switch (type) {
      case NotificationType.NEW_BROADCAST:
        return 'broadcasts_v2';
      case NotificationType.ASSIGNMENT_UPDATE:
        return 'trips';
      case NotificationType.TRIP_UPDATE:
        return 'trips';
      case NotificationType.PAYMENT:
        return 'payments';
      default:
        return 'general';
    }
  }

  /**
   * Log notification (for development/mock mode)
   */
  private logNotification(
    notification: FCMNotification,
    tokens: string[],
    topic?: string
  ): void {
    const lines: string[] = [
      '',
      '╔════════════════════════════════════════════════════════════╗',
      '║  PUSH NOTIFICATION (Mock Mode)                             ║',
      '╠════════════════════════════════════════════════════════════╣',
      `║  Type:    ${notification.type.padEnd(47)}║`,
      `║  Title:   ${notification.title.substring(0, 47).padEnd(47)}║`,
      `║  Body:    ${notification.body.substring(0, 47).padEnd(47)}║`,
    ];
    if (topic) {
      lines.push(`║  Topic:   ${topic.padEnd(47)}║`);
    } else {
      lines.push(`║  Tokens:  ${tokens.length} device(s)`.padEnd(59) + '║');
    }
    lines.push('║                                                            ║');
    lines.push('║  Data:                                                     ║');
    Object.entries(notification.data || {}).forEach(([key, value]) => {
      const line = `    ${key}: ${String(value).substring(0, 40)}`;
      lines.push(`║  ${line.padEnd(56)}║`);
    });
    lines.push('╚════════════════════════════════════════════════════════════╝');
    lines.push('');
    logger.info(lines.join('\n'));
  }

  // ============================================================================
  // CONVENIENCE METHODS - Use these for common notification types
  // ============================================================================

  /**
   * Send new broadcast notification to transporters
   */
  async notifyNewBroadcast(
    transporterIds: string[],
    broadcast: {
      broadcastId: string;
      customerName: string;
      vehicleType: string;
      trucksNeeded: number;
      farePerTruck: number;
      pickupCity: string;
      dropCity: string;
      /** Unique tag per booking for Android notification grouping (FIX #32) */
      notificationTag?: string;
      /** Whether this is a re-broadcast for a transporter who just came online */
      isRebroadcast?: boolean;
      // Fix E3: Additional fields for background decision-making
      pickupAddress?: string;
      dropAddress?: string;
      distanceKm?: number;
      vehicleSubtype?: string;
      expiresAt?: string;
    }
  ): Promise<number> {
    const notification: FCMNotification = {
      type: NotificationType.NEW_BROADCAST,
      title: '🚛 New Booking Request!',
      body: `${broadcast.trucksNeeded} ${broadcast.vehicleType} truck(s) needed • ₹${broadcast.farePerTruck}/truck • ${broadcast.pickupCity} → ${broadcast.dropCity}`,
      priority: 'high',
      data: {
        // F-FCM-02 (Phase 4 P4-2 gate 6): payloadVersion mirrors the socket
        // emit pair so cross-channel dedup at the Captain client can collapse
        // socket+FCM duplicates by `${type}:${broadcastId}:${payloadVersion}`.
        payloadVersion: '1',
        broadcastId: broadcast.broadcastId,
        // V6-NEW-01 (Phase 4 P0-1): mask customerName at the FCM data builder.
        customerName: maskName(broadcast.customerName),
        vehicleType: broadcast.vehicleType,
        trucksNeeded: broadcast.trucksNeeded,
        farePerTruck: broadcast.farePerTruck,
        pickupCity: broadcast.pickupCity,
        dropCity: broadcast.dropCity,
        // Fix E3: Essential fields for background decision-making
        ...(broadcast.pickupAddress ? { pickupAddress: broadcast.pickupAddress } : {}),
        ...(broadcast.dropAddress ? { dropAddress: broadcast.dropAddress } : {}),
        ...(broadcast.distanceKm != null ? { distanceKm: broadcast.distanceKm } : {}),
        ...(broadcast.vehicleSubtype ? { vehicleSubtype: broadcast.vehicleSubtype } : {}),
        ...(broadcast.expiresAt ? { expiresAt: broadcast.expiresAt } : {}),
        action: 'NEW_BROADCAST',
        timestamp: Date.now(),
        ...(broadcast.notificationTag ? { notificationTag: broadcast.notificationTag } : {}),
        ...(broadcast.isRebroadcast ? { isRebroadcast: true } : {})
      }
    };

    return this.sendToUsers(transporterIds, notification);
  }

  /**
   * Send assignment update notification
   */
  async notifyAssignmentUpdate(
    userId: string,
    assignment: {
      assignmentId: string;
      tripId: string;
      status: string;
      bookingId: string;
    }
  ): Promise<boolean> {
    const statusMessages: Record<string, string> = {
      pending: 'New trip assigned to you',
      driver_accepted: 'You accepted the trip',
      in_transit: 'Trip is now in transit',
      completed: 'Trip completed successfully!',
      cancelled: 'Trip was cancelled'
    };

    const notification: FCMNotification = {
      type: NotificationType.ASSIGNMENT_UPDATE,
      title: '📋 Assignment Update',
      body: statusMessages[assignment.status] || `Status: ${assignment.status}`,
      priority: assignment.status === 'pending' ? 'high' : 'normal',
      data: {
        assignmentId: assignment.assignmentId,
        tripId: assignment.tripId,
        status: assignment.status,
        bookingId: assignment.bookingId
      }
    };

    return this.sendToUser(userId, notification);
  }

  /**
   * Send payment notification
   */
  async notifyPayment(
    userId: string,
    payment: {
      amount: number;
      tripId: string;
      status: 'received' | 'pending';
    }
  ): Promise<boolean> {
    const notification: FCMNotification = {
      type: NotificationType.PAYMENT,
      title: payment.status === 'received' ? '💰 Payment Received!' : '⏳ Payment Pending',
      body: `₹${payment.amount} for trip`,
      priority: 'high',
      data: {
        amount: payment.amount,
        tripId: payment.tripId,
        status: payment.status
      }
    };

    return this.sendToUser(userId, notification);
  }
  /**
   * P7-T04 (A05-007 / Part B P7-F): Send notification to many users via
   * sendEachForMulticast (batched at 500 tokens, gated at 8K/s).
   *
   * Canary rollout: controlled by FF_FCM_MULTICAST_ENABLED (default OFF).
   *
   * Algorithm:
   *   1. Resolve FCM tokens for all userIds with concurrency limited to 20
   *      (reduced from 100 per Part B P7-F to avoid 100×500=50K/s bursts).
   *   2. Dedup tokens across users.
   *   3. Check egress token bucket (8K/s). If rate-limited, log and return empty result.
   *   4. Chunk deduped tokens at 500, call sendEachForMulticast per chunk.
   *   5. Per-token error mapping: NON_RETRYABLE → soft-revoke (revokedAt update).
   *
   * Returns a MulticastResult summary for observability.
   */
  async sendToUsersMulticast(
    userIds: string[],
    notification: FCMNotification
  ): Promise<MulticastResult> {
    if (!this.isInitialized || !this.admin) {
      this.logNotification(notification, []);
      return { successCount: 0, failureCount: 0, revokedCount: 0, rateLimited: false };
    }

    if (userIds.length === 0) {
      return { successCount: 0, failureCount: 0, revokedCount: 0, rateLimited: false };
    }

    // Step 1: Resolve tokens concurrently (pLimit-style, max 20 in-flight)
    const CONCURRENCY = 20;
    const tokensByUser: string[][] = [];
    for (let i = 0; i < userIds.length; i += CONCURRENCY) {
      const slice = userIds.slice(i, i + CONCURRENCY);
      const resolved = await Promise.allSettled(slice.map(uid => this.getTokens(uid)));
      for (const r of resolved) {
        tokensByUser.push(r.status === 'fulfilled' ? r.value : []);
      }
    }

    // Step 2: Dedup tokens across users, build token→userId mapping
    const tokenToUser = new Map<string, string>();
    for (let i = 0; i < userIds.length; i++) {
      for (const t of (tokensByUser[i] ?? [])) {
        if (!tokenToUser.has(t)) tokenToUser.set(t, userIds[i]);
      }
    }
    let allTokens = Array.from(tokenToUser.keys());

    if (allTokens.length === 0) {
      return { successCount: 0, failureCount: 0, revokedCount: 0, rateLimited: false };
    }

    // ADR: A05-028 — split FCM_UPGRADE_CAMPAIGN (announce-only) from
    // FCM_VERSION_GATE (hard suppression). Either flag enables the version
    // lookup; only FCM_VERSION_GATE causes a send to be skipped.
    //   announce  + suppress  → notify and skip
    //   announce  + no-suppress → notify, send anyway (campaign telemetry)
    //   no-announce + suppress  → silent suppress (rare ops mode)
    //   no-announce + no-suppress → original byte-identical path
    const announceUpgrade = isEnabled(FLAGS.FCM_UPGRADE_CAMPAIGN);
    const enforceVersionGate = isEnabled(FLAGS.FCM_VERSION_GATE);
    if (announceUpgrade || enforceVersionGate) {
      const minRaw = Number(process.env.MIN_SUPPORTED_APP_VERSION ?? 0);
      const minSupported = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 0;
      if (minSupported > 0) {
        try {
          const recs = (await prismaClient.deviceToken.findMany({
            where: { token: { in: allTokens } } as any,
            select: { token: true, appVersionCode: true } as any,
          })) as unknown as Array<{ token: string; appVersionCode?: number | null }>;
          const versionByToken = new Map<string, number | null | undefined>();
          for (const r of recs) versionByToken.set(r.token, r.appVersionCode);
          const keep: string[] = [];
          for (const token of allTokens) {
            const gate = shouldSkipForVersion({
              appVersionCode: versionByToken.get(token) ?? null,
            });
            if (gate.skipped && gate.reason === 'below_min_version') {
              const userId = tokenToUser.get(token);
              if (announceUpgrade) {
                notifyUpgradeRequired({
                  userId,
                  token,
                  appVersionCode: versionByToken.get(token) ?? null,
                  minSupportedVersion: minSupported,
                }).catch((err: unknown) => logger.warn('[FCM] upgrade-campaign notice failed', {
                  err: err instanceof Error ? err.message : String(err),
                }));
              }
              if (enforceVersionGate) {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-var-requires
                  const { metrics } = require('../monitoring/metrics.service');
                  metrics.incrementCounter('fcm_version_gate_suppressed_total', {
                    campaign: announceUpgrade ? 'on' : 'off',
                  });
                } catch { /* metrics non-fatal */ }
                continue;
              }
            }
            keep.push(token);
          }
          allTokens = keep;
        } catch (err: unknown) {
          logger.warn('[FCM] upgrade-campaign gate lookup failed — sending all tokens', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (allTokens.length === 0) {
        return { successCount: 0, failureCount: 0, revokedCount: 0, rateLimited: false };
      }
    }

    // Step 3: Egress token-bucket gate
    if (!this._consumeEgressTokens(allTokens.length)) {
      logger.warn('[FCM] sendToUsersMulticast rate-limited', {
        userCount: userIds.length,
        tokenCount: allTokens.length,
      });
      return { successCount: 0, failureCount: allTokens.length, revokedCount: 0, rateLimited: true };
    }

    // Step 4: Chunk at 500, call sendEachForMulticast per chunk
    const CHUNK = 500;
    let successCount = 0;
    let failureCount = 0;
    let revokedCount = 0;

    const message = this.buildMessage(notification);

    for (let i = 0; i < allTokens.length; i += CHUNK) {
      const chunk = allTokens.slice(i, i + CHUNK);
      try {
        const result = await this.admin.messaging().sendEachForMulticast({ ...message, tokens: chunk });
        successCount += result.successCount ?? 0;
        failureCount += result.failureCount ?? 0;

        // Step 5: Per-token error handling
        if (result.failureCount > 0 && result.responses) {
          for (let j = 0; j < chunk.length; j++) {
            const resp = result.responses[j];
            if (!resp?.error) continue;
            const code: string = resp.error.code ?? '';
            // W-5 D3.T3: bounded-cardinality category label for failure metric.
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { metrics } = require('../monitoring/metrics.service');
              metrics.incrementCounter('fcm_send_failure_total', {
                type: notification.type,
                category: normalizeFirebaseErrorCode(code),
              });
            } catch { /* metrics non-fatal */ }
            if (FCMService.NON_RETRYABLE_FCM_ERRORS.has(code)) {
              const userId = tokenToUser.get(chunk[j]);
              // Soft-revoke in DB — excludes from next getTokens() DB fallback
              prismaClient.deviceToken.updateMany({
                where: { token: chunk[j] } as any,
                // P7-T06: revokedAt column added via direct SQL — cast data as any (Prisma types predate column).
                data: { revokedAt: new Date() } as any,
              }).catch((err: Error) => logger.warn('[FCM] multicast revokedAt update failed', { error: err.message }));
              if (userId) {
                this.removeToken(userId, chunk[j]).catch((err) =>
                  logger.warn('[FCM] multicast token cleanup failed', { error: err instanceof Error ? err.message : String(err) })
                );
              }
              revokedCount++;
            }
          }
        }
      } catch (chunkErr: any) {
        const code = chunkErr?.code ?? chunkErr?.errorInfo?.code ?? '';
        logger.error('[FCM] sendToUsersMulticast chunk error', { chunkIndex: i, code });
        // W-5 D3.T3: emit category label for chunk-level failure too.
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { metrics } = require('../monitoring/metrics.service');
          metrics.incrementCounter('fcm_send_failure_total', {
            type: notification.type,
            category: normalizeFirebaseErrorCode(code),
          }, chunk.length);
        } catch { /* metrics non-fatal */ }
        failureCount += chunk.length;
      }
    }

    // Observability
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { metrics } = require('../monitoring/metrics.service');
      if (successCount > 0) metrics.incrementCounter('fcm_send_success_total', { type: notification.type, tokens_bucket: 'multicast' }, successCount);
      if (failureCount > 0) metrics.incrementCounter('fcm_send_failure_total', { type: notification.type, error_code: 'multicast_chunk' }, failureCount);
      if (revokedCount > 0) metrics.incrementCounter('fcm_dead_token_cleanup_total', {}, revokedCount);
    } catch { /* non-fatal */ }

    logger.info('[FCM] sendToUsersMulticast complete', { userCount: userIds.length, tokenCount: allTokens.length, successCount, failureCount, revokedCount });
    return { successCount, failureCount, revokedCount, rateLimited: false };
  }

}

// Singleton instance
export const fcmService = new FCMService();

// Types
/**
 * P7-T04: Result from sendToUsersMulticast.
 */
export interface MulticastResult {
  successCount: number;
  failureCount: number;
  revokedCount: number;
  rateLimited: boolean;
}

export interface FCMNotification {
  type: string;
  title: string;
  body: string;
  priority?: 'high' | 'normal';
  data?: Record<string, any>;
}

// =============================================================================
// CONVENIENCE EXPORTS - For backward compatibility and cleaner imports
// =============================================================================

/**
 * Send push notification to a single user
 * @param userId - The user ID to send notification to
 * @param notification - Notification payload
 */
export async function sendPushNotification(
  userId: string,
  notification: { title: string; body: string; data?: Record<string, any> }
): Promise<boolean> {
  return fcmService.sendToUser(userId, {
    type: notification.data?.type || NotificationType.GENERAL,
    title: notification.title,
    body: notification.body,
    priority: 'high',
    data: notification.data
  });
}

/**
 * Send push notifications to multiple users
 * @param userIds - Array of user IDs to send notification to
 * @param notification - Notification payload
 * @returns Number of successful notifications sent
 */
export async function sendBatchPushNotifications(
  userIds: string[],
  notification: { title: string; body: string; data?: Record<string, any> }
): Promise<number> {
  return fcmService.sendToUsers(userIds, {
    type: notification.data?.type || NotificationType.GENERAL,
    title: notification.title,
    body: notification.body,
    priority: 'high',
    data: notification.data
  });
}
