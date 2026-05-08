/**
 * =============================================================================
 * A05-015 Phase 3.4 — FCM Version Gate (soft gate, warn-only in Phase 3)
 * =============================================================================
 *
 * Pure helper that decides whether a given DeviceToken should be SKIPPED during
 * FCM send based on the client-reported `appVersionCode` captured at
 * /register-token time (Phase 3.1) vs. the operator-controlled
 * `MIN_SUPPORTED_APP_VERSION` env var.
 *
 * Staged rollout per A05-015 verification plan:
 *   Phase 3.1 — capture appVersionCode column            (this PR, landed)
 *   Phase 3.2 — backend signature + REST boundary clamp  (this PR, landed)
 *   Phase 3.3 — observability histogram fcm_tokens_by_version
 *                                                        (this PR, landed)
 *   Phase 3.4 — soft gate, warn-only (MIN=0 default)     (this PR, landed)
 *   Phase 6   — enforce (operator bumps MIN to target)   (deferred)
 *
 * Safe-default semantics (warn-only): when MIN_SUPPORTED_APP_VERSION=0 (the
 * default in Phase 3), this helper NEVER skips. It only starts skipping when
 * an operator explicitly raises the threshold AND the call site is behind the
 * `FF_FCM_VERSION_GATE` flag. Tokens with NULL appVersionCode (legacy clients
 * that haven't upgraded past the Phase 3.1 Captain PR) are NEVER skipped in
 * warn-only mode — they surface via the `no_version_captured` reason for
 * observability without dropping sends.
 *
 * Industry-standard mirror: Uber "register-device with appVersion + route
 * payload shim", Ola "server-side minAppVersion per notification type",
 * Stripe "stripe-version header for schema negotiation". All use soft-capture
 * before any hard cutoff.
 * =============================================================================
 */

/**
 * Reason codes surfaced to the caller for observability. Only `below_min_version`
 * implies `skipped: true`. The `no_version_captured` reason is an informational
 * signal — the caller should increment a warn-only counter but still send.
 */
export type VersionGateReason = 'below_min_version' | 'no_version_captured';

export interface VersionGateResult {
  /** True only when the token should be dropped (appVersionCode < MIN). */
  skipped: boolean;
  /** Reason code for observability. Undefined when the token passed cleanly. */
  reason?: VersionGateReason;
}

/**
 * Decide whether to skip an FCM send for the given DeviceToken record.
 *
 * Behaviour matrix:
 *   MIN_SUPPORTED_APP_VERSION <= 0  -> never skip                (disabled)
 *   MIN > 0 && appVersionCode null  -> { skipped: false,
 *                                        reason: 'no_version_captured' }
 *   MIN > 0 && appVersionCode < MIN -> { skipped: true,
 *                                        reason: 'below_min_version' }
 *   MIN > 0 && appVersionCode >= MIN -> { skipped: false }
 *
 * Pure function — reads process.env only, no I/O, no clock. Safe to unit-test.
 * Callers MUST gate invocation behind `isEnabled(FLAGS.FCM_VERSION_GATE)`.
 *
 * @param token - minimal shape { appVersionCode?: number | null }
 * @returns VersionGateResult describing the decision
 */
export function shouldSkipForVersion(
  token: { appVersionCode?: number | null },
): VersionGateResult {
  const min = Number(process.env.MIN_SUPPORTED_APP_VERSION ?? 0);

  // MIN=0 (default) or non-positive — disabled, never skip.
  if (!Number.isFinite(min) || min <= 0) {
    return { skipped: false };
  }

  // Legacy clients (column is NULL) — warn-only, do NOT skip in Phase 3.
  // Operator flips to enforce at Phase 6 once Captain PR saturates ≥ 90% DAU.
  if (token.appVersionCode == null) {
    return { skipped: false, reason: 'no_version_captured' };
  }

  // Explicit version below threshold — skip.
  if (token.appVersionCode < min) {
    return { skipped: true, reason: 'below_min_version' };
  }

  // Current or above — send.
  return { skipped: false };
}
