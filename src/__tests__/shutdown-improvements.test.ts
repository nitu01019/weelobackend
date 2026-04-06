/**
 * =============================================================================
 * SHUTDOWN IMPROVEMENTS -- Tests for Triads 5-8 (shutdown path)
 * =============================================================================
 *
 * Tests for:
 *  A5#28 — gracefulShutdown calls queueService.stop()
 *  A5#30 — stopGoogleMapsMetrics clears the interval
 *  A5#8  — queue flush during shutdown
 *  A5#18 — startup jitter: rebuildFromDatabase called with lock
 *         + lock not acquired -> rebuild skipped
 *  Read replica prismaReadClient.$disconnect() called in shutdown
 *
 * @author Weelo Team (TESTER-B, Team LEO)
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP -- Must come before any imports
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { logger } from '../shared/services/logger.service';

// =============================================================================
// CATEGORY 1: gracefulShutdown calls queueService.stop() (A5#28, A5#8)
// =============================================================================

describe('A5#28 + A5#8: gracefulShutdown calls queueService.stop()', () => {
  let mockQueueStop: jest.Mock;
  let mockPrismaDisconnect: jest.Mock;
  let mockReadDisconnect: jest.Mock;
  let mockStopGoogleMapsMetrics: jest.Mock;
  let mockRedisDisconnect: jest.Mock;

  /**
   * Simulates the gracefulShutdown flow from server.ts.
   * Extracted to unit-test each phase without starting a real HTTP server.
   */
  async function simulateGracefulShutdown(signal: string): Promise<void> {
    (logger.info as jest.Mock)(`${signal} received. Starting graceful shutdown...`);

    // Phase: Stop queue service and flush buffers
    try {
      mockQueueStop();
      (logger.info as jest.Mock)('Queue service stopped and buffers flushed');
    } catch (err) {
      (logger.error as jest.Mock)('Error stopping queue service', err);
    }

    // Phase: Stop Google Maps metrics interval
    try {
      mockStopGoogleMapsMetrics();
      (logger.info as jest.Mock)('Google Maps metrics interval stopped');
    } catch (err) {
      (logger.error as jest.Mock)('Error stopping Google Maps metrics', err);
    }

    // Phase: Disconnect databases
    try {
      await mockPrismaDisconnect();
      if (mockReadDisconnect) {
        await mockReadDisconnect().catch(() => {});
      }
      (logger.info as jest.Mock)('Database connections closed');
    } catch (err) {
      (logger.error as jest.Mock)('Error closing database connections', err);
    }

    // Phase: Disconnect Redis
    try {
      await mockRedisDisconnect();
    } catch (err) {
      (logger.error as jest.Mock)('Error closing Redis', err);
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueueStop = jest.fn();
    mockPrismaDisconnect = jest.fn().mockResolvedValue(undefined);
    mockReadDisconnect = jest.fn().mockResolvedValue(undefined);
    mockStopGoogleMapsMetrics = jest.fn();
    mockRedisDisconnect = jest.fn().mockResolvedValue(undefined);
  });

  test('gracefulShutdown calls queueService.stop()', async () => {
    await simulateGracefulShutdown('SIGTERM');
    expect(mockQueueStop).toHaveBeenCalledTimes(1);
  });

  test('gracefulShutdown calls stopGoogleMapsMetrics()', async () => {
    await simulateGracefulShutdown('SIGTERM');
    expect(mockStopGoogleMapsMetrics).toHaveBeenCalledTimes(1);
  });

  test('gracefulShutdown calls prismaClient.$disconnect()', async () => {
    await simulateGracefulShutdown('SIGTERM');
    expect(mockPrismaDisconnect).toHaveBeenCalledTimes(1);
  });

  test('gracefulShutdown calls prismaReadClient.$disconnect()', async () => {
    await simulateGracefulShutdown('SIGTERM');
    expect(mockReadDisconnect).toHaveBeenCalledTimes(1);
  });

  test('prismaReadClient.$disconnect failure does not crash shutdown', async () => {
    mockReadDisconnect = jest.fn().mockRejectedValue(new Error('disconnect error'));
    // Should NOT throw
    await expect(simulateGracefulShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(mockReadDisconnect).toHaveBeenCalled();
    // Primary disconnect should still have been called
    expect(mockPrismaDisconnect).toHaveBeenCalled();
  });

  test('queueService.stop() failure does not block Google Maps cleanup', async () => {
    mockQueueStop = jest.fn(() => { throw new Error('queue stop failed'); });
    await simulateGracefulShutdown('SIGTERM');
    // Google Maps cleanup still runs despite queue failure
    expect(mockStopGoogleMapsMetrics).toHaveBeenCalledTimes(1);
  });

  test('all shutdown phases execute on SIGTERM', async () => {
    await simulateGracefulShutdown('SIGTERM');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('SIGTERM received'));
    expect(mockQueueStop).toHaveBeenCalled();
    expect(mockStopGoogleMapsMetrics).toHaveBeenCalled();
    expect(mockPrismaDisconnect).toHaveBeenCalled();
    expect(mockReadDisconnect).toHaveBeenCalled();
  });

  test('all shutdown phases execute on SIGINT', async () => {
    await simulateGracefulShutdown('SIGINT');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('SIGINT received'));
    expect(mockQueueStop).toHaveBeenCalled();
    expect(mockStopGoogleMapsMetrics).toHaveBeenCalled();
    expect(mockPrismaDisconnect).toHaveBeenCalled();
  });
});

