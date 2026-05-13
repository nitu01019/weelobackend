// =============================================================================
// 1. src/shared/http/idempotency-headers.ts
// =============================================================================
// Stripe spec §"Idempotent Requests" — `Idempotent-Replayed: true` is the
// standard signal for retry-replay disambiguation. Centralized here so all
// idempotent routes share one implementation; the TypeScript `replayed?: boolean`
// field on every CreateXResponseData makes this a compile-time opt-in.
import type { Response } from 'express';

export type ReplaySource = 'redis-cache' | 'db-replay';

export interface IdempotentReplayResult {
  /** True iff this response is a replay of a prior request (Stripe signal). */
  replayed?: boolean;
  /** Dev/staging only — surfaces which cache layer served the replay.
   *  Production wire contract MUST omit this header (Stripe parity). */
  replaySource?: ReplaySource;
}

/**
 * Set `Idempotent-Replayed: true` when the response is a replay (Stripe-compatible).
 * Adds `X-Weelo-Replay-Source: <redis-cache|db-replay>` outside production for
 * server-side observability — production strips it to preserve wire parity with Stripe.
 *
 * Per Niko R5-B: opt-in dev-throw uses `=== 'development'` (NOT `!== 'production'`)
 * to avoid leaking the source header in staging/test/CI environments by default.
 * Staging may opt in by setting NODE_ENV=development; production is fail-closed.
 */
export function setIdempotentReplayedHeader(
  res: Response,
  result: IdempotentReplayResult
): void {
  if (result.replayed !== true) return;
  res.setHeader('Idempotent-Replayed', 'true');
  if (process.env.NODE_ENV === 'development' && result.replaySource) {
    res.setHeader('X-Weelo-Replay-Source', result.replaySource);
  }
}
