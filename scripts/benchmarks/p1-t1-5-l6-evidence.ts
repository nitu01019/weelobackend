/**
 * P1-T1.5 L6 evidence capture — forces the in-memory backpressure fallback
 * and prints the real logger output so T1.7 can cite it in P1-HANDOFF.md.
 *
 * Run: `node_modules/.bin/ts-node --transpile-only scripts/benchmarks/p1-t1-5-l6-evidence.ts`
 *
 * Expected behaviour: 5 attempts, [BACKPRESSURE] engaged log appears EXACTLY
 * ONCE. Subsequent attempts hit the fallback path but the once-guard suppresses
 * re-emission.
 */

import { logger } from '../../src/shared/services/logger.service';
import { redisService } from '../../src/shared/services/redis.service';
import { acquireOrderBackpressure } from '../../src/modules/order/order-creation.service';
import type { OrderCreateContext } from '../../src/modules/order/order-create-context';

// Force Redis incrBy to throw so the fallback branch always fires.
(redisService as unknown as { incrBy: (k: string, n: number) => Promise<number> }).incrBy = async () => {
  throw new Error('simulated Redis outage');
};

function makeContext(): OrderCreateContext {
  return {
    request: {} as OrderCreateContext['request'],
    backpressureKey: 'bp:evidence',
    maxConcurrentOrders: 40,
    requestPayloadHash: 'hash',
    lockKey: 'lock:evidence',
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

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('--- L6 evidence run: 5 fallback hits, expect one [BACKPRESSURE] line ---');
  for (let i = 0; i < 5; i += 1) {
    const ctx = makeContext();
    await acquireOrderBackpressure(ctx).catch((err: unknown) => {
      logger.debug(`attempt ${i + 1} rejected: ${(err as Error).message}`);
    });
  }
  // eslint-disable-next-line no-console
  console.log('--- end of run ---');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
