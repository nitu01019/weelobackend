/**
 * =============================================================================
 * INFRASTRUCTURE FIXES - Comprehensive Test Suite
 * =============================================================================
 *
 * Tests for 3 infrastructure fixes:
 *   H14: Socket.IO initialized after Redis is ready
 *   H15: FCM token stored in PostgreSQL as fallback
 *   M4:  Driver logout endpoint exists
 *
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// H14: Socket.IO initialized AFTER Redis is ready
// =============================================================================
// These tests verify the code structure of server.ts to ensure initializeSocket
// is called inside bootstrap() after redisService.initialize(), and NOT at
// module level where Redis may not be connected yet.
// =============================================================================

describe('H14: Socket.IO initialized after Redis is ready', () => {
  let serverSource: string;

  beforeAll(() => {
    serverSource = fs.readFileSync(
      path.resolve(__dirname, '../server.ts'),
      'utf-8'
    );
  });

  it('initializeSocket is NOT called at module level (before bootstrap)', () => {
    // Split source at the bootstrap function declaration.
    // Everything before "async function bootstrap()" is module-level code.
    const bootstrapIdx = serverSource.indexOf('async function bootstrap()');
    expect(bootstrapIdx).toBeGreaterThan(0);

    const moduleLevelCode = serverSource.substring(0, bootstrapIdx);

    // initializeSocket should NOT be invoked at module level.
    // Import statements (import { initializeSocket ... }) are fine; calls are not.
    // A call looks like: initializeSocket(server) or initializeSocket(...)
    const callPattern = /initializeSocket\s*\(/g;
    const importPattern = /import\s+\{[^}]*initializeSocket[^}]*\}/g;

    // Remove imports so we only check for actual invocations
    const withoutImports = moduleLevelCode.replace(importPattern, '');

    expect(withoutImports).not.toMatch(callPattern);
  });

  it('initializeSocket IS called inside bootstrap()', () => {
    const bootstrapIdx = serverSource.indexOf('async function bootstrap()');
    const bootstrapBody = serverSource.substring(bootstrapIdx);

    expect(bootstrapBody).toMatch(/initializeSocket\s*\(\s*server\s*\)/);
  });

  it('redisService.initialize() is called BEFORE initializeSocket in bootstrap', () => {
    const bootstrapIdx = serverSource.indexOf('async function bootstrap()');
    const bootstrapBody = serverSource.substring(bootstrapIdx);

    const redisInitIdx = bootstrapBody.indexOf('await redisService.initialize()');
    const socketInitIdx = bootstrapBody.indexOf('initializeSocket(server)');

    expect(redisInitIdx).toBeGreaterThan(-1);
    expect(socketInitIdx).toBeGreaterThan(-1);
    expect(redisInitIdx).toBeLessThan(socketInitIdx);
  });

  it('server.ts contains the H14 fix comment marker', () => {
    expect(serverSource).toContain('Fix H14');
  });

  it('initializeSocket is imported from socket.service', () => {
    expect(serverSource).toMatch(
      /import\s+\{[^}]*initializeSocket[^}]*\}\s+from\s+['"]\.\/shared\/services\/socket\.service['"]/
    );
  });

  it('redisService.initialize() is inside a try/catch in bootstrap', () => {
    const bootstrapIdx = serverSource.indexOf('async function bootstrap()');
    const bootstrapBody = serverSource.substring(bootstrapIdx);

    // The redis initialization should be wrapped in try/catch for resilience
    const tryIdx = bootstrapBody.indexOf('try {');
    const redisInitIdx = bootstrapBody.indexOf('await redisService.initialize()');

    expect(tryIdx).toBeGreaterThan(-1);
    expect(redisInitIdx).toBeGreaterThan(tryIdx);
  });
});

// =============================================================================
// H15: FCM token stored in PostgreSQL as fallback
// =============================================================================
// Tests that registerToken upserts to DeviceToken table and getTokens falls
// back to DB when Redis is empty or unavailable.
// =============================================================================

describe('H15: FCM token stored in PostgreSQL as fallback', () => {
  // -------------------------------------------------------------------------
  // Schema verification: DeviceToken model exists in Prisma schema
  // -------------------------------------------------------------------------
  describe('Prisma schema — DeviceToken model', () => {
    let schemaSource: string;

    beforeAll(() => {
      schemaSource = fs.readFileSync(
        path.resolve(__dirname, '../../prisma/schema.prisma'),
        'utf-8'
      );
    });

    it('DeviceToken model exists in schema.prisma', () => {
      expect(schemaSource).toContain('model DeviceToken');
    });

    it('DeviceToken has userId field', () => {
      // Extract the DeviceToken model block
      const modelStart = schemaSource.indexOf('model DeviceToken');
      const modelBlock = schemaSource.substring(modelStart, schemaSource.indexOf('}', modelStart) + 1);
      expect(modelBlock).toContain('userId');
    });

    it('DeviceToken has token field', () => {
      const modelStart = schemaSource.indexOf('model DeviceToken');
      const modelBlock = schemaSource.substring(modelStart, schemaSource.indexOf('}', modelStart) + 1);
      expect(modelBlock).toContain('token');
    });

    it('DeviceToken has platform field with android default', () => {
      const modelStart = schemaSource.indexOf('model DeviceToken');
      const modelBlock = schemaSource.substring(modelStart, schemaSource.indexOf('}', modelStart) + 1);
      expect(modelBlock).toMatch(/platform\s+String\s+@default\("android"\)/);
    });

    it('DeviceToken has lastSeenAt field', () => {
      const modelStart = schemaSource.indexOf('model DeviceToken');
      const modelBlock = schemaSource.substring(modelStart, schemaSource.indexOf('}', modelStart) + 1);
      expect(modelBlock).toContain('lastSeenAt');
    });

    it('DeviceToken has composite unique constraint on [userId, token]', () => {
      const modelStart = schemaSource.indexOf('model DeviceToken');
      const modelBlock = schemaSource.substring(modelStart, schemaSource.indexOf('}', modelStart) + 1);
      expect(modelBlock).toMatch(/@@unique\(\[userId,\s*token\]\)/);
    });

    it('DeviceToken has index on userId', () => {
      const modelStart = schemaSource.indexOf('model DeviceToken');
      const modelBlock = schemaSource.substring(modelStart, schemaSource.indexOf('}', modelStart) + 1);
      expect(modelBlock).toMatch(/@@index\(\[userId\]\)/);
    });
  });

  // -------------------------------------------------------------------------
  // Source code verification: fcm.service.ts DB fallback logic
  // -------------------------------------------------------------------------
  describe('fcm.service.ts — DB fallback implementation', () => {
    let fcmSource: string;

    beforeAll(() => {
      fcmSource = fs.readFileSync(
        path.resolve(__dirname, '../shared/services/fcm.service.ts'),
        'utf-8'
      );
    });

    it('imports prismaClient for DB operations', () => {
      expect(fcmSource).toMatch(/import\s+\{[^}]*prismaClient[^}]*\}\s+from/);
    });

    it('registerToken upserts to DeviceToken table', () => {
      expect(fcmSource).toContain('prismaClient.deviceToken.upsert');
    });

    it('registerToken upsert uses composite key (userId + token)', () => {
      expect(fcmSource).toContain('userId_token');
    });

    it('registerToken updates lastSeenAt on existing token', () => {
      expect(fcmSource).toMatch(/update:\s*\{\s*lastSeenAt/);
    });

    it('getTokens falls back to DB when Redis is empty/unavailable', () => {
      expect(fcmSource).toContain('prismaClient.deviceToken.findMany');
    });

    it('getTokens DB fallback filters by userId', () => {
      // The findMany call should have where: { userId }
      expect(fcmSource).toMatch(/findMany\s*\(\s*\{[^}]*where:\s*\{\s*userId\s*\}/s);
    });

    it('contains H15 fix comment marker', () => {
      expect(fcmSource).toContain('Fix H15');
    });
  });

  // -------------------------------------------------------------------------
  // Behavioral tests: registerToken with mocked Redis and Prisma
  // -------------------------------------------------------------------------
  describe('registerToken — behavioral tests', () => {
    // Keep references for cleanup
    let originalRedisModule: any;
    let originalPrismaModule: any;

    // Mock state
    const mockRedisStore = new Map<string, Set<string>>();
    const mockDbStore: Array<{ userId: string; token: string; platform: string; lastSeenAt: Date }> = [];
    let redisAvailable = true;

    const mockSAdd = jest.fn(async (key: string, value: string) => {
      if (!redisAvailable) throw new Error('Redis connection lost');
      if (!mockRedisStore.has(key)) mockRedisStore.set(key, new Set());
      mockRedisStore.get(key)!.add(value);
      return 1;
    });

    const mockExpire = jest.fn(async () => {
      if (!redisAvailable) throw new Error('Redis connection lost');
      return true;
    });

    const mockSMembers = jest.fn(async (key: string) => {
      if (!redisAvailable) throw new Error('Redis connection lost');
      return Array.from(mockRedisStore.get(key) || []);
    });

    const mockIsRedisEnabled = jest.fn(() => redisAvailable);
    const mockIsConnected = jest.fn(() => redisAvailable);

    const mockUpsert = jest.fn(async ({ create }: any) => {
      const existing = mockDbStore.find(
        (t) => t.userId === create.userId && t.token === create.token
      );
      if (existing) {
        existing.lastSeenAt = new Date();
        return existing;
      }
      const record = { ...create, lastSeenAt: new Date() };
      mockDbStore.push(record);
      return record;
    });

    const mockFindMany = jest.fn(async ({ where }: any) => {
      return mockDbStore
        .filter((t) => t.userId === where.userId)
        .map((t) => ({ token: t.token }));
    });

    beforeAll(() => {
      // Cache original modules
      originalRedisModule = jest.requireActual('../shared/services/redis.service');
      originalPrismaModule = jest.requireActual('../shared/database/prisma.service');
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockRedisStore.clear();
      mockDbStore.length = 0;
      redisAvailable = true;

      // Mock redis.service
      jest.doMock('../shared/services/redis.service', () => ({
        redisService: {
          sAdd: mockSAdd,
          expire: mockExpire,
          sMembers: mockSMembers,
          isRedisEnabled: mockIsRedisEnabled,
          isConnected: mockIsConnected,
          sRem: jest.fn(async () => 1),
          del: jest.fn(async () => 1),
        },
      }));

      // Mock prisma.service
      jest.doMock('../shared/database/prisma.service', () => ({
        prismaClient: {
          deviceToken: {
            upsert: mockUpsert,
            findMany: mockFindMany,
          },
        },
      }));
    });

    afterEach(() => {
      jest.resetModules();
    });

    it('registerToken stores in Redis AND upserts in DB', async () => {
      const { fcmService } = require('../shared/services/fcm.service');
      const result = await fcmService.registerToken('user-1', 'fcm-token-abc');

      expect(result).toBe(true); // Redis succeeded
      expect(mockSAdd).toHaveBeenCalledWith('fcm:tokens:user-1', 'fcm-token-abc');
      expect(mockExpire).toHaveBeenCalled();
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_token: { userId: 'user-1', token: 'fcm-token-abc' } },
          create: expect.objectContaining({ userId: 'user-1', token: 'fcm-token-abc' }),
        })
      );
    });

    it('registerToken with Redis down still saves to DB', async () => {
      redisAvailable = false;

      const { fcmService } = require('../shared/services/fcm.service');
      const result = await fcmService.registerToken('user-2', 'fcm-token-def');

      // Redis failed, so returns false
      expect(result).toBe(false);
      // But DB upsert should still have been called
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_token: { userId: 'user-2', token: 'fcm-token-def' } },
        })
      );
    });

    it('getTokens returns from Redis when available', async () => {
      // Pre-populate Redis
      mockRedisStore.set('fcm:tokens:user-3', new Set(['token-1', 'token-2']));

      const { fcmService } = require('../shared/services/fcm.service');
      const tokens = await fcmService.getTokens('user-3');

      expect(tokens).toEqual(expect.arrayContaining(['token-1', 'token-2']));
      expect(tokens).toHaveLength(2);
      expect(mockSMembers).toHaveBeenCalledWith('fcm:tokens:user-3');
      // DB should NOT be queried when Redis returned tokens
      expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('getTokens falls back to DB when Redis returns empty', async () => {
      // Redis is available but empty; DB has tokens
      mockDbStore.push(
        { userId: 'user-4', token: 'db-token-1', platform: 'android', lastSeenAt: new Date() },
        { userId: 'user-4', token: 'db-token-2', platform: 'android', lastSeenAt: new Date() }
      );

      const { fcmService } = require('../shared/services/fcm.service');
      const tokens = await fcmService.getTokens('user-4');

      expect(tokens).toEqual(expect.arrayContaining(['db-token-1', 'db-token-2']));
      expect(tokens).toHaveLength(2);
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-4' },
        })
      );
    });

    it('getTokens falls back to DB when Redis is unavailable', async () => {
      redisAvailable = false;

      mockDbStore.push(
        { userId: 'user-5', token: 'db-fallback-token', platform: 'android', lastSeenAt: new Date() }
      );

      const { fcmService } = require('../shared/services/fcm.service');
      const tokens = await fcmService.getTokens('user-5');

      expect(tokens).toEqual(['db-fallback-token']);
      expect(mockFindMany).toHaveBeenCalled();
    });

    it('getTokens returns empty array when both Redis and DB have no tokens', async () => {
      const { fcmService } = require('../shared/services/fcm.service');
      const tokens = await fcmService.getTokens('user-nonexistent');

      expect(tokens).toEqual([]);
    });

    it('registerToken DB fallback handles DB errors gracefully', async () => {
      mockUpsert.mockRejectedValueOnce(new Error('DB connection timeout'));

      const { fcmService } = require('../shared/services/fcm.service');
      // Should NOT throw — DB failure is non-fatal
      const result = await fcmService.registerToken('user-6', 'fcm-token-ghi');

      // Redis succeeded
      expect(result).toBe(true);
      expect(mockSAdd).toHaveBeenCalled();
    });

    it('getTokens DB fallback handles DB errors gracefully', async () => {
      // Redis empty, DB throws
      mockFindMany.mockRejectedValueOnce(new Error('DB connection timeout'));

      const { fcmService } = require('../shared/services/fcm.service');
      const tokens = await fcmService.getTokens('user-7');

      // Should return empty array, not throw
      expect(tokens).toEqual([]);
    });
  });
});

// =============================================================================
// M4: Driver logout endpoint exists
// =============================================================================
// Tests that POST /driver-auth/logout is registered, uses authMiddleware,
// and delegates to authService.logout.
// =============================================================================

describe('M4: Driver logout endpoint', () => {
  // -------------------------------------------------------------------------
  // Route registration verification
  // -------------------------------------------------------------------------
  describe('Route registration', () => {
    interface RouteEntry {
      method: string;
      path: string;
    }

    function extractRoutes(router: any): RouteEntry[] {
      const routes: RouteEntry[] = [];
      const stack = router?.stack ?? router?._router?.stack ?? [];
      for (const layer of stack) {
        if (layer.route) {
          const routePath: string = layer.route.path;
          for (const method of Object.keys(layer.route.methods)) {
            routes.push({ method: method.toUpperCase(), path: routePath });
          }
        }
      }
      return routes;
    }

    it('POST /logout route exists on driverAuthRouter', () => {
      const { driverAuthRouter } = require('../modules/driver-auth/driver-auth.routes');
      const routes = extractRoutes(driverAuthRouter);
      const hasLogout = routes.some(
        (r) => r.method === 'POST' && r.path === '/logout'
      );
      expect(hasLogout).toBe(true);
    });

    it('POST /send-otp route still exists (not broken)', () => {
      const { driverAuthRouter } = require('../modules/driver-auth/driver-auth.routes');
      const routes = extractRoutes(driverAuthRouter);
      expect(routes.some((r) => r.method === 'POST' && r.path === '/send-otp')).toBe(true);
    });

    it('POST /verify-otp route still exists (not broken)', () => {
      const { driverAuthRouter } = require('../modules/driver-auth/driver-auth.routes');
      const routes = extractRoutes(driverAuthRouter);
      expect(routes.some((r) => r.method === 'POST' && r.path === '/verify-otp')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Source code structure verification
  // -------------------------------------------------------------------------
  describe('Logout route implementation', () => {
    let routeSource: string;

    beforeAll(() => {
      routeSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/driver-auth/driver-auth.routes.ts'),
        'utf-8'
      );
    });

    it('logout route uses authMiddleware for protection', () => {
      // The route should have authMiddleware before the handler
      expect(routeSource).toMatch(/router\.post\s*\(\s*['"]\/logout['"]\s*,\s*authMiddleware/);
    });

    it('logout route calls authService.logout', () => {
      expect(routeSource).toContain('authService.logout');
    });

    it('logout route extracts userId from req.user', () => {
      expect(routeSource).toContain('req.user?.userId');
    });

    it('logout route extracts jti from req.user for blacklisting', () => {
      expect(routeSource).toContain('req.user?.jti');
    });

    it('logout route returns 401 when userId is missing', () => {
      expect(routeSource).toMatch(/res\.status\(401\)/);
      expect(routeSource).toContain('UNAUTHORIZED');
    });

    it('logout route returns success response on valid logout', () => {
      expect(routeSource).toContain("'Logged out successfully'");
    });

    it('logout route extracts exp from JWT for blacklist TTL', () => {
      // The route decodes the JWT to get exp for TTL calculation
      expect(routeSource).toContain('decoded.exp');
    });

    it('logout route has error handling via next(error)', () => {
      expect(routeSource).toContain('next(error)');
    });

    it('logout route contains M4 fix comment marker', () => {
      expect(routeSource).toContain('Fix M4');
    });
  });

  // -------------------------------------------------------------------------
  // authService.logout behavior verification
  // -------------------------------------------------------------------------
  describe('authService.logout cleanup chain', () => {
    let authSource: string;

    beforeAll(() => {
      authSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.service.ts'),
        'utf-8'
      );
    });

    it('logout blacklists JTI in Redis when jti and exp provided', () => {
      expect(authSource).toContain('`blacklist:${jti}`');
      expect(authSource).toContain("'revoked'");
    });

    it('logout calculates remaining TTL from exp', () => {
      expect(authSource).toContain('exp - Math.floor(Date.now() / 1000)');
    });

    it('logout deletes all refresh tokens for the user', () => {
      // Should iterate token IDs and delete each refresh token
      expect(authSource).toMatch(/for\s*\(\s*const\s+tokenId\s+of\s+tokenIds\s*\)/);
      expect(authSource).toContain('REDIS_KEYS.REFRESH_TOKEN(tokenId)');
    });

    it('logout cleans up FCM tokens via fcmService.removeAllTokens', () => {
      expect(authSource).toContain('fcmService.removeAllTokens(userId)');
    });

    it('logout cleans up driver presence from Redis', () => {
      expect(authSource).toContain('`driver:presence:${userId}`');
    });

    it('logout cleans up socket connection count', () => {
      expect(authSource).toContain('`socket:conncount:${userId}`');
    });

    it('logout removes transporter from online set', () => {
      expect(authSource).toContain('ONLINE_TRANSPORTERS_SET');
    });

    it('logout sets user offline via availabilityService for drivers/transporters', () => {
      expect(authSource).toContain('availabilityService.setOffline(userId)');
    });

    it('logout uses Promise.allSettled for cleanup resilience', () => {
      // Cleanup operations should not fail the overall logout
      expect(authSource).toContain('Promise.allSettled');
    });
  });
});
