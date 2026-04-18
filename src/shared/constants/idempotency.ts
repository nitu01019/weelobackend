/**
 * =============================================================================
 * F-A-24 — Unified Idempotency / Active-Broadcast TTL constants
 * =============================================================================
 *
 * Stripe / IETF draft-ietf-httpapi-idempotency-key-header §6 recommends a 24h
 * idempotency window. The active-broadcast guard SHOULD share the same TTL so
 * both halves of the dedup pair age together and terminal-state cleanup can
 * delete BOTH keys atomically. Previously the active-broadcast key was set to
 * orderTimeoutSeconds + 60 (~180s with default config), which expired ~480x
 * earlier than the idempotency cache and produced ghost "active broadcast"
 * conflicts on retry far before the 24h replay window was due to expire.
 * =============================================================================
 */

export const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24h, matches Stripe convention
export const ACTIVE_BROADCAST_TTL_SECONDS = 86_400;
