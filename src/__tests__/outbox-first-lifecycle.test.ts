/**
 * =============================================================================
 * F-B-50: FCM outbox canonical SEED contract tests
 * =============================================================================
 *
 * Canonical seed contract (pre-F-B-58/62 downstream primary-write-path
 * expansion):
 *
 *   1. `LIFECYCLE_OUTBOX_DLQ_MAX` unified constant in
 *      `src/shared/constants/outbox.constants.ts`. Mirrors the `DLQ_MAX_SIZE=5000`
 *      value that currently lives in `queue.types.ts:68` so that future DLQ
 *      consumers share one source of truth.
 *
 *   2. `LIFECYCLE_EMIT_EVENTS` exported from the same constants file so the
 *      notification outbox and socket service can agree on which events are
 *      durable-lifecycle (downstream F-B-58 uses this to gate the primary-
 *      write path; until then the set is read-only and unused by lifecycle
 *      writes).
 *
 *   3. `acquireLifecycleMutex(orderId, eventName)` helper in
 *      `src/modules/notification/outbox-lifecycle-mutex.service.ts` — a Redis
 *      `SET NX EX` gate keyed per-(orderId,eventName), short TTL, so that a
 *      ordered-lifecycle writer can serialise duplicate-event writes WITHOUT
 *      yet taking over the primary write path (F-B-58 in P8 will flip
 *      `FF_OUTBOX_FIRST_ENABLED`).
 *
 *   4. `FF_OUTBOX_FIRST_ENABLED` flag is REGISTERED (default OFF). Acquiring
 *      the mutex with FF off is a NO-OP and returns `true` (legacy path
 *      untouched) — F-B-58/62 flips the flag and consumes the mutex.
 *
 * RED before F-B-50 seed:
 *   - The constants file does not exist.
 *   - The mutex service does not exist.
 *   - The flag is not in the registry.
 *
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

const acquireLockMock = jest.fn();
const releaseLockMock = jest.fn();

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    acquireLock: (...args: unknown[]) => acquireLockMock(...args),
    releaseLock: (...args: unknown[]) => releaseLockMock(...args),
  },
}));

import * as outboxConstants from '../shared/constants/outbox.constants';
import {
  acquireLifecycleMutex,
  releaseLifecycleMutex,
  lifecycleMutexKey,
} from '../modules/notification/outbox-lifecycle-mutex.service';
import { FLAGS, isEnabled } from '../shared/config/feature-flags';

describe('F-B-50: FCM outbox canonical SEED', () => {
  describe('LIFECYCLE_OUTBOX_DLQ_MAX constant', () => {
    it('exports a unified DLQ cap at 5000 by default', () => {
      expect(outboxConstants.LIFECYCLE_OUTBOX_DLQ_MAX).toBe(5000);
    });

    it('mirrors the DLQ_MAX_SIZE from queue.types.ts (single source of truth)', () => {
      const { DLQ_MAX_SIZE } = require('../shared/services/queue.types');
      expect(outboxConstants.LIFECYCLE_OUTBOX_DLQ_MAX).toBe(DLQ_MAX_SIZE);
    });
  });

  describe('LIFECYCLE_EMIT_EVENTS constant', () => {
    it('exports a non-empty ReadonlySet<string> of lifecycle event names', () => {
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS).toBeInstanceOf(Set);
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.size).toBeGreaterThan(0);
    });

    it('covers the canonical two-phase hold events', () => {
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.has('flex_hold_started')).toBe(true);
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.has('hold_confirmed')).toBe(true);
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.has('hold_released')).toBe(true);
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.has('hold_expired')).toBe(true);
    });

    it('covers the broadcast + booking lifecycle fan-out', () => {
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.has('new_broadcast')).toBe(true);
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.has('booking_updated')).toBe(true);
      expect(outboxConstants.LIFECYCLE_EMIT_EVENTS.has('order_cancelled')).toBe(true);
    });
  });

  describe('FF_OUTBOX_FIRST_ENABLED flag', () => {
    it('is registered in the feature-flag registry', () => {
      expect((FLAGS as Record<string, unknown>).OUTBOX_FIRST_ENABLED).toBeDefined();
    });

    it('is OFF by default (safe rollout)', () => {
      delete process.env.FF_OUTBOX_FIRST_ENABLED;
      const def = (FLAGS as Record<string, { env: string; category: string }>)
        .OUTBOX_FIRST_ENABLED;
      expect(def.env).toBe('FF_OUTBOX_FIRST_ENABLED');
      expect(isEnabled(def as unknown as Parameters<typeof isEnabled>[0])).toBe(false);
    });
  });

  describe('acquireLifecycleMutex helper', () => {
    beforeEach(() => {
      delete process.env.FF_OUTBOX_FIRST_ENABLED;
    });

    it('is a no-op (returns true) when FF_OUTBOX_FIRST_ENABLED is OFF — legacy path untouched', async () => {
      const acquired = await acquireLifecycleMutex('order-1', 'hold_confirmed');
      expect(acquired).toBe(true);
    });

    it('releaseLifecycleMutex is a no-op (returns true) when flag is OFF', async () => {
      const released = await releaseLifecycleMutex('order-1', 'hold_confirmed');
      expect(released).toBe(true);
    });
  });

  describe('mutex ordering invariant — primary-write path disabled seed', () => {
    it('when flag is OFF, second acquire for (orderId,event) still returns true (no blocking — F-B-58 flips this)', async () => {
      delete process.env.FF_OUTBOX_FIRST_ENABLED;
      const a = await acquireLifecycleMutex('order-seed', 'new_broadcast');
      const b = await acquireLifecycleMutex('order-seed', 'new_broadcast');
      expect(a).toBe(true);
      expect(b).toBe(true);
    });
  });

  describe('lifecycleMutexKey helper', () => {
    it('formats the canonical mutex key shape outbox:lifecycle:mutex:<orderId>:<event>', () => {
      const k = lifecycleMutexKey('ord-42', 'hold_confirmed');
      expect(k).toBe('outbox:lifecycle:mutex:ord-42:hold_confirmed');
    });
  });

  describe('acquireLifecycleMutex — FF_OUTBOX_FIRST_ENABLED=true path (downstream F-B-58 preview)', () => {
    beforeEach(() => {
      acquireLockMock.mockReset();
      releaseLockMock.mockReset();
      process.env.FF_OUTBOX_FIRST_ENABLED = 'true';
    });

    afterEach(() => {
      delete process.env.FF_OUTBOX_FIRST_ENABLED;
    });

    it('forwards to redisService.acquireLock and returns true on acquired', async () => {
      acquireLockMock.mockResolvedValueOnce({ acquired: true });
      const ok = await acquireLifecycleMutex('ord-1', 'hold_confirmed');
      expect(ok).toBe(true);
      expect(acquireLockMock).toHaveBeenCalledTimes(1);
      const [key, holder, ttl] = acquireLockMock.mock.calls[0];
      expect(key).toBe('outbox:lifecycle:mutex:ord-1:hold_confirmed');
      expect(holder).toBe('outbox-lifecycle');
      expect(ttl).toBeGreaterThan(0);
    });

    it('returns false when the lock is already held', async () => {
      acquireLockMock.mockResolvedValueOnce({ acquired: false });
      const ok = await acquireLifecycleMutex('ord-1', 'hold_confirmed');
      expect(ok).toBe(false);
    });

    it('fails open: returns true when Redis throws (do not block lifecycle writes)', async () => {
      acquireLockMock.mockRejectedValueOnce(new Error('redis down'));
      const ok = await acquireLifecycleMutex('ord-1', 'hold_confirmed');
      expect(ok).toBe(true);
    });

    it('releaseLifecycleMutex forwards to redisService.releaseLock and returns true', async () => {
      releaseLockMock.mockResolvedValueOnce(undefined);
      const ok = await releaseLifecycleMutex('ord-1', 'hold_confirmed');
      expect(ok).toBe(true);
      expect(releaseLockMock).toHaveBeenCalledTimes(1);
      const [key, holder] = releaseLockMock.mock.calls[0];
      expect(key).toBe('outbox:lifecycle:mutex:ord-1:hold_confirmed');
      expect(holder).toBe('outbox-lifecycle');
    });

    it('releaseLifecycleMutex swallows errors and returns true (TTL cleanup fallback)', async () => {
      releaseLockMock.mockRejectedValueOnce(new Error('redis down'));
      const ok = await releaseLifecycleMutex('ord-1', 'hold_confirmed');
      expect(ok).toBe(true);
    });

    it('acquireLifecycleMutex handles non-Error rejection (string throw) without crashing', async () => {
      acquireLockMock.mockRejectedValueOnce('bare string failure');
      const ok = await acquireLifecycleMutex('ord-1', 'hold_confirmed');
      expect(ok).toBe(true);
    });

    it('releaseLifecycleMutex handles non-Error rejection (string throw) without crashing', async () => {
      releaseLockMock.mockRejectedValueOnce('bare string failure');
      const ok = await releaseLifecycleMutex('ord-1', 'hold_confirmed');
      expect(ok).toBe(true);
    });
  });
});
