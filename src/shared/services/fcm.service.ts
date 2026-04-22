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
import { createHash } from 'crypto';
import { logger } from './logger.service';
import { redisService } from './redis.service';
import { prismaClient } from '../database/prisma.service';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { FLAGS, isEnabled } from '../config/feature-flags';

// Notification types - must match mobile apps
export const NotificationType = {
  NEW_BROADCAST: 'new_broadcast',
  ASSIGNMENT_UPDATE: 'assignment_update',
  TRIP_UPDATE: 'trip_update',
  PAYMENT: 'payment_received',
  GENERAL: 'general'
} as const;

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

  /** FCM error codes that should never be retried (token invalid, credential mismatch, etc.) */
  private static readonly NON_RETRYABLE_FCM_ERRORS = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
    'messaging/mismatched-credential',
    'messaging/third-party-auth-error',
  ]);

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
        firebaseAdmin.initializeApp({
          credential: firebaseAdmin.credential.cert(serviceAccount)
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
        firebaseAdmin.initializeApp({
          credential: firebaseAdmin.credential.cert({
            projectId: projectId!,
            privateKey: resolvedPrivateKey!,
            clientEmail: clientEmail!,
          } as any)
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
  async registerToken(userId: string, token: string, platform: string = 'android'): Promise<boolean> {
    let redisOk = false;

    // Try Redis first (primary storage)
    if (this.isRedisAvailable()) {
      try {
        const key = FCM_TOKEN_KEY(userId);
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
    try {
      await prismaClient.deviceToken.upsert({
        where: { userId_token: { userId, token } },
        update: { lastSeenAt: new Date() },
        create: { userId, token, platform, lastSeenAt: new Date() }
      });
    } catch (dbErr: any) {
      // Non-fatal: DB fallback is best-effort. Redis is primary.
      logger.warn('FCM: DB fallback write failed', { userId, error: dbErr.message });
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
      const dbTokens = await prismaClient.deviceToken.findMany({
        where: { userId },
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
    const effectivePriority: 'high' | 'normal' =
      notification.priority === 'high' ? 'high' : 'normal';
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
        priority: notification.priority === 'high' ? 'high' : 'normal',
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
          ...(notification.priority === 'high' ? { 'apns-priority': '10' } : { 'apns-priority': '5' }),
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
        broadcastId: broadcast.broadcastId,
        customerName: broadcast.customerName,
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
}

// Singleton instance
export const fcmService = new FCMService();

// Types
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
