/**
 * PHASE 8 — SCALABILITY & ERROR FORMAT FIXES
 * Tests: C-6, C-7, C-8, H-5, H-16, H-17
 */

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    exists: jest.fn().mockResolvedValue(false),
    incr: jest.fn().mockResolvedValue(1),
    incrBy: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(true),
    del: jest.fn().mockResolvedValue(1),
    sAdd: jest.fn().mockResolvedValue(1),
    sRem: jest.fn().mockResolvedValue(1),
    getClient: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    assignment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    order: { findMany: jest.fn().mockResolvedValue([]) },
    rating: { aggregate: jest.fn().mockResolvedValue({ _avg: { stars: 0 }, _count: { stars: 0 } }) },
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: false },
    isProduction: false,
    isDevelopment: true,
    jwt: { secret: 'test-secret' },
  },
}));

jest.mock('../shared/services/fleet-cache.service', () => ({
  fleetCacheService: { invalidateDriverCache: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../shared/services/socket.service', () => ({
  socketService: { emitToUser: jest.fn() },
}));

jest.mock('../shared/database/db', () => ({
  db: {
    getBookingsByDriver: jest.fn().mockResolvedValue([]),
    getDriversByTransporter: jest.fn().mockResolvedValue([]),
    getVehiclesByTransporter: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: { incrementCounter: jest.fn(), observeHistogram: jest.fn() },
}));

import { prismaClient } from '../shared/database/prisma.service';

describe('C-6: Socket DB semaphore (withSocketDbLimit)', () => {
  test('semaphore constant defaults to 10 from env', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../shared/services/socket.service'),
      'utf-8'
    );
    expect(source).toContain("SOCKET_DB_CONCURRENCY || '10'");
    expect(source).toContain('activeSocketDbOps >= MAX_CONCURRENT_SOCKET_DB');
  });

  test('semaphore queues operations when at capacity', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../shared/services/socket.service'),
      'utf-8'
    );
    expect(source).toContain('socketDbQueue.push(resolve)');
    expect(source).toContain('socketDbQueue.shift()?.()');
  });

  test('semaphore decrements activeSocketDbOps in finally block', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../shared/services/socket.service'),
      'utf-8'
    );
    expect(source).toContain('activeSocketDbOps--');
    expect(source).toMatch(/finally\s*\{[^}]*activeSocketDbOps--/s);
  });
});

describe('C-7: Driver earnings query bounded', () => {
  test('getEarnings passes date filter and take:1000 to Prisma', async () => {
    const { driverService } = require('../modules/driver/driver.service');
    const mockFindMany = prismaClient.assignment.findMany as jest.Mock;
    mockFindMany.mockResolvedValue([]);

    await driverService.getEarnings('driver-1', 'week');

    expect(mockFindMany).toHaveBeenCalled();
    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.where).toHaveProperty('completedAt');
    expect(callArgs.where.completedAt).toHaveProperty('gte');
    expect(callArgs.take).toBe(1000);
  });

  test('getEarnings orders by completedAt desc', async () => {
    const { driverService } = require('../modules/driver/driver.service');
    const mockFindMany = prismaClient.assignment.findMany as jest.Mock;
    mockFindMany.mockResolvedValue([]);

    await driverService.getEarnings('driver-2', 'month');

    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.orderBy).toEqual({ completedAt: 'desc' });
  });
});

describe('C-8: calculateOnTimeRate bounded', () => {
  test('query uses 90-day window and take:500', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/driver/driver-performance.service'),
      'utf-8'
    );
    expect(source).toContain('windowStart.setDate(windowStart.getDate() - 90)');
    expect(source).toMatch(/take:\s*500/);
  });

  test('returns default 100% rate when no completed assignments', async () => {
    const { driverPerformanceService } = require('../modules/driver/driver-performance.service');
    const mockFindMany = prismaClient.assignment.findMany as jest.Mock;
    mockFindMany.mockResolvedValue([]);
    const mockCount = prismaClient.assignment.count as jest.Mock;
    mockCount.mockResolvedValue(0);

    const result = await driverPerformanceService.getPerformance('driver-empty');
    expect(result.onTimeDeliveryRate).toBe(100);
  });
});

