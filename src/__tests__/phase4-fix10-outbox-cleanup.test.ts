/**
 * =============================================================================
 * PHASE 4 — FIX #10 — OrderDispatchOutbox archival cron
 * =============================================================================
 *
 * Validates:
 *   (a) Lock acquired → runOnce calls $transaction → returns
 *       {deleted:N, iterations:M, skipped:false}.
 *   (b) Lock NOT acquired → returns {deleted:0, iterations:0, skipped:true}
 *       and $transaction is NEVER called.
 *   (c) MAX_ITERATIONS cap respected — never exceeds 20 iterations.
 *   (d) Transaction error mid-iteration → returns partial deleted count +
 *       iterations + skipped:false (caught, no throw).
 *   (e) Lock released in finally even when transaction throws.
 *   (f) DISPATCH_OUTBOX_RETENTION_DAYS env override works; defaults to 7.
 * =============================================================================
 */

import type { OutboxCleanupDeps } from '../shared/jobs/cleanup-dispatch-outbox.job';

describe('Phase 4 — Fix #10 — cleanup-dispatch-outbox.job', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const makeDeps = (overrides: Partial<OutboxCleanupDeps> = {}): OutboxCleanupDeps => {
    const baseLock = {
      acquire: jest.fn().mockResolvedValue({ acquired: true }),
      release: jest.fn().mockResolvedValue(true),
    };
    const basePrisma = {
      $transaction: jest.fn().mockResolvedValue(0),
    };
    const baseLogger = {
      info: jest.fn(),
      warn: jest.fn(),
    };
    return {
      now: () => new Date('2026-05-11T00:00:00Z'),
      lock: baseLock,
      prisma: basePrisma as never,
      logger: baseLogger,
      workerId: 'test-worker',
      ...overrides,
    };
  };

  // -------------------------------------------------------------------------
  // (a) Lock acquired → runs DELETE
  // -------------------------------------------------------------------------
  it('runs DELETE when lock acquired', async () => {
    const { runOnce } = await import('../shared/jobs/cleanup-dispatch-outbox.job');
    const txFn = jest.fn().mockResolvedValue(123);
    const deps = makeDeps({
      prisma: { $transaction: txFn } as never,
    });

    const result = await runOnce(deps);

    expect(deps.lock.acquire).toHaveBeenCalledWith('cleanup:dispatch-outbox', 'test-worker', 60);
    expect(txFn).toHaveBeenCalledTimes(1);
    // 123 < DELETE_BATCH_LIMIT (5000) → break after 1 iteration
    expect(result).toEqual({ deleted: 123, iterations: 1, skipped: false });
    expect(deps.lock.release).toHaveBeenCalledWith('cleanup:dispatch-outbox', 'test-worker');
  });

  // -------------------------------------------------------------------------
  // (b) Lock not acquired → bow out
  // -------------------------------------------------------------------------
  it('returns skipped:true and zero deletes when lock not acquired', async () => {
    const { runOnce } = await import('../shared/jobs/cleanup-dispatch-outbox.job');
    const txFn = jest.fn();
    const deps = makeDeps({
      lock: {
        acquire: jest.fn().mockResolvedValue({ acquired: false }),
        release: jest.fn(),
      },
      prisma: { $transaction: txFn } as never,
    });

    const result = await runOnce(deps);

    expect(result).toEqual({ deleted: 0, iterations: 0, skipped: true });
    expect(txFn).not.toHaveBeenCalled();
    expect(deps.lock.release).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (c) MAX_ITERATIONS=20 cap respected — full-batch (5000) every iter
  // -------------------------------------------------------------------------
  it('caps at MAX_ITERATIONS (20) when every batch is full', async () => {
    const { runOnce } = await import('../shared/jobs/cleanup-dispatch-outbox.job');
    // Each iteration returns exactly DELETE_BATCH_LIMIT (5000) → never breaks early
    const txFn = jest.fn().mockResolvedValue(5000);
    const deps = makeDeps({
      prisma: { $transaction: txFn } as never,
    });

    const result = await runOnce(deps);

    expect(txFn).toHaveBeenCalledTimes(20);
    expect(result.iterations).toBe(20);
    expect(result.deleted).toBe(100_000);
    expect(result.skipped).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (d) Transaction error mid-iteration → partial counts returned, no throw
  // -------------------------------------------------------------------------
  it('returns partial deleted count when transaction throws mid-iteration', async () => {
    const { runOnce } = await import('../shared/jobs/cleanup-dispatch-outbox.job');
    const txFn = jest
      .fn()
      .mockResolvedValueOnce(5000) // iter 1 ok
      .mockResolvedValueOnce(5000) // iter 2 ok
      .mockRejectedValueOnce(new Error('PG statement_timeout')); // iter 3 throws
    const deps = makeDeps({
      prisma: { $transaction: txFn } as never,
    });

    const result = await runOnce(deps);

    expect(result.skipped).toBe(false);
    expect(result.deleted).toBe(10_000); // 2 successful iterations × 5000
    expect(result.iterations).toBe(3); // attempted 3 (last one threw)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[OutboxCleanup:Dispatch] Run failed',
      expect.objectContaining({
        error: 'PG statement_timeout',
        deletedBeforeError: 10_000,
        iterations: 3,
      })
    );
  });

  // -------------------------------------------------------------------------
  // (e) Lock released in finally on error
  // -------------------------------------------------------------------------
  it('releases lock in finally even when transaction throws', async () => {
    const { runOnce } = await import('../shared/jobs/cleanup-dispatch-outbox.job');
    const releaseSpy = jest.fn().mockResolvedValue(true);
    const txFn = jest.fn().mockRejectedValue(new Error('boom'));
    const deps = makeDeps({
      lock: {
        acquire: jest.fn().mockResolvedValue({ acquired: true }),
        release: releaseSpy,
      },
      prisma: { $transaction: txFn } as never,
    });

    await runOnce(deps);

    expect(releaseSpy).toHaveBeenCalledWith('cleanup:dispatch-outbox', 'test-worker');
  });

  // -------------------------------------------------------------------------
  // (f) DISPATCH_OUTBOX_RETENTION_DAYS env override
  // -------------------------------------------------------------------------
  it('respects DISPATCH_OUTBOX_RETENTION_DAYS env override (and defaults to 7)', async () => {
    // Default: 7 days. now=2026-05-11 → cutoff=2026-05-04T00:00:00Z
    {
      delete process.env.DISPATCH_OUTBOX_RETENTION_DAYS;
      jest.resetModules();
      const { runOnce } = await import('../shared/jobs/cleanup-dispatch-outbox.job');
      const deps = makeDeps();
      await runOnce(deps);
      expect(deps.logger.info).toHaveBeenCalledWith(
        '[OutboxCleanup:Dispatch] Starting',
        expect.objectContaining({
          cutoffIso: '2026-05-04T00:00:00.000Z',
          retentionDays: 7,
        })
      );
    }

    // Override: 14 days. now=2026-05-11 → cutoff=2026-04-27T00:00:00Z
    {
      process.env.DISPATCH_OUTBOX_RETENTION_DAYS = '14';
      jest.resetModules();
      const { runOnce } = await import('../shared/jobs/cleanup-dispatch-outbox.job');
      const deps = makeDeps();
      await runOnce(deps);
      expect(deps.logger.info).toHaveBeenCalledWith(
        '[OutboxCleanup:Dispatch] Starting',
        expect.objectContaining({
          cutoffIso: '2026-04-27T00:00:00.000Z',
          retentionDays: 14,
        })
      );
    }
  });
});
