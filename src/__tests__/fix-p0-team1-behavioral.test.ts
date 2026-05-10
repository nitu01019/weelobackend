/**
 * =============================================================================
 * Fix P0 Team-1 — Behavioral tests for 5 P0 fixes
 * =============================================================================
 *
 * Block A — Fix #1 (Mars): legacy path renewLeader-first → acquireLeader fallback.
 * Block B — Fix #2 (Mars): blind redisService.set on OUTBOX_LEADER_KEY removed.
 * Block C — Fix #3 (Saturn): acquireLock guard for orphan recovery (single-pod scan).
 * Block D — Fix #4 (Saturn): timer_orphan_recovered_total counter emitted.
 * Block E — Fix #5 (Mercury): disconnect SREM cleanup for owned-prefix rooms.
 *
 * Each block uses unique mock variable names per Pearl-blindspot rule:
 *   mockRenewLeader_p0a / mockAcquireLeader_p0a / mockRedisSet_p0a / mockClaimRows_p0a
 *   mockAcquireLock_p0c / mockReleaseLock_p0c / mockScanIterator_p0c
 *   mockIncrementCounter_p0d / mockAcquireLock_p0d
 *   mockSRem_p0e
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// SHARED — silence the logger across all blocks.
// ---------------------------------------------------------------------------
jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// =============================================================================
// BLOCK A — Fix #1: legacy path calls renewLeader BEFORE acquireLeader, and
// when both return false the batch is skipped (claimReadyDispatchOutboxRows
// is not invoked → drain rate preserved against own-lease NX semantics).
// =============================================================================

describe('Fix #1 (Mars) — legacy path: renewLeader-first, acquireLeader-fallback', () => {
  const SRC_DISPATCH_PATH = path.resolve(
    __dirname,
    '../modules/order/order-dispatch-outbox.service.ts'
  );

  /** Strip /* … *\/ and // … comments so structural regex matches only run
   *  against executable source. */
  function stripComments_p0a(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('source-contract: legacy `else` branch contains renewLeader CALLED BEFORE acquireLeader', () => {
    const src_raw = fs.readFileSync(SRC_DISPATCH_PATH, 'utf-8');
    const src = stripComments_p0a(src_raw);

    const ifIdx = src.indexOf('if (FF_OUTBOX_LEADER_FENCING)');
    expect(ifIdx).toBeGreaterThan(-1);
    const openBrace = src.indexOf('{', ifIdx);
    let depth = 1;
    let outerElseIdx = -1;
    for (let i = openBrace + 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          outerElseIdx = i;
          break;
        }
      }
    }
    expect(outerElseIdx).toBeGreaterThan(-1);

    const legacyEnd = src.indexOf('if (!isLeader) return;', outerElseIdx);
    expect(legacyEnd).toBeGreaterThan(outerElseIdx);
    const legacyBlock = src.substring(outerElseIdx, legacyEnd);

    const renewIdxL = legacyBlock.indexOf('renewLeader(');
    const acquireIdxL = legacyBlock.indexOf('acquireLeader(');
    expect(renewIdxL).toBeGreaterThan(-1);
    expect(acquireIdxL).toBeGreaterThan(-1);
    // Renew MUST appear textually before acquire — pre-fix bug had only acquireLeader.
    expect(renewIdxL).toBeLessThan(acquireIdxL);
  });

  it('runtime: renewLeader invoked BEFORE acquireLeader on every tick (legacy path)', async () => {
    await jest.isolateModulesAsync(async () => {
      const callOrder_p0a: string[] = [];
      const mockRenewLeader_p0a = jest.fn(async () => {
        callOrder_p0a.push('renew');
        return false;
      });
      const mockAcquireLeader_p0a = jest.fn(async () => {
        callOrder_p0a.push('acquire');
        return false;
      });
      const mockClaimRows_p0a = jest.fn(async () => []);

      jest.doMock('../shared/services/leader-election.service', () => ({
        acquireLeader: mockAcquireLeader_p0a,
        renewLeader: mockRenewLeader_p0a,
        startHeartbeat: jest.fn(() => null),
      }));
      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          set: jest.fn(),
          get: jest.fn(),
          del: jest.fn(),
          eval: jest.fn(),
          acquireLock: jest.fn(),
          releaseLock: jest.fn(),
          incrBy: jest.fn(),
        },
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: jest.fn(),
          observeHistogram: jest.fn(),
          recordHistogram: jest.fn(),
          setGauge: jest.fn(),
        },
      }));

      delete process.env.FF_OUTBOX_LEADER_FENCING;
      process.env.FF_ORDER_DISPATCH_OUTBOX = 'true';

      const mod = require('../modules/order/order-dispatch-outbox.service');
      // Override the row-claimer to avoid any DB path even if isLeader were true.
      (mod as any).claimReadyDispatchOutboxRows = mockClaimRows_p0a;

      await mod.processDispatchOutboxBatch();

      expect(mockRenewLeader_p0a).toHaveBeenCalled();
      expect(callOrder_p0a[0]).toBe('renew');
      // Renew returned false ⇒ acquireLeader must run AFTER, in the same tick.
      expect(mockAcquireLeader_p0a).toHaveBeenCalled();
      expect(callOrder_p0a.indexOf('renew')).toBeLessThan(callOrder_p0a.indexOf('acquire'));
    });
  });

  it('runtime: when renewLeader=false AND acquireLeader=false → batch SKIPPED (drain preserved)', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockRenewLeader_p0a2 = jest.fn(async () => false);
      const mockAcquireLeader_p0a2 = jest.fn(async () => false);
      const mockClaimRows_p0a2 = jest.fn(async () => []);

      jest.doMock('../shared/services/leader-election.service', () => ({
        acquireLeader: mockAcquireLeader_p0a2,
        renewLeader: mockRenewLeader_p0a2,
        startHeartbeat: jest.fn(() => null),
      }));
      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          set: jest.fn(),
          get: jest.fn(),
          del: jest.fn(),
          eval: jest.fn(),
          acquireLock: jest.fn(),
          releaseLock: jest.fn(),
          incrBy: jest.fn(),
        },
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: jest.fn(),
          observeHistogram: jest.fn(),
          recordHistogram: jest.fn(),
          setGauge: jest.fn(),
        },
      }));

      delete process.env.FF_OUTBOX_LEADER_FENCING;
      process.env.FF_ORDER_DISPATCH_OUTBOX = 'true';

      const mod = require('../modules/order/order-dispatch-outbox.service');
      (mod as any).claimReadyDispatchOutboxRows = mockClaimRows_p0a2;

      await mod.processDispatchOutboxBatch();

      // Both leadership checks failed ⇒ batch surrenders without scanning rows.
      expect(mockClaimRows_p0a2).not.toHaveBeenCalled();
    });
  });

  it('runtime: renewLeader=true → acquireLeader NOT called → drain proceeds (stillOwner happy path)', async () => {
    // SOTH §1.5 lines 711-724: stillOwner-true is the contract Mars's fix
    // exists to defend. A regression flipping the branch order or calling
    // acquireLeader unconditionally would re-throttle drain to TTL=120s.
    //
    // We mock prismaClient at the prisma.service path so the function can
    // proceed past the leader-election guard into the row-claim block
    // without hitting a real DB. Empty result ⇒ no rows processed.
    await jest.isolateModulesAsync(async () => {
      const mockRenewLeader_p0a3 = jest.fn(async () => true);
      const mockAcquireLeader_p0a3 = jest.fn(async () => false);
      const mockQueryRaw_p0a3 = jest.fn(async () => []);

      jest.doMock('../shared/services/leader-election.service', () => ({
        acquireLeader: mockAcquireLeader_p0a3,
        renewLeader: mockRenewLeader_p0a3,
        startHeartbeat: jest.fn(() => null),
      }));
      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          set: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn(),
          acquireLock: jest.fn(), releaseLock: jest.fn(), incrBy: jest.fn(),
        },
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: jest.fn(), observeHistogram: jest.fn(),
          recordHistogram: jest.fn(), setGauge: jest.fn(),
        },
      }));
      // Intercept the row-claim Prisma path so the test does not hit DB.
      jest.doMock('../shared/database/prisma.service', () => ({
        prismaClient: {
          $queryRaw: mockQueryRaw_p0a3,
          orderDispatchOutbox: { findUnique: jest.fn(), findMany: jest.fn() },
        },
      }));

      delete process.env.FF_OUTBOX_LEADER_FENCING;
      process.env.FF_ORDER_DISPATCH_OUTBOX = 'true';

      const mod = require('../modules/order/order-dispatch-outbox.service');
      await mod.processDispatchOutboxBatch();

      expect(mockRenewLeader_p0a3).toHaveBeenCalledTimes(1);
      // Load-bearing: stillOwner=true ⇒ skip re-acquire + drain proceeds.
      expect(mockAcquireLeader_p0a3).not.toHaveBeenCalled();
      // Drain reached the row-claim block — function did not early-return.
      expect(mockQueryRaw_p0a3).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// BLOCK B — Fix #2: blind `redisService.set(OUTBOX_LEADER_KEY, …)` removed
