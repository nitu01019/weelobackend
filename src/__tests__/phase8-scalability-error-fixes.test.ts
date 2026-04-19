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
