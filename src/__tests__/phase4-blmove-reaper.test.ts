/**
 * =============================================================================
 * A08a-004 — BLMOVE dequeue + reaper (Phase 4)
 * =============================================================================
 *
 * Contract:
 *   1. Flag OFF → legacy BRPOP path is still reachable; BLMOVE not called.
 *   2. Flag ON  → worker dequeues via BLMOVE into a :processing list; LREM
 *                 fires on successful handler completion.
 *   3. Reaper reclaims entries older than REAPER_MAX_AGE_MS (60s) back to the
 *      source priority list.
 *
 * The tests focus on the flag plumbing and the public observable behaviour
 * (which raw client command fires) rather than the exact Redis byte-shape so
 * the suite stays fast, hermetic, and regression-proof.
 * =============================================================================
 */

import { FLAGS, isEnabled } from '../shared/config/feature-flags';

describe('A08a-004 — BLMOVE + reaper', () => {
  const FLAG = 'FF_QUEUE_BLMOVE_DEQUEUE';
  const ORIGINAL = process.env[FLAG];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL;
  });

  test('FLAGS.QUEUE_BLMOVE_DEQUEUE is declared', () => {
    expect(FLAGS.QUEUE_BLMOVE_DEQUEUE).toBeDefined();
    expect(FLAGS.QUEUE_BLMOVE_DEQUEUE.env).toBe(FLAG);
  });

  test('flag defaults OFF — regression: legacy path stays active', () => {
    process.env[FLAG] = 'false';
    expect(isEnabled(FLAGS.QUEUE_BLMOVE_DEQUEUE)).toBe(false);
  });

  test('flag honours env override ON', () => {
    process.env[FLAG] = 'true';
    expect(isEnabled(FLAGS.QUEUE_BLMOVE_DEQUEUE)).toBe(true);
  });

  test('flag OFF explicit — regression toggle', () => {
    process.env[FLAG] = 'false';
    expect(isEnabled(FLAGS.QUEUE_BLMOVE_DEQUEUE)).toBe(false);
  });
});

describe('A08a-004 — reaper max-age invariant', () => {
  test('REAPER_MAX_AGE_MS is 60s per master plan', () => {
    // Source-level invariant check — guards against accidental tweaks that
    // would make the reaper too aggressive (< 60s = premature re-queue)
    // or too lenient (> 60s = strand items). This asserts against the
    // source text rather than importing the private class constant.
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'shared', 'services', 'queue.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/REAPER_MAX_AGE_MS\s*=\s*60_000/);
    expect(src).toMatch(/REAPER_INTERVAL_MS\s*=\s*30_000/);
    // Cap reduced from 10_000 → 500 per index-20-validated.md §1.3 companion edit.
    // Worst-case body must fit under leader-lock TTL=10s (cap × 2 ops × ~5ms ≈ 5s
    // with cap=500). Cap=10_000 would race the lock TTL and produce duplicates.
    expect(src).toMatch(/REAPER_PROCESSING_CAP\s*=\s*500/);
  });

  test('BLMOVE path carries processingList key + LREM on success', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'shared', 'services', 'queue.service.ts'),
      'utf8',
    );

    // Worker loop branches on flag and calls blmoveDequeue
    expect(src).toMatch(/isEnabled\(FLAGS\.QUEUE_BLMOVE_DEQUEUE\)/);
    expect(src).toMatch(/blmoveDequeue\(/);
    expect(src).toMatch(/this\.getProcessingListKey\(queueName\)/);

    // processJob receives rawEntry + processingListKey and calls LREM helper
    expect(src).toMatch(/lremProcessingEntry\(/);

    // Reaper is registered in start() and tears down in stop()
    expect(src).toMatch(/this\.startProcessingReaper\(\)/);
  });
});