describe('H-5: Global WebSocket connection cap', () => {
  test('connection cap middleware is registered before auth', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../shared/services/socket.service'),
      'utf-8'
    );
    const capIndex = source.indexOf('MAX_GLOBAL_CONNECTIONS');
    const authIndex = source.indexOf('Authentication middleware');
    expect(capIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(-1);
    expect(capIndex).toBeLessThan(authIndex);
  });

  test('cap defaults to 10000 and rejects with correct error', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../shared/services/socket.service'),
      'utf-8'
    );
    expect(source).toContain("SOCKET_MAX_GLOBAL_CONNECTIONS || '10000'");
    expect(source).toContain('Server at capacity. Please retry.');
  });

  test('cap checks clientsCount against MAX_GLOBAL_CONNECTIONS', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../shared/services/socket.service'),
      'utf-8'
    );
    expect(source).toContain('io!.engine.clientsCount');
    expect(source).toContain('currentCount >= MAX_GLOBAL_CONNECTIONS');
  });
});

describe('H-16: Accept/decline error codes in truck-hold routes', () => {
  test('accept route returns error.code on failure', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.routes'),
      'utf-8'
    );
    const acceptSection = source.slice(
      source.indexOf("'/driver/:assignmentId/accept'"),
      source.indexOf("'/driver/:assignmentId/decline'")
    );
    expect(acceptSection).toContain("code: result.errorCode || 'DRIVER_ACTION_FAILED'");
    expect(acceptSection).toContain('message: result.message');
  });

  test('decline route returns error.code on failure', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.routes'),
      'utf-8'
    );
    const declineStart = source.indexOf("'/driver/:assignmentId/decline'");
    const declineSection = source.slice(
      declineStart,
      source.indexOf('Smart Order Timeout', declineStart)
    );
    expect(declineSection).toContain("code: result.errorCode || 'DRIVER_ACTION_FAILED'");
    expect(declineSection).toContain('message: result.message');
  });

  test('both accept and decline wrap error in {code, message} object', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.routes'),
      'utf-8'
    );
    const errorBlocks = source.match(/error:\s*\{\s*\n?\s*code:\s*result\.errorCode/g);
    expect(errorBlocks).not.toBeNull();
    expect(errorBlocks!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('H-17: Assignment route structured errors', () => {
  test('assignment status 404 uses { code, message } format', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/assignment/assignment.routes'),
      'utf-8'
    );
    expect(source).toContain("code: 'ASSIGNMENT_NOT_FOUND'");
    expect(source).toContain("message: 'Assignment not found'");
  });

  test('assignment 403 responses use { code, message } format', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/assignment/assignment.routes'),
      'utf-8'
    );
    expect(source).toContain("code: 'FORBIDDEN'");
    const forbiddenMatches = source.match(/error:\s*\{\s*code:\s*'FORBIDDEN'/g);
    expect(forbiddenMatches).not.toBeNull();
    expect(forbiddenMatches!.length).toBeGreaterThanOrEqual(3);
  });

  test('transporter-override 404 uses structured error', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/assignment/assignment.routes'),
      'utf-8'
    );
    const overrideSection = source.slice(
      source.indexOf('transporter-override'),
      source.indexOf("DELETE /assignments/:id") > 0
        ? source.indexOf("DELETE /assignments/:id")
        : undefined
    );
    expect(overrideSection).toContain("code: 'ASSIGNMENT_NOT_FOUND'");
    expect(overrideSection).toContain("code: 'FORBIDDEN'");
  });
});

