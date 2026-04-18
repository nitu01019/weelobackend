/**
 * =============================================================================
 * P1-T1.5 L6 — In-memory backpressure startup log (log-once invariant)
 * =============================================================================
 *
 * Verifies that the `[BACKPRESSURE] In-memory mode engaged...` warn log fires
 * AT MOST ONCE per process boot, even when the in-memory fallback is hit many
 * times. L6 is documentation-only — no functional change to the backpressure
 * counter behaviour is asserted here.
 * =============================================================================
 */

import type { OrderCreateContext } from '../modules/order/order-create-context';

// Capture every `logger.warn` call so we can assert on the BACKPRESSURE line.
const warnCalls: string[] = [];

jest.mock('../shared/services/logger.service', () => {
  return {
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn((...args: unknown[]) => {
        const first = args[0];
        if (typeof first === 'string') warnCalls.push(first);
      }),
      error: jest.fn(),
    },
  };
});

// Force the Redis primary path to fail every time so the fallback branch is always hit.
jest.mock('../shared/services/redis.service', () => {
  return {
    redisService: {
      incrBy: jest.fn().mockRejectedValue(new Error('simulated Redis outage')),
      expire: jest.fn().mockResolvedValue(true),
    },
  };
});

// Minimal context fixture that satisfies the fields `acquireOrderBackpressure` reads.
function makeContext(): OrderCreateContext {
  return {
    request: {} as OrderCreateContext['request'],
    backpressureKey: 'bp:test',
    maxConcurrentOrders: 40,
    requestPayloadHash: 'hash',
    lockKey: 'lock:test',
    lockAcquired: false,
    dedupeKey: '',
    idempotencyHash: '',
    distanceSource: 'client_fallback',
    clientDistanceKm: 0,
    totalAmount: 0,
    totalTrucks: 0,
    routePoints: [],
    pickup: { latitude: 0, longitude: 0, address: '' },
    drop: { latitude: 0, longitude: 0, address: '' },
    orderId: '',
    expiresAt: '',
    truckRequests: [],
    responseRequests: [],
    dispatchState: 'queued',
    dispatchReasonCode: undefined,
    dispatchAttempts: 0,
    onlineCandidates: 0,
    notifiedTransporters: 0,
    orderResponse: null,
    earlyReturn: null,
  };
}

describe('P1-T1.5 L6 — in-memory backpressure startup log', () => {
  test('[BACKPRESSURE] engaged log fires at most once per process', async () => {
    // Fresh import so the module-level `inMemoryModeLogged` starts false.
    jest.resetModules();
    // Re-attach the mocks on the reset module graph.
    // (jest.resetModules clears the registry but preserves mock factories.)
    const { acquireOrderBackpressure } = await import('../modules/order/order-creation.service');

    // Drive the fallback path repeatedly.
    for (let i = 0; i < 5; i += 1) {
      const ctx = makeContext();
      await acquireOrderBackpressure(ctx).catch(() => { /* 503 after cap hit is expected */ });
    }

    const engagedLines = warnCalls.filter((m) =>
      m.startsWith('[BACKPRESSURE] In-memory mode engaged'),
    );
    expect(engagedLines).toHaveLength(1);
    expect(engagedLines[0]).toMatch(/per-instance capacity = \d+/);
    expect(engagedLines[0]).toMatch(/Redis unavailable or disabled/);
    expect(engagedLines[0]).toMatch(/Per-instance drift expected across multiple ECS tasks/);
  });
});