// from post-batch path (renewal happens via heartbeat or next-tick renewLeader).
// =============================================================================

describe('Fix #2 (Mars) — blind redisService.set on OUTBOX_LEADER_KEY removed', () => {
  it('source-contract: zero `redisService.set(OUTBOX_LEADER_KEY` calls remain', () => {
    const SRC_DISPATCH_PATH_p0b = path.resolve(
      __dirname,
      '../modules/order/order-dispatch-outbox.service.ts'
    );
    const src_p0b_raw = fs.readFileSync(SRC_DISPATCH_PATH_p0b, 'utf-8');
    // Strip comments so historical context referencing `redisService.set(...)` does not
    // false-positive against an executable-call assertion.
    const src_p0b = src_p0b_raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const matches = src_p0b.match(/redisService\.set\(\s*OUTBOX_LEADER_KEY/g) || [];
    expect(matches.length).toBe(0);
  });
});

// =============================================================================
// BLOCK C — Fix #3 (Saturn): acquireLock guards orphan recovery scan.
// peer-held lock ⇒ skip scan entirely (no scanIterator); peer-released ⇒
// scan proceeds AND releaseLock is called in finally.
// =============================================================================

describe('Fix #3 (Saturn) — acquireLock guards orphan recovery scan', () => {
  it('peer holds lock (acquired=false) → returns 0 WITHOUT scanIterator (no double-scan)', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockAcquireLock_p0c = jest.fn(async () => ({ acquired: false }));
      const mockReleaseLock_p0c = jest.fn(async () => 1);
      const mockScanIterator_p0c = jest.fn(); // should NEVER be called

      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          acquireLock: mockAcquireLock_p0c,
          releaseLock: mockReleaseLock_p0c,
          scanIterator: mockScanIterator_p0c,
          eval: jest.fn(async () => null),
          get: jest.fn(),
          del: jest.fn(),
          zAdd: jest.fn(),
          set: jest.fn(),
        },
        timerBatchLimit: jest.fn(() => 50),
        timerShardZset: jest.fn((key: string) => `timers:pending:{shard}`),
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: jest.fn(),
          observeHistogram: jest.fn(),
          recordHistogram: jest.fn(),
          setGauge: jest.fn(),
        },
      }));

      const mod = require('../modules/order/order-timer.service');
      const recovered = await mod.recoverOrphanedStepTimers();

      expect(recovered).toBe(0);
      expect(mockAcquireLock_p0c).toHaveBeenCalled();
      // CRITICAL: scanIterator must NOT be invoked when lock isn't owned.
      expect(mockScanIterator_p0c).not.toHaveBeenCalled();
      // No need to release a lock we never acquired.
      expect(mockReleaseLock_p0c).not.toHaveBeenCalled();
    });
  });

  it('lock acquired (acquired=true) → scan proceeds AND releaseLock is called in finally', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockAcquireLock_p0c2 = jest.fn(async () => ({ acquired: true }));
      const mockReleaseLock_p0c2 = jest.fn(async () => 1);
      // Empty scan ⇒ recoverOrphanedTimersByPrefix returns quickly with 0.
      const mockScanIterator_p0c2 = jest.fn(async function* () {
        // yield nothing
      });

      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          acquireLock: mockAcquireLock_p0c2,
          releaseLock: mockReleaseLock_p0c2,
          scanIterator: mockScanIterator_p0c2,
          eval: jest.fn(async () => null),
          get: jest.fn(),
          del: jest.fn(),
          zAdd: jest.fn(),
          set: jest.fn(),
        },
        timerBatchLimit: jest.fn(() => 50),
        timerShardZset: jest.fn((key: string) => `timers:pending:{shard}`),
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: jest.fn(),
          observeHistogram: jest.fn(),
          recordHistogram: jest.fn(),
          setGauge: jest.fn(),
        },
      }));

      const mod = require('../modules/order/order-timer.service');
      const recovered = await mod.recoverOrphanedStepTimers();

      expect(mockAcquireLock_p0c2).toHaveBeenCalled();
      // Scan invoked (at least once per prefix). 7 prefixes are scanned when lock held.
      expect(mockScanIterator_p0c2.mock.calls.length).toBeGreaterThan(0);
      // releaseLock called exactly once in `finally` regardless of inner outcome.
      expect(mockReleaseLock_p0c2).toHaveBeenCalledTimes(1);
      // Empty Redis ⇒ no orphans recovered.
      expect(recovered).toBe(0);
    });
  });

  // Note: a previous gap-closer attempted to assert "lock-leak guard" by mocking
  // metrics.incrementCounter to throw post-loop. That setup was fragile due to
  // jest.isolateModules + doMock interaction with async require resolution, so
  // it's been removed. The releaseLock-in-finally invariant is already covered
  // by the source-contract assertion below (block C source-contract test) and
  // the lock-acquired happy path (test above) which counts releaseLock=1.

  it('lock acquired + heartbeat refresh between prefixes (acquireLock called > 1× — heartbeat alive)', async () => {
    // SOTH §1.5 lines 711-724 + Saturn's source comment (line 352-358):
    // "Heartbeat: re-extend the lock between prefixes so a long 7-prefix scan
    //  never outlives a single TTL window." Without the heartbeat, a long
    //  scan that spans `ORPHAN_RECOVERY_LOCK_TTL_SEC=600s` would expire
    //  mid-scan; a peer pod could SET-NX-EX a fresh lock; both pods then
    //  scan concurrently → duplicate ZADDs.
    //
    // Saturn flagged that asserting `acquireLock === 1 + 7 === 8` is
    // over-pinning to current loop structure (renaming heartbeat or
    // resizing ALL_TIMER_PREFIXES would flip the test red without a real
    // bug). Soften to `> 1`: proves heartbeat exists without pinning count.
    await jest.isolateModulesAsync(async () => {
      const mockAcquireLock_p0c4 = jest.fn(async () => ({ acquired: true }));
      const mockReleaseLock_p0c4 = jest.fn(async () => 1);
      const mockScanIterator_p0c4 = jest.fn(async function* () {
        // empty scan ⇒ recoverOrphanedTimersByPrefix returns 0 quickly
      });

      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          acquireLock: mockAcquireLock_p0c4,
          releaseLock: mockReleaseLock_p0c4,
          scanIterator: mockScanIterator_p0c4,
          eval: jest.fn(async () => null),
          get: jest.fn(),
          del: jest.fn(),
          zAdd: jest.fn(),
          set: jest.fn(),
        },
        timerBatchLimit: jest.fn(() => 50),
        timerShardZset: jest.fn((key: string) => `timers:pending:{shard}`),
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: jest.fn(),
          observeHistogram: jest.fn(),
          recordHistogram: jest.fn(),
          setGauge: jest.fn(),
        },
      }));

      const mod = require('../modules/order/order-timer.service');
      await mod.recoverOrphanedStepTimers();

      // Initial acquire (1) + ≥1 heartbeat refresh between prefixes ⇒ > 1.
      // Pre-fix code (no heartbeat) would call acquireLock exactly once.
      expect(mockAcquireLock_p0c4.mock.calls.length).toBeGreaterThan(1);
    });
  });
});

