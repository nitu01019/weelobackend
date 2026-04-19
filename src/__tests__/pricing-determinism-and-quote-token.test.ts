/**
 * =============================================================================
 * F-A-26 — Pricing determinism + signed quote token tests
 * =============================================================================
 *
 * Covers the three halves of the F-A-26 fix:
 *  1. Surge determinism: two back-to-back `calculateEstimate` calls within
 *     the same 5-minute IST bucket return identical `pricePerTruck`,
 *     `surgeRuleId`, and `quoteToken`.
 *  2. IST independence: an explicit `timestampMs` is honoured regardless of
 *     the container's local TZ (Intl.DateTimeFormat with timeZone='Asia/Kolkata').
 *  3. Quote token HMAC lifecycle: `signQuoteToken` + `verifyQuoteToken`
 *     accept the original payload, reject tampered prices, and reject
 *     expired buckets per the Stripe PaymentIntent / Adyen HMAC pattern.
 * =============================================================================
 */

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// F-A-26: pricing HMAC key falls back to a deterministic dev-only string
// when JWT_SECRET is unset. Lock the env for deterministic hashes.
process.env.JWT_SECRET = 'fa26-test-secret-do-not-use-in-prod';

import { pricingService, signQuoteToken, verifyQuoteToken } from '../modules/pricing/pricing.service';

const FIVE_MIN_MS = 5 * 60 * 1000;

describe('F-A-26 — Surge determinism (H3 × 5-min bucket)', () => {
  it('two calls in the same 5-min bucket return identical price, ruleId, and token', () => {
    // 2026-04-15 14:02:00 UTC == 2026-04-15 19:32 IST (weekday, evening peak is
    // 17-19 IST so 19:32 is peak). Both calls fall in the [14:00, 14:05) bucket.
    const t0 = Date.UTC(2026, 3, 15, 14, 2, 0);
    const t1 = Date.UTC(2026, 3, 15, 14, 4, 59);
    const a = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:BLR',
      timestampMs: t0,
    });
    const b = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:BLR',
      timestampMs: t1,
    });
    expect(a.pricePerTruck).toBe(b.pricePerTruck);
    expect(a.surgeMultiplier).toBe(b.surgeMultiplier);
    expect(a.surgeRuleId).toBe(b.surgeRuleId);
    expect(a.quoteToken).toBe(b.quoteToken);
    expect(a.surgeBucketStart).toBe(b.surgeBucketStart);
    expect(a.surgeBucketEnd).toBe(b.surgeBucketEnd);
  });

  it('crossing a 5-min boundary produces a different bucket + ruleId', () => {
    const insideA = Date.UTC(2026, 3, 15, 14, 4, 59);
    const insideB = Date.UTC(2026, 3, 15, 14, 5, 0);
    const a = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:BLR',
      timestampMs: insideA,
    });
    const b = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:BLR',
      timestampMs: insideB,
    });
    // Same surge rule (hour unchanged) but a different bucketStart must flip
    // both the bucket + ruleId (hash includes bucketStart) and the token.
    expect(a.surgeBucketStart).not.toBe(b.surgeBucketStart);
    expect(a.surgeRuleId).not.toBe(b.surgeRuleId);
    expect(a.quoteToken).not.toBe(b.quoteToken);
  });

  it('different cellIds in the same bucket produce different ruleIds + tokens', () => {
    const t = Date.UTC(2026, 3, 15, 14, 2, 0);
    const blr = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:BLR',
      timestampMs: t,
    });
    const del = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:DEL',
      timestampMs: t,
    });
    expect(blr.pricePerTruck).toBe(del.pricePerTruck); // same surge rule
    expect(blr.surgeRuleId).not.toBe(del.surgeRuleId);
    expect(blr.quoteToken).not.toBe(del.quoteToken);
  });

  it('IST peak hours detected deterministically regardless of UTC hour-of-day', () => {
    // 09:00 IST on a Wednesday == 03:30 UTC. The legacy implementation using
    // `new Date().getHours()` on a UTC container would have seen hour=3 (night
    // multiplier only). With the IST formatter this must see hour=9 (peak).
    const utcEarlyMorning = Date.UTC(2026, 3, 15, 3, 30, 0); // 09:00 IST Wed
    const estimate = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:BLR',
      timestampMs: utcEarlyMorning,
    });
    expect(estimate.surgeMultiplier).toBe(1.2);
    expect(estimate.breakdown.surgeFactor).toBe('Peak Hours');
  });
});

describe('F-A-26 — Signed quote token HMAC verify', () => {
  const payload = {
    pricePerTruck: 7500,
    surgeRuleId: 'deadbeefcafebabe',
    surgeBucketStart: '2026-04-15T14:00:00.000Z',
    surgeBucketEnd: '2026-04-15T14:05:00.000Z',
  };

  it('signQuoteToken is deterministic for the same payload', () => {
    expect(signQuoteToken(payload)).toBe(signQuoteToken(payload));
  });

  it('verifyQuoteToken accepts the original token + payload inside the bucket window', () => {
    const token = signQuoteToken(payload);
    const nowInBucket = Date.parse(payload.surgeBucketStart) + 2 * 60 * 1000;
    expect(verifyQuoteToken(token, payload, nowInBucket)).toBe(true);
  });

  it('verifyQuoteToken rejects a tampered price even with a valid-looking token', () => {
    const token = signQuoteToken(payload);
    const tamperedPayload = { ...payload, pricePerTruck: 1 };
    const nowInBucket = Date.parse(payload.surgeBucketStart) + 60 * 1000;
    expect(verifyQuoteToken(token, tamperedPayload, nowInBucket)).toBe(false);
  });

  it('verifyQuoteToken rejects an expired bucket even when HMAC matches', () => {
    const token = signQuoteToken(payload);
    const afterBucket = Date.parse(payload.surgeBucketEnd) + 1;
    expect(verifyQuoteToken(token, payload, afterBucket)).toBe(false);
  });

  it('verifyQuoteToken rejects obviously malformed tokens (empty / wrong-length)', () => {
    const nowInBucket = Date.parse(payload.surgeBucketStart) + 60 * 1000;
    expect(verifyQuoteToken('', payload, nowInBucket)).toBe(false);
    expect(verifyQuoteToken('short', payload, nowInBucket)).toBe(false);
  });

  it('round-trips the token emitted by calculateEstimate', () => {
    const t = Date.UTC(2026, 3, 15, 14, 2, 0);
    const estimate = pricingService.calculateEstimate({
      vehicleType: 'open',
      vehicleSubtype: '17 Feet',
      distanceKm: 200,
      trucksNeeded: 1,
      cellId: 'city:BLR',
      timestampMs: t,
    });
    expect(estimate.quoteToken).toBeDefined();
    expect(estimate.surgeRuleId).toBeDefined();
    const nowInBucket = Date.parse(estimate.surgeBucketStart!) + 60 * 1000;
    const ok = verifyQuoteToken(
      estimate.quoteToken!,
      {
        pricePerTruck: estimate.pricePerTruck,
        surgeRuleId: estimate.surgeRuleId!,
        surgeBucketStart: estimate.surgeBucketStart!,
        surgeBucketEnd: estimate.surgeBucketEnd!,
      },
      nowInBucket
    );
    expect(ok).toBe(true);
  });
});
