/**
 * =============================================================================
 * F-B-77: Broadcast dedup canonical SEED tests
 * =============================================================================
 *
 * Canonical seed contract (pre-F-B-78/81/82 downstream callsite wiring):
 *
 *   1. `acquireBroadcastDedup(key, ttlSec)` helper in
 *      `src/shared/services/broadcast-dedup.service.ts` performs a Redis
 *      `SET NX EX` against `key`. The canonical key shape documented by
 *      INDEX.md Part 3 is `broadcast:dedup:order:<orderId>:<vehicleType>:<vehicleSubtype>`.
 *      Returns `true` the first time, `false` on subsequent acquires within
 *      TTL.
 *
 *   2. `FF_BROADCAST_DEDUP_ENABLED` feature flag is REGISTERED (default OFF).
 *      Until P8 (F-B-78/81/82) wires this into `broadcastVehicleTypePayload`
 *      callsites, the helper itself is functional but unused at runtime.
 *
 *   3. The helper must be FAILSAFE: any Redis error is treated as "dedup
 *      unavailable" → return `true` so a broadcast is never silently dropped
 *      when the dedup layer is degraded.
 *
 * RED before F-B-77 seed:
 *   - The helper module does not exist.
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

import {
  acquireBroadcastDedup,
  broadcastDedupKey,
} from '../shared/services/broadcast-dedup.service';
import { FLAGS, isEnabled } from '../shared/config/feature-flags';

describe('F-B-77: broadcast dedup canonical SEED', () => {
  beforeEach(() => {
    acquireLockMock.mockReset();
    releaseLockMock.mockReset();
    delete process.env.FF_BROADCAST_DEDUP_ENABLED;
  });

  describe('FF_BROADCAST_DEDUP_ENABLED flag registration', () => {
    it('is registered in the feature-flag registry', () => {
      expect((FLAGS as Record<string, unknown>).BROADCAST_DEDUP_ENABLED).toBeDefined();
    });

    it('has env name FF_BROADCAST_DEDUP_ENABLED', () => {
      const def = (FLAGS as Record<string, { env: string }>).BROADCAST_DEDUP_ENABLED;
      expect(def.env).toBe('FF_BROADCAST_DEDUP_ENABLED');
    });

    it('is OFF by default', () => {
      const def = (FLAGS as Record<string, { env: string; category: string }>)
        .BROADCAST_DEDUP_ENABLED;
      expect(isEnabled(def as unknown as Parameters<typeof isEnabled>[0])).toBe(false);
    });
  });

  describe('broadcastDedupKey helper', () => {
    it('formats the canonical dedup key: broadcast:dedup:order:<id>:<type>:<subtype>', () => {
      const k = broadcastDedupKey('ord123', 'heavy_truck', 'open');
      expect(k).toBe('broadcast:dedup:order:ord123:heavy_truck:open');
    });

    it('accepts empty vehicleSubtype without producing double-colons', () => {
      const k = broadcastDedupKey('ord123', 'heavy_truck', '');
      expect(k).toBe('broadcast:dedup:order:ord123:heavy_truck:');
    });
  });

  describe('acquireBroadcastDedup — SETNX gate', () => {
    it('returns true on first acquire within TTL (SETNX wins)', async () => {
      acquireLockMock.mockResolvedValueOnce({ acquired: true });
      const first = await acquireBroadcastDedup(
        'broadcast:dedup:order:X:heavy_truck:open',
        300
      );
      expect(first).toBe(true);
      expect(acquireLockMock).toHaveBeenCalledTimes(1);
    });

    it('returns false on second acquire within TTL (dedup rejection)', async () => {
      acquireLockMock.mockResolvedValueOnce({ acquired: true });
      acquireLockMock.mockResolvedValueOnce({ acquired: false });
      const a = await acquireBroadcastDedup('k1', 300);
      const b = await acquireBroadcastDedup('k1', 300);
      expect(a).toBe(true);
      expect(b).toBe(false);
    });

    it('uses the provided ttlSec (default 300) as lock TTL', async () => {
      acquireLockMock.mockResolvedValueOnce({ acquired: true });
      await acquireBroadcastDedup('k2', 42);
      const callArgs = acquireLockMock.mock.calls[0];
      expect(callArgs[2]).toBe(42);
    });

    it('defaults ttlSec to 300s when omitted', async () => {
      acquireLockMock.mockResolvedValueOnce({ acquired: true });
      await acquireBroadcastDedup('k3');
      const callArgs = acquireLockMock.mock.calls[0];
      expect(callArgs[2]).toBe(300);
    });

    it('fails safe: returns true when the underlying Redis op throws (do NOT silently drop broadcasts)', async () => {
      acquireLockMock.mockRejectedValueOnce(new Error('redis down'));
      const result = await acquireBroadcastDedup('k4', 300);
      expect(result).toBe(true);
    });

    it('handles non-Error throws (string, object) without crashing', async () => {
      acquireLockMock.mockRejectedValueOnce('bare string failure');
      const result = await acquireBroadcastDedup('k5', 300);
      expect(result).toBe(true);
    });
  });
});