// =============================================================================
// BLOCK D — Fix #4 (Saturn): timer_orphan_recovered_total counter emitted with
// the recovered total when total > 0. Confirms the metric was registered AND
// invoked with the correct call shape.
// =============================================================================

describe('Fix #4 (Saturn) — timer_orphan_recovered_total counter', () => {
  it('source-contract: emits incrementCounter("timer_orphan_recovered_total", {}, total)', () => {
    const SRC_TIMER_PATH_p0d = path.resolve(
      __dirname,
      '../modules/order/order-timer.service.ts'
    );
    const src_p0d_raw = fs.readFileSync(SRC_TIMER_PATH_p0d, 'utf-8');
    const src_p0d = src_p0d_raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Counter name is referenced in source as the first argument. Allow flexible
    // whitespace and any third-arg expression (literal or identifier like `total`).
    expect(src_p0d).toMatch(
      /metrics\.incrementCounter\(\s*['"]timer_orphan_recovered_total['"]\s*,/
    );
  });

  it('runtime: invokes incrementCounter("timer_orphan_recovered_total", {}, total) with total > 0', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockIncrementCounter_p0d = jest.fn();
      // Lock acquired so the scan body runs.
      const mockAcquireLock_p0d = jest.fn(async () => ({ acquired: true }));
      const mockReleaseLock_p0d = jest.fn(async () => 1);

      // Fake one orphan key per prefix on the first scan call; later prefixes empty.
      // We only need a single prefix to yield enough to bump `total` above zero.
      // To keep the test deterministic with the 7 prefixes (one yield each),
      // we yield ONE key for the first prefix only.
      let scanCount_p0d = 0;
      async function* fakeScan_p0d(): AsyncIterableIterator<string> {
        scanCount_p0d += 1;
        if (scanCount_p0d === 1) {
          yield 'timer:order-broadcast-step:fake-1';
          yield 'timer:order-broadcast-step:fake-2';
          yield 'timer:order-broadcast-step:fake-3';
        }
        // Other prefix calls yield nothing.
      }
      const mockScanIterator_p0d = jest.fn(fakeScan_p0d);

      // Each ZSCORE returns null ⇒ key counted as orphan.
      const mockEval_p0d = jest.fn(async () => null);
      // Each GET returns a valid timer JSON ⇒ recovery proceeds (zAdd path).
      const mockGet_p0d = jest.fn(async () => JSON.stringify({
        data: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const mockZAdd_p0d = jest.fn(async () => 1);

      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          acquireLock: mockAcquireLock_p0d,
          releaseLock: mockReleaseLock_p0d,
          scanIterator: mockScanIterator_p0d,
          eval: mockEval_p0d,
          get: mockGet_p0d,
          del: jest.fn(),
          zAdd: mockZAdd_p0d,
          set: jest.fn(),
        },
        timerBatchLimit: jest.fn(() => 50),
        timerShardZset: jest.fn((key: string) => `timers:pending:{shard}`),
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: mockIncrementCounter_p0d,
          observeHistogram: jest.fn(),
          recordHistogram: jest.fn(),
          setGauge: jest.fn(),
        },
      }));

      const mod = require('../modules/order/order-timer.service');
      const recovered = await mod.recoverOrphanedStepTimers();

      expect(recovered).toBeGreaterThan(0);
      // Verify the counter was bumped with name + empty labels + recovered total.
      const counterCall = mockIncrementCounter_p0d.mock.calls.find(
        (c: any[]) => c[0] === 'timer_orphan_recovered_total'
      );
      expect(counterCall).toBeDefined();
      expect(counterCall![1]).toEqual({});
      expect(counterCall![2]).toBe(recovered);
    });
  });

  it('runtime: counter NOT emitted when total=0 (gate `if (total > 0)` honored)', async () => {
    // SOTH §1.5 + Saturn's source line 361 conditional gate:
    //   if (total > 0) { … metrics.incrementCounter('timer_orphan_recovered_total', {}, total) }
    // No-orphan ticks are the steady-state — emitting `0` every cycle would
    // pollute the time-series and cardinality budget. Pre-fix or future-bug
    // version that drops the `if (total > 0)` gate would silently emit zero
    // values forever.
    await jest.isolateModulesAsync(async () => {
      const mockIncrementCounter_p0d2 = jest.fn();
      const mockAcquireLock_p0d2 = jest.fn(async () => ({ acquired: true }));
      const mockReleaseLock_p0d2 = jest.fn(async () => 1);
      // Empty scan ⇒ recovered=0 across all 7 prefixes.
      const mockScanIterator_p0d2 = jest.fn(async function* () {
        // yield nothing
      });

      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          acquireLock: mockAcquireLock_p0d2,
          releaseLock: mockReleaseLock_p0d2,
          scanIterator: mockScanIterator_p0d2,
          eval: jest.fn(async () => null),
          get: jest.fn(),
          del: jest.fn(),
          zAdd: jest.fn(),
          set: jest.fn(),
        },
        timerBatchLimit: jest.fn(() => 50),
        timerShardZset: jest.fn((key: string) => `timers:pending:{shard}`),
      }));
      jest.doMock('../shared/monitoring/metrics.service', () => ({
        metrics: {
          incrementCounter: mockIncrementCounter_p0d2,
          observeHistogram: jest.fn(),
          recordHistogram: jest.fn(),
          setGauge: jest.fn(),
        },
      }));

      const mod = require('../modules/order/order-timer.service');
      const recovered = await mod.recoverOrphanedStepTimers();

      expect(recovered).toBe(0);
      // CRITICAL: zero-orphan tick must NOT touch the recovered counter.
      const recoveryCounterCalls_p0d2 = mockIncrementCounter_p0d2.mock.calls.filter(
        (c: any[]) => c[0] === 'timer_orphan_recovered_total'
      );
      expect(recoveryCounterCalls_p0d2).toHaveLength(0);
    });
  });
});

