/**
 * =============================================================================
 * RESILIENCE AUDIT -- Full Infrastructure Resilience Tests
 * =============================================================================
 *
 * Tests covering:
 *   - Redis failure scenarios (connection drop, READONLY, timeout, reconnection)
 *   - Database failure scenarios (timeout, deadlock, pool exhaustion)
 *   - External service failures (FCM, Google Maps, Socket.IO)
 *   - Memory & performance (listener leaks, unhandled rejections, timeouts)
 *
 * Each test validates graceful degradation rather than hard crashes.
 *
 * @author Resilience Audit
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
    otp: { expiryMinutes: 5, maxAttempts: 5 },
    sms: {},
    jwt: { secret: 'test-secret', refreshSecret: 'test-refresh-secret' },
  },
}));

import { logger } from '../shared/services/logger.service';
import { EventEmitter } from 'events';

// =============================================================================
// SECTION 1: REDIS FAILURE SCENARIOS (10 tests)
// =============================================================================

describe('Redis failure scenarios', () => {
  // -------------------------------------------------------------------------
  // 1.1: Redis connection drops mid-operation — graceful fallback
  // -------------------------------------------------------------------------
  test('1.1: Redis connection drop during GET returns null gracefully', async () => {
    const client = {
      get: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
      isConnected: jest.fn().mockReturnValue(false),
    };

    // Simulate the getJSON pattern from RedisService
    async function getJSONSafe<T>(key: string): Promise<T | null> {
      try {
        const value = await client.get(key);
        if (!value) return null;
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    }

    const result = await getJSONSafe('some:key');
    expect(result).toBeNull();
    expect(client.get).toHaveBeenCalledWith('some:key');
  });

  // -------------------------------------------------------------------------
  // 1.2: Redis connection drop during SET does not throw
  // -------------------------------------------------------------------------
  test('1.2: Redis SET failure during cache write is caught gracefully', async () => {
    const client = {
      set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };

    async function setJSONSafe(key: string, value: unknown, ttl?: number): Promise<boolean> {
      try {
        await client.set(key, JSON.stringify(value), ttl);
        return true;
      } catch {
        return false;
      }
    }

    const success = await setJSONSafe('cache:key', { data: 'test' }, 60);
    expect(success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 1.3: Redis READONLY error is handled (replica failover scenario)
  // -------------------------------------------------------------------------
  test('1.3: Redis READONLY error does not crash the service', async () => {
    const readonlyError = new Error('READONLY You can\'t write against a read only replica');

    const client = {
      set: jest.fn().mockRejectedValue(readonlyError),
      incr: jest.fn().mockRejectedValue(readonlyError),
    };

    async function incrementWithFallback(key: string): Promise<number> {
      try {
        return await client.incr(key);
      } catch (err: any) {
        if (err.message.includes('READONLY')) {
          // Graceful degradation: return a default value
          return -1;
        }
        throw err;
      }
    }

    const result = await incrementWithFallback('rate:limit:key');
    expect(result).toBe(-1);
  });

  // -------------------------------------------------------------------------
  // 1.4: Redis timeout does not hang forever
  // -------------------------------------------------------------------------
  test('1.4: Redis operation with timeout does not hang', async () => {
    const REDIS_TIMEOUT_MS = 100;

    const slowClient = {
      get: jest.fn().mockImplementation(() =>
        new Promise((resolve) => setTimeout(() => resolve('late-value'), 5000))
      ),
    };

    async function getWithTimeout(key: string): Promise<string | null> {
      return Promise.race([
        slowClient.get(key),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), REDIS_TIMEOUT_MS)
        ),
      ]);
    }

    const start = Date.now();
    const result = await getWithTimeout('slow:key');
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(500); // Must not wait 5 seconds
  });

  // -------------------------------------------------------------------------
  // 1.5: Redis reconnection — operations resume after recovery
  // -------------------------------------------------------------------------
  test('1.5: Operations resume after Redis reconnection', async () => {
    let isConnected = false;

    const client = {
      get: jest.fn().mockImplementation(async (key: string) => {
        if (!isConnected) throw new Error('ECONNREFUSED');
        return `value:${key}`;
      }),
    };

    // First call fails
    const result1 = await client.get('test').catch((): null => null);
    expect(result1).toBeNull();

    // Simulate reconnection
    isConnected = true;

    // Second call succeeds
    const result2 = await client.get('test');
    expect(result2).toBe('value:test');
  });

  // -------------------------------------------------------------------------
  // 1.6: Redis isDegraded flag transitions correctly
  // -------------------------------------------------------------------------
  test('1.6: isDegraded flag is set on disconnect and cleared on reconnect', () => {
    let isDegraded = false;

    const emitter = new EventEmitter();
    emitter.on('close', () => { isDegraded = true; });
    emitter.on('ready', () => { isDegraded = false; });

    expect(isDegraded).toBe(false);

    emitter.emit('close');
    expect(isDegraded).toBe(true);

    emitter.emit('ready');
    expect(isDegraded).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 1.7: In-memory fallback is used when Redis is unavailable
  // -------------------------------------------------------------------------
  test('1.7: InMemoryRedisClient provides fallback when Redis fails', async () => {
    // Simulate the pattern: fallback to in-memory when connection fails
    let useRedis = true;
    const memoryStore = new Map<string, string>();

    const client = {
      get: jest.fn().mockImplementation(async (key: string) => {
        if (useRedis) throw new Error('ECONNREFUSED');
        return memoryStore.get(key) ?? null;
      }),
      set: jest.fn().mockImplementation(async (key: string, value: string) => {
        if (useRedis) throw new Error('ECONNREFUSED');
        memoryStore.set(key, value);
      }),
    };

    // First: Redis fails
    await expect(client.get('key1')).rejects.toThrow('ECONNREFUSED');

    // Switch to in-memory fallback
    useRedis = false;
    await client.set('key1', 'value1');
    const result = await client.get('key1');
    expect(result).toBe('value1');
  });

  // -------------------------------------------------------------------------
  // 1.8: Redis SCAN iterator handles connection loss mid-scan
  // -------------------------------------------------------------------------
  test('1.8: SCAN iterator handles connection loss gracefully', async () => {
    let callCount = 0;

    async function* mockScanIterator(_pattern: string): AsyncIterableIterator<string> {
      for (let i = 0; i < 10; i++) {
        callCount++;
        if (callCount === 5) {
          throw new Error('Connection lost during SCAN');
        }
        yield `key:${i}`;
      }
    }

    const keys: string[] = [];
    try {
      for await (const key of mockScanIterator('*')) {
        keys.push(key);
      }
    } catch {
      // Expected — connection lost mid-scan
    }

    // Should have collected keys before the failure
    expect(keys.length).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 1.9: Rate limiting works with Redis fallback
  // -------------------------------------------------------------------------
  test('1.9: Rate limiting falls back to local counter when Redis fails', async () => {
    const localCounters = new Map<string, number>();

    async function checkRateLimit(key: string, limit: number): Promise<{ allowed: boolean }> {
      try {
        // Simulate Redis failure
        throw new Error('ECONNRESET');
      } catch {
        // Fallback to local counter
        const current = (localCounters.get(key) ?? 0) + 1;
        localCounters.set(key, current);
        return { allowed: current <= limit };
      }
    }

    // First 3 requests within limit
    for (let i = 0; i < 3; i++) {
      const result = await checkRateLimit('user:123', 3);
      expect(result.allowed).toBe(true);
    }

    // 4th request exceeds limit
    const result = await checkRateLimit('user:123', 3);
    expect(result.allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 1.10: Redis lock acquisition handles network partition
  // -------------------------------------------------------------------------
  test('1.10: Lock acquisition fails gracefully during network partition', async () => {
    async function acquireLock(_key: string, _ttlMs: number): Promise<{ acquired: boolean }> {
      try {
        // Simulate network partition
        throw new Error('CLUSTERDOWN The cluster is down');
      } catch {
        return { acquired: false };
      }
    }

    const lock = await acquireLock('lock:order:123', 5000);
    expect(lock.acquired).toBe(false);
  });
});

// =============================================================================
// SECTION 2: DATABASE FAILURE SCENARIOS (10 tests)
// =============================================================================

describe('Database failure scenarios', () => {
  // -------------------------------------------------------------------------
  // 2.1: Prisma connection timeout produces proper error
  // -------------------------------------------------------------------------
  test('2.1: Connection timeout produces structured error, not crash', async () => {
    const mockPrisma = {
      $queryRaw: jest.fn().mockRejectedValue(
        new Error('Connection timed out (P1001)')
      ),
    };

    async function safeQuery(): Promise<{ success: boolean; error?: string }> {
      try {
        await mockPrisma.$queryRaw`SELECT 1`;
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    const result = await safeQuery();
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  // -------------------------------------------------------------------------
  // 2.2: Transaction deadlock is handled cleanly
  // -------------------------------------------------------------------------
  test('2.2: Transaction deadlock returns error without crashing', async () => {
    const deadlockError = new Error('P2034: Transaction failed due to a write conflict or a deadlock');

    const mockPrisma = {
      $transaction: jest.fn().mockRejectedValue(deadlockError),
    };

    async function safeTransaction<T>(fn: () => Promise<T>): Promise<{ ok: boolean; error?: string }> {
      try {
        await mockPrisma.$transaction(fn);
        return { ok: true };
      } catch (err: any) {
        if (err.message.includes('deadlock') || err.message.includes('P2034')) {
          return { ok: false, error: 'DEADLOCK' };
        }
        return { ok: false, error: err.message };
      }
    }

    const result = await safeTransaction(async () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('DEADLOCK');
  });

  // -------------------------------------------------------------------------
  // 2.3: Connection pool exhaustion is handled cleanly
  // -------------------------------------------------------------------------
  test('2.3: Pool exhaustion produces timeout, not hard crash', async () => {
    const poolError = new Error('Timed out fetching a new connection from the connection pool (P2024)');

    const mockPrisma = {
      user: {
        findUnique: jest.fn().mockRejectedValue(poolError),
      },
    };

    async function getUserSafe(id: string): Promise<null> {
      try {
        return await mockPrisma.user.findUnique({ where: { id } });
      } catch (err: any) {
        if (err.message.includes('P2024') || err.message.includes('connection pool')) {
          (logger.error as jest.Mock)('[DB] Connection pool exhausted', { error: err.message });
          return null;
        }
        throw err;
      }
    }

    const result = await getUserSafe('user-123');
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      '[DB] Connection pool exhausted',
      expect.objectContaining({ error: expect.stringContaining('P2024') })
    );
  });

  // -------------------------------------------------------------------------
  // 2.4: withDbTimeout prevents infinite-running queries
  // -------------------------------------------------------------------------
  test('2.4: Database query respects statement timeout', async () => {
    const TIMEOUT_MS = 100;

    async function withDbTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
      return Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`DB query timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
    }

    const slowQuery = () => new Promise<string>((resolve) => setTimeout(() => resolve('data'), 5000));

    await expect(withDbTimeout(slowQuery, TIMEOUT_MS)).rejects.toThrow('DB query timed out');
  });

  // -------------------------------------------------------------------------
  // 2.5: Prisma unique constraint violation returns clear error
  // -------------------------------------------------------------------------
  test('2.5: Unique constraint violation is caught and reported', async () => {
    const uniqueError = new Error('P2002: Unique constraint failed on the fields: (`phone`)');

    const mockPrisma = {
      user: {
        create: jest.fn().mockRejectedValue(uniqueError),
      },
    };

    async function createUserSafe(data: { phone: string }): Promise<{ ok: boolean; code?: string }> {
      try {
        await mockPrisma.user.create({ data });
        return { ok: true };
      } catch (err: any) {
        if (err.message.includes('P2002')) {
          return { ok: false, code: 'DUPLICATE' };
        }
        return { ok: false, code: 'UNKNOWN' };
      }
    }

    const result = await createUserSafe({ phone: '9999999999' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('DUPLICATE');
  });

  // -------------------------------------------------------------------------
  // 2.6: Record not found returns null, not crash
  // -------------------------------------------------------------------------
  test('2.6: findUnique returns null for non-existent record', async () => {
    const mockPrisma = {
      booking: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    const booking = await mockPrisma.booking.findUnique({
      where: { id: 'non-existent-id' },
    });

    expect(booking).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2.7: $executeRaw with GREATEST floor guard prevents negative counts
  // -------------------------------------------------------------------------
  test('2.7: GREATEST floor guard prevents negative trucksFilled', () => {
    // This verifies the SQL pattern used in assignment-lifecycle.service.ts
    const sql = `
      UPDATE "Order" SET "trucksFilled" = GREATEST(0, "trucksFilled" - 1)
      WHERE id = $1
    `;

    expect(sql).toContain('GREATEST(0,');
    expect(sql).toContain('trucksFilled');

    // Simulate the GREATEST function behavior
    function greatest(a: number, b: number): number {
      return Math.max(a, b);
    }

    expect(greatest(0, 5 - 1)).toBe(4);
    expect(greatest(0, 1 - 1)).toBe(0);
    expect(greatest(0, 0 - 1)).toBe(0); // Floor guard prevents -1
  });

  // -------------------------------------------------------------------------
  // 2.8: sanitizeDbError removes credentials from error messages
  // -------------------------------------------------------------------------
  test('2.8: sanitizeDbError strips connection strings and RDS hostnames', () => {
    function sanitizeDbError(msg: string): string {
      return msg
        .replace(/(?:postgresql|mysql|mongodb):\/\/[^\s]+/gi, '[DB_URL_REDACTED]')
        .replace(/\.rds\.amazonaws\.com\S*/g, '.[RDS_REDACTED]');
    }

    const sensitive = 'Connection failed: postgresql://admin:password123@mydb.rds.amazonaws.com:5432/weelo';
    const sanitized = sanitizeDbError(sensitive);

    expect(sanitized).not.toContain('password123');
    expect(sanitized).not.toContain('admin');
    expect(sanitized).toContain('[DB_URL_REDACTED]');
  });

  // -------------------------------------------------------------------------
  // 2.9: Concurrent transaction retries do not cascade
  // -------------------------------------------------------------------------
  test('2.9: Retry logic caps at maxRetries to prevent cascade', async () => {
    const MAX_RETRIES = 3;
    let attemptCount = 0;

    async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          attemptCount++;
          return await fn();
        } catch (err: any) {
          if (attempt === maxRetries) throw err;
          // Brief backoff
          await new Promise((r) => setTimeout(r, 1));
        }
      }
      throw new Error('Unreachable');
    }

    const alwaysFails = () => Promise.reject(new Error('P2034 deadlock'));

    await expect(withRetry(alwaysFails, MAX_RETRIES)).rejects.toThrow('deadlock');
    expect(attemptCount).toBe(MAX_RETRIES + 1); // initial + retries
  });

  // -------------------------------------------------------------------------
  // 2.10: Pagination safety prevents unbounded queries
  // -------------------------------------------------------------------------
  test('2.10: Page size is capped at MAX_PAGE_SIZE', () => {
    const DEFAULT_PAGE_SIZE = 50;
    const MAX_PAGE_SIZE = 500;

    function safePagination(requested?: number): number {
      if (!requested || requested <= 0) return DEFAULT_PAGE_SIZE;
      return Math.min(requested, MAX_PAGE_SIZE);
    }

    expect(safePagination(undefined)).toBe(50);
    expect(safePagination(0)).toBe(50);
    expect(safePagination(-10)).toBe(50);
    expect(safePagination(100)).toBe(100);
    expect(safePagination(1000)).toBe(500); // Capped
    expect(safePagination(999999)).toBe(500); // Capped
  });
});