// ===========================================================================
// P4 F2.7 — X-Idempotency-Key replay on /confirmed-hold/initialize
// Source-level contract: idempotency must read from Redis BEFORE invoking the
// service, and must cache the response body AFTER a success. A duplicate
// request (same key) short-circuits to the cached body with cached status.
// ===========================================================================
describe('P4 F2.7: /confirmed-hold/initialize idempotency-key replay', () => {
  test('route reads cache BEFORE calling initializeConfirmedHold', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.routes'),
      'utf-8'
    );
    // Locate the /confirmed-hold/initialize handler block
    const start = source.indexOf("'/confirmed-hold/initialize'");
    const end = source.indexOf("'/confirmed-hold/:holdId'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const section = source.slice(start, end);

    // Idempotency lookup must happen BEFORE the service call
    const lookupPos = section.indexOf('redisService.getJSON');
    const servicePos = section.indexOf('confirmedHoldService.initializeConfirmedHold');
    expect(lookupPos).toBeGreaterThan(-1);
    expect(servicePos).toBeGreaterThan(-1);
    expect(lookupPos).toBeLessThan(servicePos);
  });

  test('route caches successful response AFTER initializeConfirmedHold returns', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('../modules/truck-hold/truck-hold.routes'),
      'utf-8'
    );
    const start = source.indexOf("'/confirmed-hold/initialize'");
    const end = source.indexOf("'/confirmed-hold/:holdId'", start);
    const section = source.slice(start, end);

    // Cache write after service returns success; must use 200 status and the
    // full response body so the replay is byte-identical.
    expect(section).toContain('redisService.setJSON(idempotencyCacheKey, { status: 200, body: responseBody }');
    // Cache key must be scoped by (transporterId, holdId, idempotencyKey) so
    // two different captains or two different holds can't collide.
    expect(section).toContain('`idempotency:truck-hold:confirmed-hold:initialize:${transporterId}:${holdId}:${idempotencyKey}`');
  });

  test('behavioral: duplicate X-Idempotency-Key returns cached body without re-invoking service', async () => {
    // Isolate module cache so our mocks apply to this test only
    jest.resetModules();

    // Redis mock — getJSON returns null on first call, cached body on second
    const mockGetJSON = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 200,
        body: {
          success: true,
          data: { confirmedExpiresAt: '2026-01-01T00:00:00.000Z' },
          message: 'Confirmed hold initialized',
        },
      });
    const mockSetJSON = jest.fn().mockResolvedValue('OK');
    jest.doMock('../shared/services/redis.service', () => ({
      redisService: {
        getJSON: mockGetJSON,
        setJSON: mockSetJSON,
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      },
    }));

    // Service mock — would throw if called on replay; first call returns success
    const mockInitialize = jest.fn().mockResolvedValueOnce({
      success: true,
      confirmedExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      message: 'Confirmed hold initialized',
    });
    jest.doMock('../modules/truck-hold/confirmed-hold.service', () => ({
      confirmedHoldService: { initializeConfirmedHold: mockInitialize },
    }));

    // Middleware stubs — skip auth + role gate so we can hit the handler
    jest.doMock('../shared/middleware/auth.middleware', () => ({
      authMiddleware: (req: any, _res: any, next: any) => {
        req.user = { userId: 'transporter-X', role: 'transporter' };
        next();
      },
      roleGuard: () => (_req: any, _res: any, next: any) => next(),
    }));

    // Logger noise-kill
    jest.doMock('../shared/services/logger.service', () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { truckHoldRouter } = require('../modules/truck-hold/truck-hold.routes');

    // Locate the handler for POST /confirmed-hold/initialize
    const layer = truckHoldRouter.stack.find(
      (l: any) => l.route?.path === '/confirmed-hold/initialize' && l.route?.methods?.post
    );
    expect(layer).toBeDefined();
    // Business handler is the LAST entry in route.stack (middleware come before it)
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    async function invoke() {
      const req: any = {
        body: { holdId: 'hold-X', assignments: [{ assignmentId: 'a-1', driverId: 'd-1', truckRequestId: 'tr-1' }] },
        header: (name: string) => (name.toLowerCase() === 'x-idempotency-key' ? 'replay-key-42' : undefined),
        user: { userId: 'transporter-X', role: 'transporter' },
      };
      let statusCode: number | null = null;
      let body: any = null;
      const res: any = {
        status(code: number) { statusCode = code; return this; },
        json(payload: any) { body = payload; return this; },
      };
      await handler(req, res, () => {});
      return { statusCode, body };
    }

    // 1st call: cache miss → service invoked → body cached
    const first = await invoke();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockSetJSON).toHaveBeenCalledTimes(1);
    expect(first.body.success).toBe(true);

    // 2nd call: cache hit → service NOT invoked → cached body returned
    const second = await invoke();
    expect(mockInitialize).toHaveBeenCalledTimes(1); // still 1 — service short-circuited
    expect(second.body).toEqual({
      success: true,
      data: { confirmedExpiresAt: '2026-01-01T00:00:00.000Z' },
      message: 'Confirmed hold initialized',
    });
    expect(second.statusCode).toBe(200);
  });
});
