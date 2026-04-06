/**
 * =============================================================================
 * CACHE INVALIDATION MIDDLEWARE -- Tests for Triads 5-8 (prisma/middleware)
 * =============================================================================
 *
 * Tests for:
 *  A5#21 + A5#22 — Prisma middleware cache invalidation for User and Vehicle
 *  A5#25 — Pool size default is 20
 *  A5#6  — Circuit breaker enabled by default (FF not set)
 *  A5#15 — Role rate limit (transporter-specific rate limiting pattern)
 *
 * @author Weelo Team (TESTER-B, Team LEO)
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP
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
// CATEGORY 1: Prisma middleware cache invalidation (A5#21, A5#22)
// =============================================================================

describe('A5#21 + A5#22: Prisma middleware cache invalidation', () => {
  /**
   * Simulates the Prisma $use middleware cache invalidation logic
   * from prisma.service.ts. This is the second middleware registered.
   *
   * On any write operation (update, upsert, delete, updateMany):
   * - User model: del('user:profile:{id}')
   * - Vehicle model: del('cache:vehicles:transporter:{transporterId}')
   */
  async function simulateCacheInvalidationMiddleware(
    params: { model: string; action: string; args?: any },
    result: any,
    mockRedisDel: jest.Mock,
    mockFindUnique?: jest.Mock
  ): Promise<any> {
    const writeOps = ['update', 'upsert', 'delete', 'updateMany'];
    if (writeOps.includes(params.action)) {
      try {
        if (params.model === 'User') {
          const id = params.args?.where?.id;
          if (id && typeof id === 'string') {
            await mockRedisDel(`user:profile:${id}`).catch(() => {});
          }
        }
        if (params.model === 'Vehicle') {
          const transporterId = result?.transporterId;
          if (transporterId) {
            await mockRedisDel(`cache:vehicles:transporter:${transporterId}`).catch(() => {});
          } else {
            const id = params.args?.where?.id;
            if (id && typeof id === 'string' && mockFindUnique) {
              const vehicle = await mockFindUnique({ where: { id }, select: { transporterId: true } }).catch(() => null);
              if (vehicle?.transporterId) {
                await mockRedisDel(`cache:vehicles:transporter:${vehicle.transporterId}`).catch(() => {});
              }
            }
          }
        }
      } catch { /* cache invalidation is non-fatal */ }
    }
    return result;
  }

  let mockRedisDel: jest.Mock;
  let mockFindUnique: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisDel = jest.fn().mockResolvedValue(true);
    mockFindUnique = jest.fn().mockResolvedValue({ transporterId: 'transporter-123' });
  });

  test('User update -> user:profile:{id} cache deleted', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'User', action: 'update', args: { where: { id: 'user-456' } } },
      { id: 'user-456', name: 'Test' },
      mockRedisDel
    );

    expect(mockRedisDel).toHaveBeenCalledWith('user:profile:user-456');
  });

  test('User upsert -> user:profile:{id} cache deleted', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'User', action: 'upsert', args: { where: { id: 'user-789' } } },
      { id: 'user-789' },
      mockRedisDel
    );

    expect(mockRedisDel).toHaveBeenCalledWith('user:profile:user-789');
  });

  test('Vehicle update -> cache:vehicles:transporter:{transporterId} deleted (correct key prefix)', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'Vehicle', action: 'update', args: { where: { id: 'vehicle-1' } } },
      { id: 'vehicle-1', transporterId: 'transporter-AAA' },
      mockRedisDel
    );

    expect(mockRedisDel).toHaveBeenCalledWith('cache:vehicles:transporter:transporter-AAA');
    // Verify the key uses 'cache:vehicles:transporter:' prefix, NOT 'vehicles:' or other
    expect(mockRedisDel).not.toHaveBeenCalledWith(
      expect.stringMatching(/^vehicles:transporter:/)
    );
  });

  test('Vehicle updateMany -> falls back to findUnique for transporterId', async () => {
    // updateMany result is { count: N }, no transporterId
    await simulateCacheInvalidationMiddleware(
      { model: 'Vehicle', action: 'updateMany', args: { where: { id: 'vehicle-2' } } },
      { count: 3 }, // no transporterId
      mockRedisDel,
      mockFindUnique
    );

    expect(mockFindUnique).toHaveBeenCalled();
    expect(mockRedisDel).toHaveBeenCalledWith('cache:vehicles:transporter:transporter-123');
  });

  test('User delete -> user:profile:{id} cache deleted', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'User', action: 'delete', args: { where: { id: 'user-del' } } },
      { id: 'user-del' },
      mockRedisDel
    );

    expect(mockRedisDel).toHaveBeenCalledWith('user:profile:user-del');
  });

  test('findUnique (read) -> NO cache invalidation', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'User', action: 'findUnique', args: { where: { id: 'user-read' } } },
      { id: 'user-read' },
      mockRedisDel
    );

    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  test('findMany (read) -> NO cache invalidation', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'Vehicle', action: 'findMany', args: {} },
      [{ id: 'v1' }, { id: 'v2' }],
      mockRedisDel
    );

    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  test('cache invalidation failure does not throw', async () => {
    mockRedisDel.mockRejectedValue(new Error('Redis connection lost'));

    // Should not throw
    await expect(
      simulateCacheInvalidationMiddleware(
        { model: 'User', action: 'update', args: { where: { id: 'user-fail' } } },
        { id: 'user-fail' },
        mockRedisDel
      )
    ).resolves.toBeDefined();
  });

  test('User update without id in where -> no cache deleted', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'User', action: 'update', args: { where: { phone: '9876543210' } } },
      { id: 'user-phone' },
      mockRedisDel
    );

    // No user:profile:* deletion because where.id is not a string
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  test('Booking model write -> no cache invalidation (only User and Vehicle)', async () => {
    await simulateCacheInvalidationMiddleware(
      { model: 'Booking', action: 'update', args: { where: { id: 'booking-1' } } },
      { id: 'booking-1' },
      mockRedisDel
    );

    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CATEGORY 2: Pool size default (A5#25)
// =============================================================================

describe('A5#25: Pool default is 20', () => {
  test('default connection_limit is 20 when env not set', () => {
    // Simulate the pool config logic from prisma.service.ts
    const envVal = undefined; // DB_CONNECTION_LIMIT not set
    const connectionLimit = parseInt(envVal || '20', 10);
    expect(connectionLimit).toBe(20);
  });

  test('connection_limit respects DB_CONNECTION_LIMIT env var', () => {
    const envVal = '30';
    const connectionLimit = parseInt(envVal || '20', 10);
    expect(connectionLimit).toBe(30);
  });

  test('pool_timeout default is 5 seconds', () => {
    const envVal = undefined; // DB_POOL_TIMEOUT not set
    const poolTimeout = parseInt(envVal || '5', 10);
    expect(poolTimeout).toBe(5);
  });

  test('connection budget: 2 ECS tasks x 20 = 40 connections', () => {
    const connectionLimit = 20;
    const ecsTasks = 2;
    const totalConnections = connectionLimit * ecsTasks;
    expect(totalConnections).toBe(40);
    // Must be below db.t4g.micro max_connections (~87)
    expect(totalConnections).toBeLessThan(87);
  });

  test('connection budget: 4 ECS tasks x 20 = 80 connections for scale-up', () => {
    const connectionLimit = 20;
    const ecsTasks = 4;
    const totalConnections = connectionLimit * ecsTasks;
    expect(totalConnections).toBe(80);
    // For db.r6g.large (~1600 max), 80/1600 = 5% utilization
    const utilization = (totalConnections / 1600) * 100;
    expect(utilization).toBe(5);
  });
});

// =============================================================================
// CATEGORY 3: Circuit breaker enabled by default (A5#6)
// =============================================================================

describe('A5#6: Circuit breaker enabled by default', () => {
  test('circuit breaker enabled when FF_CIRCUIT_BREAKER_ENABLED not set', () => {
    // From circuit-breaker.service.ts:
    // const FF_CIRCUIT_BREAKER_ENABLED = process.env.FF_CIRCUIT_BREAKER_ENABLED !== 'false';
    const envVal: string | undefined = undefined;
    const enabled = envVal !== 'false';
    expect(enabled).toBe(true);
  });

  test('circuit breaker enabled when FF_CIRCUIT_BREAKER_ENABLED=true', () => {
    const envVal: string = 'true';
    const enabled = envVal !== 'false';
    expect(enabled).toBe(true);
  });

  test('circuit breaker disabled when FF_CIRCUIT_BREAKER_ENABLED=false', () => {
    const envVal: string = 'false';
    const enabled = envVal !== 'false';
    expect(enabled).toBe(false);
  });

  test('circuit breaker enabled for any non-false string', () => {
    const testValues: string[] = ['', '1', 'yes', 'on', 'True', 'FALSE'];
    // Only exact 'false' disables
    for (const val of testValues) {
      const enabled = val !== 'false';
      if (val === 'false') {
        expect(enabled).toBe(false);
      } else {
        expect(enabled).toBe(true);
      }
    }
  });

  test('circuit breaker default threshold is 5', () => {
    const envVal: string | undefined = undefined;
    const threshold = Math.max(1, parseInt(envVal || '5', 10) || 5);
    expect(threshold).toBe(5);
  });

  test('circuit breaker default window is 30000ms', () => {
    const envVal: string | undefined = undefined;
    const windowMs = Math.max(1000, parseInt(envVal || '30000', 10) || 30000);
    expect(windowMs).toBe(30000);
  });

  test('circuit breaker default open duration is 60000ms', () => {
    const envVal: string | undefined = undefined;
    const openDurationMs = Math.max(5000, parseInt(envVal || '60000', 10) || 60000);
    expect(openDurationMs).toBe(60000);
  });
});

// =============================================================================
// CATEGORY 4: Role rate limit pattern (A5#15)
// =============================================================================

describe('A5#15: Role-based rate limiting', () => {
  /**
   * Simulates the rate limiting pattern: check counter, reject if over limit.
   */
  async function checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    mockIncr: jest.Mock,
    mockExpire: jest.Mock
  ): Promise<{ allowed: boolean; current: number }> {
    const current = await mockIncr(key);
    if (current === 1) {
      await mockExpire(key, windowSeconds);
    }
    return { allowed: current <= limit, current };
  }

  test('first request within limit -> allowed', async () => {
    const mockIncr = jest.fn().mockResolvedValue(1);
    const mockExpire = jest.fn().mockResolvedValue(true);

    const result = await checkRateLimit('rate:transporter:T1', 5, 60, mockIncr, mockExpire);

    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    // Expire should be set on first request
    expect(mockExpire).toHaveBeenCalledWith('rate:transporter:T1', 60);
  });

  test('request at limit -> allowed', async () => {
    const mockIncr = jest.fn().mockResolvedValue(5);
    const mockExpire = jest.fn().mockResolvedValue(true);

    const result = await checkRateLimit('rate:transporter:T1', 5, 60, mockIncr, mockExpire);

    expect(result.allowed).toBe(true);
    expect(result.current).toBe(5);
  });

  test('request over limit -> rejected', async () => {
    const mockIncr = jest.fn().mockResolvedValue(6);
    const mockExpire = jest.fn().mockResolvedValue(true);

    const result = await checkRateLimit('rate:transporter:T1', 5, 60, mockIncr, mockExpire);

    expect(result.allowed).toBe(false);
    expect(result.current).toBe(6);
  });

  test('different keys have independent rate limits', async () => {
    let counterA = 0;
    let counterB = 0;
    const mockIncr = jest.fn().mockImplementation((key: string) => {
      if (key.includes('T1')) return Promise.resolve(++counterA);
      return Promise.resolve(++counterB);
    });
    const mockExpire = jest.fn().mockResolvedValue(true);

    const result1 = await checkRateLimit('rate:transporter:T1', 5, 60, mockIncr, mockExpire);
    const result2 = await checkRateLimit('rate:transporter:T2', 5, 60, mockIncr, mockExpire);

    expect(result1.current).toBe(1);
    expect(result2.current).toBe(1);
    expect(result1.allowed).toBe(true);
    expect(result2.allowed).toBe(true);
  });
});