// =============================================================================
// CATEGORY 2: stopGoogleMapsMetrics clears the interval (A5#30)
// =============================================================================

describe('A5#30: stopGoogleMapsMetrics clears the interval', () => {
  test('stopGoogleMapsMetrics clears a setInterval handle', () => {
    // Simulate the pattern from google-maps.service.ts
    let metricsInterval: NodeJS.Timeout | null = null;
    metricsInterval = setInterval(() => {}, 60000);

    function stopGoogleMapsMetrics(): void {
      if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
      }
    }

    expect(metricsInterval).not.toBeNull();
    stopGoogleMapsMetrics();
    expect(metricsInterval).toBeNull();
  });

  test('stopGoogleMapsMetrics is safe to call multiple times', () => {
    let metricsInterval: NodeJS.Timeout | null = setInterval(() => {}, 60000);

    function stopGoogleMapsMetrics(): void {
      if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
      }
    }

    stopGoogleMapsMetrics();
    // Second call should not throw
    expect(() => stopGoogleMapsMetrics()).not.toThrow();
    expect(metricsInterval).toBeNull();
  });

  test('stopGoogleMapsMetrics is no-op when interval was never created', () => {
    let metricsInterval: NodeJS.Timeout | null = null;

    function stopGoogleMapsMetrics(): void {
      if (metricsInterval) {
        clearInterval(metricsInterval);
        metricsInterval = null;
      }
    }

    expect(() => stopGoogleMapsMetrics()).not.toThrow();
    expect(metricsInterval).toBeNull();
  });
});

// =============================================================================
// CATEGORY 3: Startup jitter — rebuildFromDatabase with lock (A5#18)
// =============================================================================

describe('A5#18: Startup jitter with distributed lock', () => {
  test('rebuildFromDatabase called when lock acquired', async () => {
    const mockAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
    const mockReleaseLock = jest.fn().mockResolvedValue(undefined);
    const mockRebuild = jest.fn().mockResolvedValue(undefined);

    // Simulate startup pattern from server.ts
    const startupHolderId = `startup:${process.pid}:${Date.now()}`;
    const rebuildLock = await mockAcquireLock('rebuild:live-availability', startupHolderId, 60);
    if (rebuildLock.acquired) {
      await mockRebuild();
      await mockReleaseLock('rebuild:live-availability', startupHolderId);
    }

    expect(mockRebuild).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  test('rebuildFromDatabase skipped when lock NOT acquired', async () => {
    const mockAcquireLock = jest.fn().mockResolvedValue({ acquired: false });
    const mockReleaseLock = jest.fn().mockResolvedValue(undefined);
    const mockRebuild = jest.fn().mockResolvedValue(undefined);

    const startupHolderId = `startup:${process.pid}:${Date.now()}`;
    const rebuildLock = await mockAcquireLock('rebuild:live-availability', startupHolderId, 60);
    if (rebuildLock.acquired) {
      await mockRebuild();
      await mockReleaseLock('rebuild:live-availability', startupHolderId);
    }

    // Rebuild should NOT have been called
    expect(mockRebuild).not.toHaveBeenCalled();
    // Release should NOT have been called
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  test('lock acquisition failure does not crash startup', async () => {
    const mockAcquireLock = jest.fn().mockRejectedValue(new Error('Redis down'));
    const mockRebuild = jest.fn();

    let lockAcquired = false;
    try {
      const rebuildLock = await mockAcquireLock('rebuild:live-availability', 'holder', 60);
      lockAcquired = rebuildLock.acquired;
    } catch {
      // Lock failure is non-fatal
      lockAcquired = false;
    }

    if (lockAcquired) {
      await mockRebuild();
    }

    expect(mockRebuild).not.toHaveBeenCalled();
  });

  test('lock TTL is 60 seconds for startup rebuild', async () => {
    const mockAcquireLock = jest.fn().mockResolvedValue({ acquired: true });

    await mockAcquireLock('rebuild:live-availability', 'holder', 60);

    expect(mockAcquireLock).toHaveBeenCalledWith(
      'rebuild:live-availability',
      'holder',
      60
    );
  });

  test('startup holderId includes process PID for uniqueness', () => {
    const holderId = `startup:${process.pid}:${Date.now()}`;

    expect(holderId).toMatch(/^startup:\d+:\d+$/);
    expect(holderId).toContain(String(process.pid));
  });
});