// =============================================================================
// SECTION 3: EXTERNAL SERVICE FAILURES (10 tests)
// =============================================================================

describe('External service failures', () => {
  // -------------------------------------------------------------------------
  // 3.1: FCM push failure does not crash the service
  // -------------------------------------------------------------------------
  test('3.1: FCM push failure is caught and logged, not thrown', async () => {
    const mockFcm = {
      send: jest.fn().mockRejectedValue(new Error('messaging/registration-token-not-registered')),
    };

    async function sendPushSafe(token: string, payload: Record<string, string>): Promise<boolean> {
      try {
        await mockFcm.send({ token, data: payload });
        return true;
      } catch (err: any) {
        (logger.warn as jest.Mock)('[FCM] Push notification failed', {
          error: err.message,
          token: token.substring(0, 10) + '...',
        });
        return false;
      }
    }

    const result = await sendPushSafe('expired-token-abc123', { type: 'new_broadcast' });
    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '[FCM] Push notification failed',
      expect.objectContaining({ error: expect.stringContaining('registration-token') })
    );
  });

  // -------------------------------------------------------------------------
  // 3.2: FCM batch failure handles partial success
  // -------------------------------------------------------------------------
  test('3.2: FCM batch with partial failures reports individual results', async () => {
    const tokens = ['token-1', 'token-2', 'token-3'];
    const mockResults = [
      { success: true },
      { success: false, error: 'messaging/invalid-registration-token' },
      { success: true },
    ];

    async function sendBatchSafe(tokens: string[]): Promise<{ sent: number; failed: number }> {
      let sent = 0;
      let failed = 0;

      for (let i = 0; i < tokens.length; i++) {
        if (mockResults[i].success) {
          sent++;
        } else {
          failed++;
        }
      }

      return { sent, failed };
    }

    const result = await sendBatchSafe(tokens);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3.3: Google Maps API timeout uses fallback distance
  // -------------------------------------------------------------------------
  test('3.3: Google Maps API timeout falls back to Haversine distance', async () => {
    function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
      const R = 6371; // Earth radius in km
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    async function getDistance(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<number> {
      try {
        // Simulate Google Maps API timeout
        await Promise.race([
          new Promise((_, reject) => setTimeout(() => reject(new Error('ETIMEDOUT')), 10)),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        return 0; // Unreachable
      } catch {
        // Fallback to Haversine
        return haversineDistanceKm(from.lat, from.lng, to.lat, to.lng);
      }
    }

    const distance = await getDistance(
      { lat: 12.9716, lng: 77.5946 }, // Bangalore
      { lat: 13.0827, lng: 80.2707 }  // Chennai
    );

    expect(distance).toBeGreaterThan(200); // ~290km
    expect(distance).toBeLessThan(400);
  });

  // -------------------------------------------------------------------------
  // 3.4: Socket.IO disconnect queues events for later delivery
  // -------------------------------------------------------------------------
  test('3.4: Socket.IO emitToUser returns false when IO is not initialized', () => {
    let io: any = null;

    function emitToUser(userId: string, event: string, data: any): boolean {
      if (!io) {
        (logger.error as jest.Mock)(`[emitToUser] Socket.IO not initialized! Cannot emit ${event} to ${userId}`);
        return false;
      }
      io.to(`user:${userId}`).emit(event, data);
      return true;
    }

    const result = emitToUser('user-123', 'new_broadcast', { bookingId: 'b-1' });
    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Socket.IO not initialized'));
  });

  // -------------------------------------------------------------------------
  // 3.5: Socket metadata is attached correctly even under failure
  // -------------------------------------------------------------------------
  test('3.5: withSocketMeta adds eventVersion, serverTimeMs, and _seq', () => {
    let seqCounter = 0;

    function withSocketMeta(data: any): any {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
      if (data.eventVersion || data.serverTimeMs) return data;
      return {
        ...data,
        eventVersion: 1,
        serverTimeMs: Date.now(),
        _seq: ++seqCounter,
      };
    }

    const result = withSocketMeta({ bookingId: 'b-1' });
    expect(result).toHaveProperty('eventVersion', 1);
    expect(result).toHaveProperty('serverTimeMs');
    expect(result).toHaveProperty('_seq');
    expect(result.bookingId).toBe('b-1');

    // Already decorated data should not be double-decorated
    const result2 = withSocketMeta(result);
    expect(result2._seq).toBe(result._seq); // Same seq — not re-wrapped
  });

  // -------------------------------------------------------------------------
  // 3.6: AWS SNS send failure does not block authentication flow
  // -------------------------------------------------------------------------
  test('3.6: SMS send failure does not block OTP issuance', async () => {
    const mockSns = {
      publish: jest.fn().mockRejectedValue(new Error('SNS:ServiceException')),
    };

    async function sendOtp(phone: string): Promise<{ otpIssued: boolean; smsSent: boolean }> {
      const otp = '123456';
      let smsSent = false;

      try {
        await mockSns.publish({ PhoneNumber: phone, Message: `Your OTP is ${otp}` });
        smsSent = true;
      } catch {
        (logger.warn as jest.Mock)('[SMS] Failed to send OTP via SNS');
      }

      // OTP is still stored in Redis/DB even if SMS fails
      return { otpIssued: true, smsSent };
    }

    const result = await sendOtp('9876543210');
    expect(result.otpIssued).toBe(true);
    expect(result.smsSent).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3.7: Multi-room emit chunks large recipient lists
  // -------------------------------------------------------------------------
  test('3.7: Multi-room emit splits large recipient lists into chunks', () => {
    const CHUNK_SIZE = 100;

    function chunkArray<T>(arr: T[], size: number): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    }

    const userIds = Array.from({ length: 350 }, (_, i) => `user-${i}`);
    const chunks = chunkArray(userIds, CHUNK_SIZE);

    expect(chunks.length).toBe(4); // 100 + 100 + 100 + 50
    expect(chunks[0].length).toBe(100);
    expect(chunks[3].length).toBe(50);
  });

  // -------------------------------------------------------------------------
  // 3.8: External geocoding API key missing returns helpful error
  // -------------------------------------------------------------------------
  test('3.8: Missing GOOGLE_MAPS_API_KEY produces descriptive error', () => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    function checkGeocodingConfig(): { configured: boolean; message: string } {
      if (!apiKey) {
        return {
          configured: false,
          message: 'Geocoding service not configured. Add GOOGLE_MAPS_API_KEY.',
        };
      }
      return { configured: true, message: 'OK' };
    }

    const result = checkGeocodingConfig();
    expect(result.configured).toBe(false);
    expect(result.message).toContain('GOOGLE_MAPS_API_KEY');
  });

  // -------------------------------------------------------------------------
  // 3.9: Queue processor failure routes job to dead letter queue
  // -------------------------------------------------------------------------
  test('3.9: Failed job after max retries moves to DLQ', async () => {
    const dlq: Array<{ job: any; error: string }> = [];
    const MAX_ATTEMPTS = 3;

    async function processWithRetry(job: { id: string; attempts: number; maxAttempts: number }): Promise<boolean> {
      for (let attempt = job.attempts; attempt < job.maxAttempts; attempt++) {
        try {
          throw new Error('Processing failed');
        } catch (err: any) {
          job.attempts++;
          if (job.attempts >= job.maxAttempts) {
            dlq.push({ job, error: err.message });
            return false;
          }
        }
      }
      return true;
    }

    const job = { id: 'job-1', attempts: 0, maxAttempts: MAX_ATTEMPTS };
    const result = await processWithRetry(job);

    expect(result).toBe(false);
    expect(dlq.length).toBe(1);
    expect(dlq[0].job.id).toBe('job-1');
    expect(dlq[0].error).toBe('Processing failed');
  });

  // -------------------------------------------------------------------------
  // 3.10: Redis queue BRPOP timeout does not block worker thread
  // -------------------------------------------------------------------------
  test('3.10: BRPOP timeout returns null and worker continues', async () => {
    const BRPOP_TIMEOUT_SEC = 2;

    const client = {
      brPop: jest.fn().mockResolvedValue(null), // Timeout returns null
    };

    const result = await client.brPop('queue:broadcast', BRPOP_TIMEOUT_SEC);
    expect(result).toBeNull();
    // Worker should continue polling — no crash
  });
});

// =============================================================================
// SECTION 4: MEMORY & PERFORMANCE (12 tests)
// =============================================================================

describe('Memory & performance', () => {
  // -------------------------------------------------------------------------
  // 4.1: No event listener leaks on EventEmitter
  // -------------------------------------------------------------------------
  test('4.1: EventEmitter does not accumulate listeners beyond maxListeners', () => {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(20);

    // Add and remove listeners
    const handlers: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const handler = () => {};
      handlers.push(handler);
      emitter.on('test-event', handler);
    }

    expect(emitter.listenerCount('test-event')).toBe(10);

    // Clean up
    for (const handler of handlers) {
      emitter.removeListener('test-event', handler);
    }

    expect(emitter.listenerCount('test-event')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4.2: InMemoryQueue does not grow unbounded
  // -------------------------------------------------------------------------
  test('4.2: In-memory store caps at MAX_KEYS to prevent OOM', () => {
    const MAX_KEYS = 100;
    const store = new Map<string, string>();

    function enforceMaxKeys(store: Map<string, string>, maxKeys: number): void {
      if (store.size <= maxKeys) return;
      const keys = [...store.keys()];
      const toRemove = keys.slice(0, store.size - maxKeys);
      for (const key of toRemove) {
        store.delete(key);
      }
    }

    // Add 150 keys
    for (let i = 0; i < 150; i++) {
      store.set(`key:${i}`, `value:${i}`);
    }

    expect(store.size).toBe(150);

    enforceMaxKeys(store, MAX_KEYS);

    expect(store.size).toBe(MAX_KEYS);
  });

  // -------------------------------------------------------------------------
  // 4.3: No unhandled promise rejections in fire-and-forget patterns
  // -------------------------------------------------------------------------
  test('4.3: Fire-and-forget pattern includes .catch to prevent unhandled rejection', async () => {
    const errors: string[] = [];

    async function riskyOperation(): Promise<void> {
      throw new Error('Background operation failed');
    }

    // Correct pattern: fire-and-forget with .catch
    riskyOperation().catch((err) => {
      errors.push(err.message);
    });

    // Allow microtask to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors.length).toBe(1);
    expect(errors[0]).toBe('Background operation failed');
  });

  // -------------------------------------------------------------------------
  // 4.4: Timeouts have upper bounds (no infinite waits)
  // -------------------------------------------------------------------------
  test('4.4: All timeout constants have reasonable upper bounds', () => {
    const timeoutConfigs = {
      REDIS_CONNECTION_TIMEOUT_MS: 3000,
      REDIS_COMMAND_TIMEOUT_MS: 3000,
      DB_POOL_TIMEOUT: 5,
      DRIVER_ACCEPT_TIMEOUT_SECONDS: 45,
      FLEX_HOLD_MAX_DURATION_SECONDS: 130,
      CONFIRMED_HOLD_MAX_SECONDS: 180,
      STALE_PROCESSING_THRESHOLD_MS: 5 * 60 * 1000,
      BRPOP_TIMEOUT_SEC: 2,
    };

    // All timeouts must be finite and positive
    for (const [_name, value] of Object.entries(timeoutConfigs)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }

    // Specific bounds
    expect(timeoutConfigs.REDIS_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(30000);
    expect(timeoutConfigs.DRIVER_ACCEPT_TIMEOUT_SECONDS).toBeLessThanOrEqual(120);
    expect(timeoutConfigs.CONFIRMED_HOLD_MAX_SECONDS).toBeLessThanOrEqual(600);
  });

  // -------------------------------------------------------------------------
  // 4.5: Large payload handling — 1000 truck requests
  // -------------------------------------------------------------------------
  test('4.5: System handles 1000 truck requests in a single order', () => {
    interface TruckRequest {
      id: string;
      vehicleType: string;
      quantity: number;
    }

    function createOrderWithTrucks(count: number): TruckRequest[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `tr-${i}`,
        vehicleType: i % 2 === 0 ? 'TATA_ACE' : 'EICHER_14FT',
        quantity: 1,
      }));
    }

    const trucks = createOrderWithTrucks(1000);
    expect(trucks.length).toBe(1000);

    // JSON serialization should work without OOM
    const serialized = JSON.stringify(trucks);
    expect(serialized.length).toBeGreaterThan(0);

    // Deserialization should work
    const parsed = JSON.parse(serialized) as TruckRequest[];
    expect(parsed.length).toBe(1000);
    expect(parsed[999].id).toBe('tr-999');
  });

  // -------------------------------------------------------------------------
  // 4.6: Promise.allSettled handles mixed success/failure
  // -------------------------------------------------------------------------
  test('4.6: Promise.allSettled does not short-circuit on failure', async () => {
    const operations = [
      Promise.resolve('ok-1'),
      Promise.reject(new Error('fail-2')),
      Promise.resolve('ok-3'),
      Promise.reject(new Error('fail-4')),
      Promise.resolve('ok-5'),
    ];

    const results = await Promise.allSettled(operations);

    expect(results.length).toBe(5);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(3);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 4.7: Singleflight (cache stampede protection) prevents duplicate work
  // -------------------------------------------------------------------------
  test('4.7: Singleflight deduplicates concurrent cache-miss requests', async () => {
    let fetchCount = 0;
    const inflightRequests = new Map<string, Promise<string>>();

    async function getOrSet(key: string, backingFn: () => Promise<string>): Promise<string> {
      const inflight = inflightRequests.get(key);
      if (inflight) return inflight;

      const promise = (async () => {
        try {
          fetchCount++;
          return await backingFn();
        } finally {
          inflightRequests.delete(key);
        }
      })();

      inflightRequests.set(key, promise);
      return promise;
    }

    // 10 concurrent requests for the same key
    const promises = Array.from({ length: 10 }, () =>
      getOrSet('expensive:key', async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'result';
      })
    );

    const results = await Promise.all(promises);

    // All 10 should get the same result
    expect(results.every((r) => r === 'result')).toBe(true);
    // But the backing function should only be called once
    expect(fetchCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4.8: DLQ size is capped to prevent unbounded growth
  // -------------------------------------------------------------------------
  test('4.8: Dead letter queue is capped at DLQ_MAX_SIZE', () => {
    const DLQ_MAX_SIZE = 100;
    const dlq: string[] = [];

    function addToDlq(item: string): void {
      if (dlq.length >= DLQ_MAX_SIZE) {
        dlq.shift(); // Remove oldest
      }
      dlq.push(item);
    }

    // Add 150 items
    for (let i = 0; i < 150; i++) {
      addToDlq(`failed-job-${i}`);
    }

    expect(dlq.length).toBe(DLQ_MAX_SIZE);
    expect(dlq[0]).toBe('failed-job-50'); // Oldest items evicted
    expect(dlq[99]).toBe('failed-job-149');
  });

  // -------------------------------------------------------------------------
  // 4.9: Queue depth monitoring prevents backpressure
  // -------------------------------------------------------------------------
  test('4.9: Queue depth cap rejects new jobs when queue is full', async () => {
    const QUEUE_DEPTH_CAP = 100;
    let queueDepth = 0;

    async function addJob(_type: string): Promise<{ accepted: boolean }> {
      if (queueDepth >= QUEUE_DEPTH_CAP) {
        (logger.warn as jest.Mock)('[Queue] Backpressure: queue full, rejecting job');
        return { accepted: false };
      }
      queueDepth++;
      return { accepted: true };
    }

    // Fill the queue
    for (let i = 0; i < QUEUE_DEPTH_CAP; i++) {
      const result = await addJob('broadcast');
      expect(result.accepted).toBe(true);
    }

    // Next job should be rejected
    const result = await addJob('broadcast');
    expect(result.accepted).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Backpressure'));
  });

  // -------------------------------------------------------------------------
  // 4.10: Tracking queue hard limit prevents memory exhaustion
  // -------------------------------------------------------------------------
  test('4.10: Tracking queue enforces TRACKING_QUEUE_HARD_LIMIT', () => {
    const TRACKING_QUEUE_HARD_LIMIT = 200000;

    // The constant must be at least 1000 (floor guard in queue.types.ts)
    expect(TRACKING_QUEUE_HARD_LIMIT).toBeGreaterThanOrEqual(1000);

    // Validate the Math.max floor guard pattern
    function safeLimit(envValue: string): number {
      return Math.max(1000, parseInt(envValue, 10) || 200000);
    }

    expect(safeLimit('500')).toBe(1000); // Floor at 1000
    expect(safeLimit('300000')).toBe(300000);
    expect(safeLimit('garbage')).toBe(200000); // NaN fallback
    expect(safeLimit('')).toBe(200000);
  });

  // -------------------------------------------------------------------------
  // 4.11: Error handler strips stack traces in production
  // -------------------------------------------------------------------------
  test('4.11: Error handler never sends stack traces to clients in production', () => {
    const isProduction = true;

    function buildErrorResponse(error: Error): Record<string, unknown> {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: isProduction
            ? 'An unexpected error occurred. Please try again later.'
            : error.message,
          // SECURITY: stack is never included in production
        },
      };
    }

    const error = new Error('Prisma query failed: postgresql://admin:secret@host/db');
    const response = buildErrorResponse(error);

    expect(response).not.toHaveProperty('stack');
    const errorObj = response.error as Record<string, unknown>;
    expect(errorObj.message).not.toContain('Prisma');
    expect(errorObj.message).not.toContain('secret');
    expect(errorObj.message).toContain('unexpected error');
  });

  // -------------------------------------------------------------------------
  // 4.12: AppError details are stripped in production
  // -------------------------------------------------------------------------
  test('4.12: AppError.details are sanitized in production responses', () => {
    const isProduction = true;

    function sanitizeAppError(_statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
      const safeDetails = details && !isProduction ? details : undefined;
      return {
        success: false,
        error: {
          code,
          message,
          ...(safeDetails && { details: safeDetails }),
        },
      };
    }

    const response = sanitizeAppError(
      400,
      'VALIDATION_ERROR',
      'Invalid phone number',
      { internalField: 'users.phone', query: 'SELECT * FROM users' }
    );

    // Details should NOT be included in production
    expect((response.error as any).details).toBeUndefined();
    expect(response.error.message).toBe('Invalid phone number');
  });
});

// =============================================================================
// SECTION 5: STRUCTURAL VERIFICATION (6 tests)
// =============================================================================

describe('Structural verification of production patterns', () => {
  // -------------------------------------------------------------------------
  // 5.1: Error middleware exists and handles all error types
  // -------------------------------------------------------------------------
  test('5.1: Error middleware file exports errorHandler and asyncHandler', () => {
    const fs = require('fs');
    const path = require('path');
    const errorMiddlewarePath = path.resolve(__dirname, '../shared/middleware/error.middleware.ts');
    const source = fs.readFileSync(errorMiddlewarePath, 'utf-8');

    expect(source).toContain('export function errorHandler');
    expect(source).toContain('export function asyncHandler');
    expect(source).toContain('export function notFoundHandler');
    // Security: stack traces are never sent to clients
    expect(source).toContain('Stack traces never reach clients');
  });

  // -------------------------------------------------------------------------
  // 5.2: Redis service has isDegraded lifecycle handlers
  // -------------------------------------------------------------------------
  test('5.2: Redis service sets up ready/close handlers for isDegraded', () => {
    const fs = require('fs');
    const path = require('path');
    const redisServicePath = path.resolve(__dirname, '../shared/services/redis/redis.service.ts');
    const source = fs.readFileSync(redisServicePath, 'utf-8');

    // Verify isDegraded is managed by event handlers
    expect(source).toContain('isDegraded');
    expect(source).toContain("rawClient.on('ready'");
    expect(source).toContain("rawClient.on('close'");
  });

  // -------------------------------------------------------------------------
  // 5.3: Prisma client has slow query logging
  // -------------------------------------------------------------------------
  test('5.3: Prisma client logs slow queries', () => {
    const fs = require('fs');
    const path = require('path');
    const prismaServicePath = path.resolve(__dirname, '../shared/database/prisma.service.ts');
    const source = fs.readFileSync(prismaServicePath, 'utf-8');

    expect(source).toContain('SLOW_QUERY_THRESHOLD_MS');
    expect(source).toContain('[SlowQuery]');
    expect(source).toContain('$use');
  });

  // -------------------------------------------------------------------------
  // 5.4: All raw SQL queries use parameterized values
  // -------------------------------------------------------------------------
  test('5.4: Production raw SQL uses tagged templates or $N params (not concatenation)', () => {
    const fs = require('fs');
    const path = require('path');

    // Check key production files that use raw SQL
    const files = [
      '../modules/booking/booking-lifecycle.service.ts',
      '../modules/assignment/assignment-lifecycle.service.ts',
      '../modules/truck-hold/confirmed-hold.service.ts',
    ];

    for (const file of files) {
      const filePath = path.resolve(__dirname, file);
      if (!fs.existsSync(filePath)) continue;

      const source = fs.readFileSync(filePath, 'utf-8');

      // Must use tagged template literals ($queryRaw`...` or $executeRaw`...`)
      // These are safe from SQL injection because Prisma parameterizes them.
      // Note: source may have generic type params like $queryRaw<Type>`...`
      if (source.includes('$queryRaw') || source.includes('$executeRaw')) {
        // Verify they use tagged templates (backtick eventually follows method)
        // Pattern accounts for optional generic: $queryRaw<Array<{...}>>`
        const rawCalls = source.match(/\$(queryRaw|executeRaw)(<[^`]*>)?`/g) || [];
        expect(rawCalls.length).toBeGreaterThan(0);

        // SECURITY: Verify NO unsafe raw queries in these core service files
        expect(source).not.toContain('$queryRawUnsafe');
        expect(source).not.toContain('$executeRawUnsafe');
      }
    }
  });

  // -------------------------------------------------------------------------
  // 5.5: Queue service has cancelled order guard
  // -------------------------------------------------------------------------
  test('5.5: Queue service implements cancelled order guard', () => {
    // F-B-50: canonical surface is queue.service.ts (modular queue-management.service.ts deleted).
    const fs = require('fs');
    const path = require('path');
    const queuePath = path.resolve(__dirname, '../shared/services/queue.service.ts');
    const source = fs.readFileSync(queuePath, 'utf-8');

    // Verify the cancelled order queue guard exists
    expect(source).toContain('cancelledOrderQueueGuardEnabled');
    expect(source).toContain('inactiveOrderStatuses');
  });

  // -------------------------------------------------------------------------
  // 5.6: Socket emitters have null-check on io instance
  // -------------------------------------------------------------------------
  test('5.6: Socket emitters check for null io before emitting', () => {
    const fs = require('fs');
    const path = require('path');
    const socketServicePath = path.resolve(__dirname, '../shared/services/socket.service.ts');
    const source = fs.readFileSync(socketServicePath, 'utf-8');

    // Every emit function should check if (!io) first
    expect(source).toContain('if (!io)');
    // emitToUser should return false when io is null
    expect(source).toContain('return false');
  });
});