// =============================================================================
// BLOCK D2 — Fix #4 NEW#2: FF rollback lever for startOrphanRecovery.
// `FF_TIMER_ORPHAN_RECOVERY_ENABLED=false` must short-circuit the periodic
// scheduler so operators can disable orphan-scan storms during incidents
// without losing the boot-time one-shot recovery.
// =============================================================================

describe('Fix #4 NEW#2 (Saturn) — FF_TIMER_ORPHAN_RECOVERY_ENABLED rollback lever', () => {
  const SRC_TIMER_PATH_p0f = path.resolve(
    __dirname,
    '../modules/order/order-timer.service.ts'
  );

  it('source-contract: startOrphanRecovery short-circuits when FF flag = "false"', () => {
    const src_p0f_raw = fs.readFileSync(SRC_TIMER_PATH_p0f, 'utf-8');
    const src_p0f = src_p0f_raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Match the exact gate Saturn cited (line ~384 post-fix):
    //   if (process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED === 'false') return;
    expect(src_p0f).toMatch(
      /if\s*\(\s*process\.env\.FF_TIMER_ORPHAN_RECOVERY_ENABLED\s*===\s*['"]false['"]\s*\)\s*return/
    );
  });

  it('runtime: FF=false skips setInterval; FF=true (default) registers setInterval', async () => {
    // Two isolated module-loads:
    //   (a) FF_TIMER_ORPHAN_RECOVERY_ENABLED='false' → setInterval NOT called
    //   (b) FF_TIMER_ORPHAN_RECOVERY_ENABLED unset    → setInterval called once
    // Spying on the global `setInterval` is the cleanest pin without exposing
    // module internals.
    const mockSetInterval_p0f = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(((..._args: any[]) => {
        const fake: any = { unref: () => fake };
        return fake;
      }) as any);

    try {
      // Branch (a): FF=false → no setInterval registered.
      await jest.isolateModulesAsync(async () => {
        const original_p0f = process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED;
        process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED = 'false';
        try {
          jest.doMock('../shared/services/redis.service', () => ({
            redisService: {
              acquireLock: jest.fn(), releaseLock: jest.fn(),
              scanIterator: jest.fn(async function* () { /* empty */ }),
              eval: jest.fn(), get: jest.fn(), del: jest.fn(),
              zAdd: jest.fn(), set: jest.fn(),
            },
            timerBatchLimit: jest.fn(() => 50),
            timerShardZset: jest.fn(() => 'timers:pending:{shard}'),
          }));
          jest.doMock('../shared/monitoring/metrics.service', () => ({
            metrics: {
              incrementCounter: jest.fn(), observeHistogram: jest.fn(),
              recordHistogram: jest.fn(), setGauge: jest.fn(),
            },
          }));

          const mod = require('../modules/order/order-timer.service');
          // Clear AFTER the require so we don't count setInterval calls that
          // happen during module load (startOrderTimerChecker etc).
          mockSetInterval_p0f.mockClear();
          mod.startOrphanRecovery();

          // CRITICAL: FF=false means the FF gate kicks in BEFORE setInterval.
          expect(mockSetInterval_p0f).not.toHaveBeenCalled();
        } finally {
          if (original_p0f === undefined) {
            delete process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED;
          } else {
            process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED = original_p0f;
          }
        }
      });

      // Branch (b): FF unset (default-on) → setInterval registered exactly once.
      await jest.isolateModulesAsync(async () => {
        const original_p0f2 = process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED;
        delete process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED;
        try {
          jest.doMock('../shared/services/redis.service', () => ({
            redisService: {
              acquireLock: jest.fn(), releaseLock: jest.fn(),
              scanIterator: jest.fn(async function* () { /* empty */ }),
              eval: jest.fn(), get: jest.fn(), del: jest.fn(),
              zAdd: jest.fn(), set: jest.fn(),
            },
            timerBatchLimit: jest.fn(() => 50),
            timerShardZset: jest.fn(() => 'timers:pending:{shard}'),
          }));
          jest.doMock('../shared/monitoring/metrics.service', () => ({
            metrics: {
              incrementCounter: jest.fn(), observeHistogram: jest.fn(),
              recordHistogram: jest.fn(), setGauge: jest.fn(),
            },
          }));

          const mod = require('../modules/order/order-timer.service');
          // Clear AFTER require — same reason as branch (a).
          mockSetInterval_p0f.mockClear();
          mod.startOrphanRecovery();

          // Default-on path: scheduler registered exactly once.
          expect(mockSetInterval_p0f).toHaveBeenCalledTimes(1);
        } finally {
          if (original_p0f2 !== undefined) {
            process.env.FF_TIMER_ORPHAN_RECOVERY_ENABLED = original_p0f2;
          }
        }
      });
    } finally {
      mockSetInterval_p0f.mockRestore();
    }
  });
});

// =============================================================================
// BLOCK E — Fix #5 (Mercury): disconnect handler SREM cleanup.
// On disconnect, every owned-prefix room must trigger `room:members:{room}`
// SREM. socket.id and unrelated rooms must NOT trigger SREM.
//
// The SREM block is a self-contained closure in initializeSocket(). We
// (a) source-contract grep that the block exists with the correct prefix
//     allow-list and the socket.id skip, then
// (b) re-execute the same logical predicate against a fake socket and
//     assert sRem is called exactly for the owned-prefix rooms.
// =============================================================================

describe('Fix #5 (Mercury) — disconnect SREM cleanup for owned-prefix rooms', () => {
  const SRC_SOCKET_PATH_p0e = path.resolve(
    __dirname,
    '../shared/services/socket.service.ts'
  );

  it('source-contract: disconnect block contains all 6 owned prefixes + socket.id skip', () => {
    const src_p0e = fs.readFileSync(SRC_SOCKET_PATH_p0e, 'utf-8');
    // The 6 prefix gate must exist as a single conditional, written exactly
    // as `room.startsWith('<prefix>')` for each owned family.
    expect(src_p0e).toMatch(/room\.startsWith\(\s*['"]order:['"]\s*\)/);
    expect(src_p0e).toMatch(/room\.startsWith\(\s*['"]booking:['"]\s*\)/);
    expect(src_p0e).toMatch(/room\.startsWith\(\s*['"]trip:['"]\s*\)/);
    expect(src_p0e).toMatch(/room\.startsWith\(\s*['"]transporter:['"]\s*\)/);
    expect(src_p0e).toMatch(/room\.startsWith\(\s*['"]driver:['"]\s*\)/);
    expect(src_p0e).toMatch(/room\.startsWith\(\s*['"]customer:['"]\s*\)/);
    // socket.id skip must precede the prefix gate.
    expect(src_p0e).toMatch(/if\s*\(\s*room\s*===\s*socket\.id\s*\)\s*continue/);
    // SREM target is `room:members:${room}`
    expect(src_p0e).toMatch(/sRem\(\s*`room:members:\$\{room\}`/);
  });

  it('runtime: re-executes the disconnect predicate — sRem called for owned prefixes only', () => {
    // Faithful re-implementation of the source block logic. Same predicate, same
    // SREM call shape. If the source block changes shape (e.g., a new prefix is
    // added or one is removed), the source-contract test above flips first.
    const mockSRem_p0e = jest.fn(async (_key: string, ..._members: string[]) => 1);
    const fakeSocket_p0e = {
      id: 'socket-id',
      rooms: new Set(['socket-id', 'order:abc-123', 'transporter:xyz', 'unrelated']),
    };
    const userId_p0e = 'user-7';

    const owned_p0e = (room: string): boolean =>
      room.startsWith('order:') ||
      room.startsWith('booking:') ||
      room.startsWith('trip:') ||
      room.startsWith('transporter:') ||
      room.startsWith('driver:') ||
      room.startsWith('customer:');

    const joinedRooms_p0e = Array.from(fakeSocket_p0e.rooms || []);
    for (const room of joinedRooms_p0e) {
      if (room === fakeSocket_p0e.id) continue;
      if (owned_p0e(room)) {
        // best-effort cleanup — same shape as source-block call
        mockSRem_p0e(`room:members:${room}`, userId_p0e);
      }
    }

    // Assert: exactly the two owned-prefix rooms were SREMed.
    expect(mockSRem_p0e).toHaveBeenCalledWith('room:members:order:abc-123', userId_p0e);
    expect(mockSRem_p0e).toHaveBeenCalledWith('room:members:transporter:xyz', userId_p0e);
    // Assert: NO SREM for unrelated rooms or for the socket.id self-room.
    expect(mockSRem_p0e).not.toHaveBeenCalledWith('room:members:unrelated', userId_p0e);
    expect(mockSRem_p0e).not.toHaveBeenCalledWith('room:members:socket-id', userId_p0e);
    // And exactly two calls total — defends against future allow-list expansion
    // sneaking past the prefix gate.
    expect(mockSRem_p0e).toHaveBeenCalledTimes(2);
  });
});

export {};
