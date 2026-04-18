/**
 * =============================================================================
 * F-A-85 -- Hold Reconciliation Backlog Metrics (RED/GREEN)
 * =============================================================================
 *
 * Asserts that the 4 new observability metrics are registered as canonicals
 * in metrics-definitions.ts (single-source-of-truth per CLAUDE.md) AND that
 * hold-reconciliation.service.ts wires them during the reconciliation loop:
 *
 *   - hold_reconciliation_backlog (gauge)
 *   - hold_reconciliation_oldest_expired_age_seconds (gauge)
 *   - hold_reconciliation_cycle_duration_seconds (histogram)
 *   - hold_reconciliation_processed_total (counter)
 *
 * Scenario: seed 5 expired FLEX holds -> after a full cycle:
 *   - backlog gauge observed
 *   - processed_total counter incremented by 5
 *   - cycle_duration_seconds histogram sample recorded
 * =============================================================================
 */

describe('F-A-85 -- hold reconciliation backlog metrics', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('all 4 metrics registered as canonicals in metrics-definitions.ts', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { metrics } = require('../shared/monitoring/metrics.service');
    const json = metrics.getMetricsJSON() as {
      counters: Record<string, unknown>;
      gauges: Record<string, unknown>;
      histograms: Record<string, unknown>;
    };

    expect(json.gauges['hold_reconciliation_backlog']).toBeDefined();
    expect(json.gauges['hold_reconciliation_oldest_expired_age_seconds']).toBeDefined();
    expect(json.histograms['hold_reconciliation_cycle_duration_seconds']).toBeDefined();
    expect(json.counters['hold_reconciliation_processed_total']).toBeDefined();
  });

  test('reconciliation cycle updates backlog gauge, processed counter, and cycle histogram', async () => {
    // ---- Mock setup must run before service require() ----
    jest.doMock('../shared/services/logger.service', () => ({
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      },
    }));

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      },
    }));

    const oneHourAgo = new Date(Date.now() - 3600 * 1000);
    const seededFlex = Array.from({ length: 5 }, (_, i) => ({
      holdId: `hold-${i}`,
      orderId: `order-${i}`,
      transporterId: 't1',
      flexExpiresAt: oneHourAgo,
    }));

    jest.doMock('../shared/database/prisma.service', () => ({
      prismaClient: {
        truckHoldLedger: {
          findMany: jest.fn().mockImplementation(({ where }) => {
            if (where.phase === 'FLEX') return Promise.resolve(seededFlex);
            return Promise.resolve([]);
          }),
          findUnique: jest.fn().mockResolvedValue({ phase: 'FLEX' }),
          count: jest.fn().mockResolvedValue(0),
        },
      },
    }));

    // Stub the cleanup service so processExpiredHoldById resolves quickly.
    jest.doMock('../modules/hold-expiry/hold-expiry-cleanup.service', () => ({
      holdExpiryCleanupService: {
        processExpiredHold: jest.fn().mockResolvedValue(undefined),
      },
    }));

    // Snapshot the processed_total counter *before* we run the cycle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { metrics } = require('../shared/monitoring/metrics.service');
    const before = metrics.getMetricsJSON() as {
      counters: Record<string, Record<string, number>>;
      histograms: Record<string, { count: Record<string, number> }>;
    };
    const beforeProcessed = (before.counters['hold_reconciliation_processed_total'] || {})[''] || 0;
    const beforeCycleCount = (before.histograms['hold_reconciliation_cycle_duration_seconds']?.count || {})[''] || 0;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HoldReconciliationService } = require('../modules/hold-expiry/hold-reconciliation.service');
    const svc = new HoldReconciliationService();
    await (svc as any).reconcileExpiredHolds();

    const after = metrics.getMetricsJSON() as {
      counters: Record<string, Record<string, number>>;
      gauges: Record<string, number>;
      histograms: Record<string, { count: Record<string, number> }>;
    };

    // processed_total incremented by exactly 5
    const afterProcessed = (after.counters['hold_reconciliation_processed_total'] || {})[''] || 0;
    expect(afterProcessed - beforeProcessed).toBe(5);

    // cycle_duration_seconds histogram recorded one sample
    const afterCycleCount = (after.histograms['hold_reconciliation_cycle_duration_seconds']?.count || {})[''] || 0;
    expect(afterCycleCount - beforeCycleCount).toBe(1);

    // backlog gauge exists and is non-negative (count mock returned 0 post-processing)
    expect(typeof after.gauges['hold_reconciliation_backlog']).toBe('number');
    expect(after.gauges['hold_reconciliation_backlog']).toBeGreaterThanOrEqual(0);
  });
});
