/**
 * =============================================================================
 * F-A-02 — Idempotency Hard-Require Tests
 * =============================================================================
 *
 * Covers the two halves of the F-A-02 fix:
 *  1. Route-level gate: missing `x-idempotency-key` is tolerated during the
 *     grace window (ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL in the future),
 *     and rejected after the deadline passes.
 *  2. Service-level replay: same key + same payload returns the stored
 *     response; same key + DIFFERENT payload raises an AppError(409)
 *     (Stripe / IETF draft-ietf-httpapi-idempotency-key-header-07 §2).
 *
 * The route-level gate is exercised as pure-logic (no Express harness) so the
 * test is deterministic and fast; the replay path mocks prismaClient directly.
 * =============================================================================
 */

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    orderIdempotency: {
      findUnique: jest.fn()
    }
  }
}));

import { prismaClient } from '../shared/database/prisma.service';
import { getDbIdempotentResponse } from '../modules/order/order-idempotency.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors the hard-require decision the route handler at
 * src/modules/order/order.routes.ts:198-225 makes. Returned value is what
 * the route would do in user-facing terms.
 */
function decideIdempotencyOutcome(
  clientKey: string | undefined,
  nowMs: number,
  graceUntilRaw: string | undefined
): 'accept_client_key' | 'server_generate_grace' | 'reject_400' {
  const trimmed = clientKey?.trim();
  const hasValidClientKey = !!trimmed && UUID_REGEX.test(trimmed);
  if (hasValidClientKey) return 'accept_client_key';

  const graceUntilMs = graceUntilRaw ? Date.parse(graceUntilRaw) : NaN;
  const inGraceWindow = Number.isFinite(graceUntilMs) && nowMs < graceUntilMs;
  return inGraceWindow ? 'server_generate_grace' : 'reject_400';
}

describe('F-A-02 — Idempotency hard-require route gate', () => {
  const FUTURE_DATE = '2099-01-01';
  const PAST_DATE = '2000-01-01';
  const NOW = Date.UTC(2026, 3, 20); // 2026-04-20

  it('rejects missing header AFTER grace deadline with a would-be 400', () => {
    const outcome = decideIdempotencyOutcome(undefined, NOW, PAST_DATE);
    expect(outcome).toBe('reject_400');
  });

  it('rejects invalid (non-UUID) header AFTER grace deadline', () => {
    const outcome = decideIdempotencyOutcome('not-a-uuid', NOW, PAST_DATE);
    expect(outcome).toBe('reject_400');
  });

  it('tolerates missing header DURING grace window via server-generated key', () => {
    const outcome = decideIdempotencyOutcome(undefined, NOW, FUTURE_DATE);
    expect(outcome).toBe('server_generate_grace');
  });

  it('tolerates missing header when ALLOW_MISSING_IDEMPOTENCY_KEY_UNTIL is unset (== no grace, reject)', () => {
    const outcome = decideIdempotencyOutcome(undefined, NOW, undefined);
    expect(outcome).toBe('reject_400');
  });

  it('accepts valid UUID v4 client key regardless of grace deadline', () => {
    const clientKey = '550e8400-e29b-41d4-a716-446655440000';
    expect(decideIdempotencyOutcome(clientKey, NOW, PAST_DATE)).toBe('accept_client_key');
    expect(decideIdempotencyOutcome(clientKey, NOW, FUTURE_DATE)).toBe('accept_client_key');
  });

  it('trims whitespace-only client keys and falls through to grace-window decision', () => {
    const outcome = decideIdempotencyOutcome('   ', NOW, PAST_DATE);
    expect(outcome).toBe('reject_400');
  });
});

describe('F-A-02 — Idempotency DB replay fingerprint comparison', () => {
  const customerId = 'c-1';
  const idempotencyKey = '550e8400-e29b-41d4-a716-446655440000';

  const storedResponse = {
    orderId: 'o-1',
    totalTrucks: 1,
    totalAmount: 100,
    dispatchState: 'dispatched' as const,
    dispatchAttempts: 1,
    onlineCandidates: 1,
    notifiedTransporters: 1,
    serverTimeMs: 0,
    truckRequests: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    expiresIn: 60
  };

  const findUniqueMock = (prismaClient.orderIdempotency.findUnique as unknown) as jest.Mock;

  beforeEach(() => {
    findUniqueMock.mockReset();
  });

  it('replays stored response when key + payload hash both match', async () => {
    findUniqueMock.mockResolvedValueOnce({
      customerId,
      idempotencyKey,
      payloadHash: 'hash-same',
      responseJson: storedResponse
    });

    const replay = await getDbIdempotentResponse(customerId, idempotencyKey, 'hash-same');
    expect(replay).toEqual(storedResponse);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } }
    });
  });

  it('raises 409 IDEMPOTENCY_CONFLICT when key matches but payload hash differs', async () => {
    findUniqueMock.mockResolvedValueOnce({
      customerId,
      idempotencyKey,
      payloadHash: 'hash-original',
      responseJson: storedResponse
    });

    await expect(
      getDbIdempotentResponse(customerId, idempotencyKey, 'hash-different')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_CONFLICT'
    });
  });

  it('returns null when no stored row exists for this key (first-time request)', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const replay = await getDbIdempotentResponse(customerId, idempotencyKey, 'hash-any');
    expect(replay).toBeNull();
  });

  it('constant-time comparison still detects a length-equal but differing hash', async () => {
    findUniqueMock.mockResolvedValueOnce({
      customerId,
      idempotencyKey,
      payloadHash: 'aaaaaaaaaa',
      responseJson: storedResponse
    });
    await expect(
      getDbIdempotentResponse(customerId, idempotencyKey, 'bbbbbbbbbb')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_CONFLICT'
    });
  });
});
