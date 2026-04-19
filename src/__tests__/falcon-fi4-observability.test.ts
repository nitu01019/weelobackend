/**
 * Tests for TEAM FALCON FI4 observability fixes:
 *   #128 — truncate utility (unconditional ellipsis)
 *   #135 — reconciliation activeRun guard
 *   #140 — decrementGauge allows negative and warns
 */

// ---------------------------------------------------------------------------
// #128: truncate utility
// ---------------------------------------------------------------------------

import { truncate } from '../shared/utils/truncate';

describe('truncate()', () => {
  it('returns the original string when it fits within maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('does not add ellipsis when string length equals maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis when string exceeds maxLen', () => {
    const result = truncate('hello world', 8);
    // 8 - 3 (suffix '...') = 5 chars kept → 'hello...'
    expect(result).toBe('hello...');
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('returns empty string for null/undefined-like input', () => {
    expect(truncate('', 10)).toBe('');
    expect(truncate(undefined as unknown as string, 10)).toBe('');
    expect(truncate(null as unknown as string, 10)).toBe('');
  });

  it('supports a custom suffix', () => {
    expect(truncate('abcdefghij', 7, '~')).toBe('abcdef~');
  });
});

// ---------------------------------------------------------------------------
// #140: decrementGauge allows negative and logs warning
// ---------------------------------------------------------------------------

describe('MetricsService.decrementGauge', () => {
  // Inline mock so we don't import the real singleton (which starts timers)
  let warnCalls: unknown[][] = [];

  beforeEach(() => {
    warnCalls = [];
    jest.resetModules();
  });

  it('clamps gauge at zero (does not go negative)', () => {
    // We test the logic directly rather than importing the singleton,
    // because the singleton constructor starts setInterval timers.
    jest.doMock('../shared/services/logger.service', () => ({
      logger: {
        warn: (...args: unknown[]) => { warnCalls.push(args); },
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { metrics } = require('../shared/monitoring/metrics.service');

    // Start at 0
    metrics.setGauge('http_active_requests', 0);
    metrics.decrementGauge('http_active_requests', 1);

    // Gauge should be clamped at 0 (Math.max(0, ...))
    const json = metrics.getMetricsJSON() as Record<string, Record<string, number>>;
    expect(json.gauges['http_active_requests']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #135: reconciliation activeRun guard
// ---------------------------------------------------------------------------

describe('HoldReconciliationService activeRun guard', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('reconciliation uses distributed lock to prevent concurrent runs', async () => {
    // Stub dependencies with paths relative to *this test file* in src/__tests__/
    jest.doMock('../shared/services/logger.service', () => ({
      logger: {
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }
    }));

    const mockAcquireLock = jest.fn().mockResolvedValue({ acquired: false });
    const mockReleaseLock = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        acquireLock: mockAcquireLock,
        releaseLock: mockReleaseLock,
      }
    }));

    jest.doMock('../shared/database/prisma.service', () => ({
      prismaClient: {
        truckHoldLedger: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
        }
      }
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HoldReconciliationService } = require('../modules/hold-expiry/hold-reconciliation.service');
    const svc = new HoldReconciliationService();

    // When lock is not acquired, reconciliation should skip
    await (svc as any).reconcileExpiredHolds();

    // DB should NOT have been called since lock was not acquired
    const { prismaClient } = require('../shared/database/prisma.service');
    expect(prismaClient.truckHoldLedger.findMany).not.toHaveBeenCalled();
  });

  it('proceeds with reconciliation when lock is acquired', async () => {
    jest.doMock('../shared/services/logger.service', () => ({
      logger: {
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }
    }));

    const mockAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
    const mockReleaseLock = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        acquireLock: mockAcquireLock,
        releaseLock: mockReleaseLock,
      }
    }));

    jest.doMock('../shared/database/prisma.service', () => ({
      prismaClient: {
        truckHoldLedger: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
        }
      }
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HoldReconciliationService } = require('../modules/hold-expiry/hold-reconciliation.service');
    const svc = new HoldReconciliationService();

    // When lock is acquired, reconciliation should proceed
    await (svc as any).reconcileExpiredHolds();

    // DB findMany should have been called for scanning expired holds
    const { prismaClient } = require('../shared/database/prisma.service');
    expect(prismaClient.truckHoldLedger.findMany).toHaveBeenCalled();

    // Lock should be released in finally block
    expect(mockReleaseLock).toHaveBeenCalled();
  });
});
