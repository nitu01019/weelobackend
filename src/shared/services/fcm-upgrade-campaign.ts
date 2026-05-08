/**
 * A05-015 Phase 3.5 — Backend enforce campaign.
 *
 * Link-to-VERIFICATION-doc: .planning/re-review-2026-04-23/VERIFICATION/A05-015.md (Phase 6 R6)
 * Kill-switch: FF_FCM_UPGRADE_CAMPAIGN (default false — enforce flip is Phase 6 R6 gate).
 *
 * Contract.
 * When `fcm-version-gate.shouldSkipForVersion(token)` returns `skipped: true`,
 * the send path filters the token out of the multicast target set AND — at
 * most once per 24 hours per token — sends a single data-only FCM envelope
 * with `data.type = FCM_OLD_CLIENT_UPGRADE_REQUIRED`. The Captain and
 * Customer apps detect that type in `onMessageReceived` and persist a
 * `requires_upgrade=true` flag that the next visible Activity consumes to
 * show the upgrade banner.
 *
 * Throttling.
 * Per-token Redis SET NX EX 86400 — a compromised or churn-heavy client
 * cannot weaponise this path into a broadcast storm.
 *
 * Industry reference:
 *   - Uber / Swiggy driver apps — one upgrade nudge per day per device.
 *   - Ola — server-side minAppVersion straggler campaign with 24h cooloff.
 *   - WhatsApp — soft-block banner triggered via silent data push.
 *
 * Observability.
 *   - `fcm_upgrade_notice_sent_total` — successful send.
 *   - `fcm_upgrade_notice_throttled_total` — already-notified-within-24h skip.
 *   - `fcm_upgrade_notice_error_total{reason}` — send failure classified.
 */

import { logger } from './logger.service';
import { metrics as metricsService } from '../monitoring/metrics.service';
import { FLAGS, isEnabled } from '../config/feature-flags';

const UPGRADE_FCM_TYPE = 'FCM_OLD_CLIENT_UPGRADE_REQUIRED';
const THROTTLE_TTL_SECONDS = 24 * 60 * 60;
const THROTTLE_KEY_PREFIX = 'fcm:upgrade-notice:';

function throttleKey(token: string): string {
  return `${THROTTLE_KEY_PREFIX}${token}`;
}

export interface UpgradeNoticeContext {
  userId?: string;
  token: string;
  appVersionCode?: number | null;
  minSupportedVersion: number;
}

export async function notifyUpgradeRequired(ctx: UpgradeNoticeContext): Promise<void> {
  if (!isEnabled(FLAGS.FCM_UPGRADE_CAMPAIGN)) {
    return; // Flag OFF → no campaign. Plan default for Phase 3; flip at Phase 6 R6 gate.
  }

  let redisService: { set: (k: string, v: string, opts: unknown) => Promise<string | null> };
  let fcmAdmin: { messaging: () => { send: (msg: unknown) => Promise<string> } };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    redisService = require('./redis.service').redisService;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fcmAdmin = require('firebase-admin');
  } catch (err: unknown) {
    logger.warn('[upgrade-campaign] dependency unavailable — skipping notice', {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let isFirstNotice = false;
  try {
    const result = await redisService.set(
      throttleKey(ctx.token),
      String(Date.now()),
      { NX: true, EX: THROTTLE_TTL_SECONDS },
    );
    isFirstNotice = result === 'OK';
  } catch (err: unknown) {
    logger.warn('[upgrade-campaign] throttle probe failed — failing closed (no send)', {
      err: err instanceof Error ? err.message : String(err),
    });
    return; // Fail-closed: if Redis is down, do NOT bombard the client.
  }

  if (!isFirstNotice) {
    try {
      // S1 fix (W-5 g11): counter names aligned with registry (metrics-definitions.ts:658-674).
      // Throttled = upgrade-required-skip (already-notified-within-24h).
      metricsService.incrementCounter('fcm_upgrade_required_skip_total', { reason: 'throttled' });
    } catch { /* metric registry not booted yet */ }
    return;
  }

  try {
    await fcmAdmin.messaging().send({
      token: ctx.token,
      data: {
        type: UPGRADE_FCM_TYPE,
        minSupportedVersion: String(ctx.minSupportedVersion),
        currentVersion: String(ctx.appVersionCode ?? 0),
        sentAtMs: String(Date.now()),
      },
      android: { priority: 'high' as const },
    });
    try {
      // S1 fix (W-5 g11): aligned with registered counter `fcm_upgrade_notified_total{result}`.
      metricsService.incrementCounter('fcm_upgrade_notified_total', { result: 'success' });
    } catch { /* noop */ }
    logger.info('[upgrade-campaign] OLD_CLIENT_UPGRADE_REQUIRED sent', {
      userId: ctx.userId,
      tokenTail: ctx.token.slice(-8),
      minSupportedVersion: ctx.minSupportedVersion,
      currentVersion: ctx.appVersionCode ?? 0,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? 'unknown';
    try {
      // S1+S4 fix (W-5 g11): aligned with `fcm_upgrade_notify_failure_total{category}` AND
      // normalized error code via `normalizeFirebaseErrorCode` (bounded enum, ≤7 values)
      // to prevent vendor-code cardinality leak onto /metrics.
      const { normalizeFirebaseErrorCode } = await import('./fcm.service');
      const category = normalizeFirebaseErrorCode(code);
      metricsService.incrementCounter('fcm_upgrade_notify_failure_total', { category });
      metricsService.incrementCounter('fcm_upgrade_notified_total', { result: 'failed' });
    } catch { /* noop */ }
    logger.warn('[upgrade-campaign] send failed', {
      userId: ctx.userId,
      tokenTail: ctx.token.slice(-8),
      code,
    });
    // On failure we still consumed the throttle token — intentional. A second
    // send attempt within 24h would re-flood the client even if the retry
    // succeeded; the next natural send path after 24h naturally retries.
  }
}
