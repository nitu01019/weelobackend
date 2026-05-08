/**
 * =============================================================================
 * FIX #23 — Skip emit when pickupData missing (Halo's patch)
 * =============================================================================
 *
 * Behavioral contract under test:
 *   src/modules/order/order-broadcast.service.ts:996-1006
 *   src/modules/order/order-broadcast-send.service.ts:675-683
 *
 * For each candidate transporter the loop:
 *   1) Looks up pickupData = candidateDistanceMap?.get(transporterId)
 *   2) If missing → logs `broadcast.pickup_data_missing` warn
 *      and `continue;` — SKIPS both:
 *        a) alreadyNotifiedSet.add(transporterId)
 *        b) queueService.queueBroadcast(transporterId, 'new_broadcast', ...)
 *   3) Only when pickupData IS present, alreadyNotifiedSet.add fires AFTER
 *      the guard.
 *
 * This is a source-contract test (file content shape): it verifies that the
 * `continue;` precedes the alreadyNotifiedSet.add line so the guard cannot
 * be reordered without the test catching it.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const mock_23_orderBroadcastPath = path.resolve(
  __dirname,
  '../modules/order/order-broadcast.service.ts'
);
const mock_23_sendPath = path.resolve(
  __dirname,
  '../modules/order/order-broadcast-send.service.ts'
);

describe('Fix #23 — pickupData guard skips alreadyNotifiedSet + emit', () => {
  let mock_23_orderBroadcastSrc: string;
  let mock_23_sendSrc: string;

  beforeAll(() => {
    mock_23_orderBroadcastSrc = fs.readFileSync(mock_23_orderBroadcastPath, 'utf8');
    mock_23_sendSrc = fs.readFileSync(mock_23_sendPath, 'utf8');
  });

  describe('order-broadcast.service.ts', () => {
    it('contains pickupData lookup against candidateDistanceMap', () => {
      expect(mock_23_orderBroadcastSrc).toMatch(
        /const\s+pickupData\s*=\s*candidateDistanceMap\??\.get\(transporterId\)/
      );
    });

    it('emits broadcast.pickup_data_missing warn when pickupData is falsy', () => {
      expect(mock_23_orderBroadcastSrc).toContain('broadcast.pickup_data_missing');
      expect(mock_23_orderBroadcastSrc).toMatch(/if\s*\(\s*!pickupData\s*\)/);
    });

    it('the !pickupData branch contains `continue;` (early-exit)', () => {
      // Look at the 15 lines immediately after `if (!pickupData) {` —
      // that window is far smaller than the next loop body, so the `continue;`
      // we find must belong to the guard.
      const idx = mock_23_orderBroadcastSrc.search(/if\s*\(\s*!pickupData\s*\)/);
      expect(idx).toBeGreaterThan(0);
      const window = mock_23_orderBroadcastSrc.slice(idx, idx + 600);
      expect(window).toContain('broadcast.pickup_data_missing');
      expect(window).toMatch(/\bcontinue;/);
    });

    it('alreadyNotifiedSet.add(transporterId) appears AFTER the !pickupData guard', () => {
      const guardIdx = mock_23_orderBroadcastSrc.search(/if\s*\(\s*!pickupData\s*\)/);
      const addIdx = mock_23_orderBroadcastSrc.search(
        /alreadyNotifiedSet\.add\(\s*transporterId\s*\)/
      );
      expect(guardIdx).toBeGreaterThan(0);
      expect(addIdx).toBeGreaterThan(0);
      expect(addIdx).toBeGreaterThan(guardIdx);
    });

    it('queueService.queueBroadcast call appears AFTER the guard (i.e. only on hit)', () => {
      const guardIdx = mock_23_orderBroadcastSrc.search(/if\s*\(\s*!pickupData\s*\)/);
      const queueIdx = mock_23_orderBroadcastSrc.search(
        /queueService\s*\n?\s*\.\s*queueBroadcast\s*\(/
      );
      expect(guardIdx).toBeGreaterThan(0);
      expect(queueIdx).toBeGreaterThan(0);
      expect(queueIdx).toBeGreaterThan(guardIdx);
    });
  });

  describe('order-broadcast-send.service.ts (mirror)', () => {
    it('mirrors the pickupData lookup', () => {
      expect(mock_23_sendSrc).toMatch(
        /const\s+pickupData\s*=\s*candidateDistanceMap\??\.get\(transporterId\)/
      );
    });

    it('mirrors the broadcast.pickup_data_missing warn + continue;', () => {
      const idx = mock_23_sendSrc.search(/if\s*\(\s*!pickupData\s*\)/);
      expect(idx).toBeGreaterThan(0);
      const window = mock_23_sendSrc.slice(idx, idx + 600);
      expect(window).toContain('broadcast.pickup_data_missing');
      expect(window).toMatch(/\bcontinue;/);
    });
  });
});

export {};
