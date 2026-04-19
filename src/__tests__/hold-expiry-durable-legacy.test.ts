/**
 * =============================================================================
 * F-A-77 — Durable HOLD_EXPIRY queue + 60s reconciler + SIGTERM (LEGACY path)
 * =============================================================================
 *
 * Verifies:
 *   1. Legacy monolith `truck-hold.service.ts` CLEANUP_INTERVAL_MS was lowered
 *      from 5_000 (every 5s) to 60_000 (every 60s — safety net cadence).
 *   2. Legacy `holdTrucks()` now calls `holdExpiryCleanupService.scheduleFlexHoldCleanup`
 *      with (holdId, expiresAt) after a successful hold, enqueuing a durable
 *      HOLD_EXPIRY job on Redis sorted-set delayed-queue (pattern: BullMQ +
 *      Uber Cadence durable timers).
 *   3. server.ts gracefulShutdown path invokes
 *      `truckHoldService.stopCleanupJob()` AND
 *      `redisService.releaseLock('hold:cleanup:unified', ...)` so a peer ECS
 *      task can take over the reconciler immediately without waiting for the
 *      60s lock TTL.
 *   4. .env.example documents the Redis `noeviction` policy requirement
 *      (BullMQ production guide — prevents silent job loss).
 *
 * These are source-text contract assertions (not runtime integration). They
 * enforce the invariants above and FAIL if a future regression silently
 * re-lowers the cadence or removes the durable enqueue.
 *
 * Industry references:
 *   - BullMQ: https://docs.bullmq.io/guide/going-to-production
 *   - Uber Cadence: https://cadenceworkflow.io/docs/use-cases/periodic-execution
 *   - Martin Fowler on persistent timers: https://martinfowler.com/articles/patterns-of-distributed-systems/scheduler.html
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

const TRUCK_HOLD_SERVICE_PATH = path.resolve(
  __dirname,
  '../modules/truck-hold/truck-hold.service.ts'
);
const SERVER_PATH = path.resolve(__dirname, '../server.ts');
const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../../.env.example');

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

describe('F-A-77 — Durable HOLD_EXPIRY queue + SIGTERM handler (legacy path)', () => {
  describe('truck-hold.service.ts — CLEANUP_INTERVAL_MS cadence', () => {
    const source = readSource(TRUCK_HOLD_SERVICE_PATH);

    test('CLEANUP_INTERVAL_MS is 60000 (60s safety-net) — not 5000', () => {
      // The monolith's CONFIG object is the single source of truth for cadence.
      expect(source).toMatch(/CLEANUP_INTERVAL_MS:\s*60000/);
      expect(source).not.toMatch(/CLEANUP_INTERVAL_MS:\s*5000\b/);
    });

    test('cadence downgrade is explicitly documented as F-A-77 safety-net', () => {
      // Ensures the intent is discoverable — a future editor cannot silently
      // revert without first stepping on this comment.
      expect(source).toMatch(/F-A-77/);
      expect(source).toMatch(/safety[- ]?net/i);
    });
  });

  describe('truck-hold.service.ts — durable enqueue in holdTrucks', () => {
    const source = readSource(TRUCK_HOLD_SERVICE_PATH);

    test('imports holdExpiryCleanupService from hold-expiry module', () => {
      expect(source).toMatch(
        /import\s+\{\s*holdExpiryCleanupService\s*\}\s+from\s+['"]\.\.\/hold-expiry\/hold-expiry-cleanup\.service['"]/
      );
    });

    test('calls scheduleFlexHoldCleanup(holdId, expiresAt) after a successful hold', () => {
      // Accept any formatting — just verify the call with both args exists.
      expect(source).toMatch(
        /holdExpiryCleanupService\.scheduleFlexHoldCleanup\(\s*holdId\s*,\s*expiresAt\s*\)/
      );
    });

    test('schedule failure is non-fatal (warn + reconciler fallback)', () => {
      // Fail-open invariant — losing the durable job should NOT fail the hold.
      // The 60s reconciler is the fallback path.
      const holdTrucksSlice = source.slice(
        source.indexOf('scheduleFlexHoldCleanup'),
        source.indexOf('scheduleFlexHoldCleanup') + 800
      );
      expect(holdTrucksSlice).toMatch(/logger\.(warn|error)/);
      expect(holdTrucksSlice).toMatch(/reconciler|safety|catch/i);
    });
  });

  describe('server.ts — SIGTERM graceful shutdown for cleanup reconciler', () => {
    const source = readSource(SERVER_PATH);

    test('SIGTERM handler is registered and routes to gracefulShutdown', () => {
      expect(source).toMatch(/process\.on\(\s*['"]SIGTERM['"]/);
      expect(source).toMatch(/gracefulShutdown/);
    });

    test('gracefulShutdown invokes truckHoldService.stopCleanupJob()', () => {
      // Direct owner-releases-what-owner-acquired pattern for the interval.
      expect(source).toMatch(/truckHoldService\.stopCleanupJob\s*\(\s*\)/);
    });

    test('gracefulShutdown explicitly releases hold:cleanup:unified Redis lock', () => {
      // BullMQ graceful-shutdown guidance: release owned locks so peer ECS
      // task can take over immediately rather than waiting for 60s TTL.
      expect(source).toMatch(
        /releaseLock\s*\(\s*['"]hold:cleanup:unified['"]/
      );
    });

    test('queueService.stop() is called (drains buffers before Redis shutdown)', () => {
      // F-A-77 depends on the queue still being online when the durable
      // HOLD_EXPIRY fires — shutdown ordering matters.
      expect(source).toMatch(/queueService\.stop\s*\(\s*\)/);
    });
  });

  describe('.env.example — REDIS_MAXMEMORY_POLICY documented', () => {
    const source = readSource(ENV_EXAMPLE_PATH);

    test('REDIS_MAXMEMORY_POLICY=noeviction is set at end of file', () => {
      expect(source).toMatch(/REDIS_MAXMEMORY_POLICY\s*=\s*noeviction/);
    });

    test('F-A-77 rationale is documented (BullMQ + sorted-set eviction risk)', () => {
      expect(source).toMatch(/F-A-77/);
      expect(source).toMatch(/noeviction/i);
      expect(source).toMatch(/BullMQ|bullmq/i);
    });

    test('section appears AFTER the PRODUCTION DEPLOYMENT CHECKLIST block', () => {
      // Enforces append-at-end ordering (LOCKS.md contract with C1's prior
      // append + d2-sanket precedent).
      const checklistIdx = source.indexOf('PRODUCTION DEPLOYMENT CHECKLIST');
      const policyIdx = source.indexOf('REDIS_MAXMEMORY_POLICY');
      expect(checklistIdx).toBeGreaterThan(-1);
      expect(policyIdx).toBeGreaterThan(-1);
      expect(policyIdx).toBeGreaterThan(checklistIdx);
    });
  });
});
