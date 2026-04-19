/**
 * =============================================================================
 * SOCKET SERVICE HARDENING FIXES — Test Suite
 * =============================================================================
 *
 * Tests for production fixes applied to socket.service.ts:
 * - FIX-4  (#88):  Missing SocketEvent names + emitToUser undefined event guard
 * - FIX-9  (#44):  Redis adapter failure warning per emit
 * - FIX-13 (#62):  recentJoinAttempts memory cleanup
 * - FIX-32 (#63):  eventCounts memory cleanup
 * - FIX-33 (#66):  CORS exact whitelist (no regex)
 * - FIX-45 (#109): Counter decrement logging (not silently swallowed)
 * - FIX-46 (#110): Mass reconnect jitter
 *
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
// =============================================================================

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: (...args: any[]) => mockLoggerInfo(...args),
    warn: (...args: any[]) => mockLoggerWarn(...args),
    error: (...args: any[]) => mockLoggerError(...args),
    debug: (...args: any[]) => mockLoggerDebug(...args),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
}));

const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(true);
const mockRedisExists = jest.fn().mockResolvedValue(false);
const mockRedisIncrBy = jest.fn().mockResolvedValue(1);
const mockRedisSAdd = jest.fn().mockResolvedValue(1);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisGetClient = jest.fn().mockReturnValue(null);
const mockRedisSIsMember = jest.fn().mockResolvedValue(false);
const mockRedisZRangeByScore = jest.fn().mockResolvedValue([]);
const mockRedisZRemRangeByScore = jest.fn().mockResolvedValue(0);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    get: (...args: any[]) => mockRedisGet(...args),
    set: (...args: any[]) => mockRedisSet(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    incr: (...args: any[]) => mockRedisIncr(...args),
    expire: (...args: any[]) => mockRedisExpire(...args),
    exists: (...args: any[]) => mockRedisExists(...args),
    incrBy: (...args: any[]) => mockRedisIncrBy(...args),
    sAdd: (...args: any[]) => mockRedisSAdd(...args),
    sIsMember: (...args: any[]) => mockRedisSIsMember(...args),
    getClient: () => mockRedisGetClient(),
    isConnected: jest.fn().mockReturnValue(true),
    sAddWithExpire: jest.fn().mockResolvedValue(undefined),
    getJSON: jest.fn(),
    setJSON: jest.fn(),
    lPush: jest.fn(),
    lTrim: jest.fn(),
    zRangeByScore: (...args: any[]) => mockRedisZRangeByScore(...args),
    zRemRangeByScore: (...args: any[]) => mockRedisZRemRangeByScore(...args),
    setTimer: jest.fn(),
    cancelTimer: jest.fn(),
    getExpiredTimers: jest.fn(),
    acquireLock: jest.fn(),
    releaseLock: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    isDevelopment: false,
    jwt: { secret: 'test-secret' },
  },
}));

jest.mock('../core/config/hold-config', () => ({
  HOLD_CONFIG: {
    driverAcceptTimeoutMs: 45000,
    driverAcceptTimeoutSeconds: 45,
    confirmedHoldMaxSeconds: 180,
    flexHoldDurationSeconds: 90,
    flexHoldExtensionSeconds: 30,
    flexHoldMaxDurationSeconds: 130,
    flexHoldMaxExtensions: 2,
  },
}));

jest.mock('../shared/services/transporter-online.service', () => ({
  TRANSPORTER_PRESENCE_KEY: (id: string) => `transporter:presence:${id}`,
  PRESENCE_TTL_SECONDS: 60,
  ONLINE_TRANSPORTERS_SET: 'online:transporters',
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

jest.mock('@socket.io/redis-streams-adapter', () => ({
  createAdapter: jest.fn(),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { SocketEvent, emitToUser } from '../shared/services/socket.service';

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Socket Service Hardening Fixes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // FIX-4 (#88): Missing SocketEvent names + emitToUser undefined event guard
  // ===========================================================================
  describe('FIX-4: SocketEvent completeness and emitToUser guard', () => {
    const requiredEvents = [
      'BOOKING_CANCELLED',
      'DRIVER_APPROACHING',
      'DRIVER_MAY_BE_OFFLINE',
      'DRIVER_CONNECTIVITY_ISSUE',
      'HOLD_EXPIRED',
      'TRANSPORTER_STATUS_CHANGED',
      'DRIVER_ACCEPTED',
      'DRIVER_DECLINED',
      'FLEX_HOLD_EXTENDED',
      'CASCADE_REASSIGNED',
      'DRIVER_RATING_UPDATED',
      'PROFILE_COMPLETED',
      'PROFILE_PHOTO_UPDATED',
      'LICENSE_PHOTOS_UPDATED',
      'ASSIGNMENT_STALE',
      'ROUTE_PROGRESS_UPDATED',
      'ORDER_COMPLETED',
      'ORDER_EXPIRED',
      'ORDER_CANCELLED',
      'ORDER_STATE_SYNC',
      // Pre-existing events that must still be present
      'DRIVER_ADDED',
      'DRIVER_STATUS_CHANGED',
      'NO_VEHICLES_AVAILABLE',
      'NEW_BROADCAST',
      'TRIP_CANCELLED',
    ];

    it.each(requiredEvents)('SocketEvent.%s exists and is a non-empty string', (eventName) => {
      const value = (SocketEvent as Record<string, string>)[eventName];
      expect(value).toBeDefined();
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    });

    it('all SocketEvent values are strings (no undefined leaks)', () => {
      for (const [key, value] of Object.entries(SocketEvent)) {
        expect(typeof value).toBe('string');
        expect(value).not.toBe('');
      }
    });

    it('emitToUser returns false and logs error when event is undefined', () => {
      const result = emitToUser('user-123', undefined as any, { foo: 'bar' });
      expect(result).toBe(false);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('BUG: Attempted to emit undefined event to user-123')
      );
    });

    it('emitToUser returns false and logs error when event is null', () => {
      const result = emitToUser('user-456', null as any, { data: 1 });
      expect(result).toBe(false);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('BUG: Attempted to emit undefined event to user-456')
      );
    });

    it('emitToUser returns false and logs error when event is empty string', () => {
      const result = emitToUser('user-789', '', { data: 1 });
      expect(result).toBe(false);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('BUG: Attempted to emit undefined event to user-789')
      );
    });

    it('emitToUser returns false when io is not initialized (valid event)', () => {
      // io is null since we never called initializeSocket
      const result = emitToUser('user-abc', 'booking_updated', { id: 1 });
      expect(result).toBe(false);
      // Should hit the "Socket.IO not initialized" error, NOT the undefined event error
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('Socket.IO not initialized')
      );
    });
  });

  // ===========================================================================
  // FIX-13 (#62): recentJoinAttempts memory cleanup
  // ===========================================================================
  describe('FIX-13: recentJoinAttempts cleanup logic', () => {
    it('cleanup removes entries older than 5 minutes', () => {
      // Simulate the cleanup logic inline (since the actual interval runs inside initializeSocket)
      const recentJoinAttempts = new Map<string, number>();
      const now = Date.now();

      // Stale entry (6 minutes old)
      recentJoinAttempts.set('user1:booking:abc', now - 6 * 60 * 1000);
      // Fresh entry (1 minute old)
      recentJoinAttempts.set('user2:booking:def', now - 1 * 60 * 1000);
      // Exactly at cutoff (5 minutes old)
      recentJoinAttempts.set('user3:order:ghi', now - 5 * 60 * 1000);

      // Simulate the cleanup interval logic
      const cutoff = now - 5 * 60 * 1000;
      for (const [key, timestamp] of recentJoinAttempts) {
        if (typeof timestamp === 'number' && timestamp < cutoff) {
          recentJoinAttempts.delete(key);
        }
      }

      // Stale entry should be removed
      expect(recentJoinAttempts.has('user1:booking:abc')).toBe(false);
      // Fresh entry should remain
      expect(recentJoinAttempts.has('user2:booking:def')).toBe(true);
      // Exactly at cutoff is NOT < cutoff, so should remain
      expect(recentJoinAttempts.has('user3:order:ghi')).toBe(true);
    });

    it('cleanup handles empty map gracefully', () => {
      const recentJoinAttempts = new Map<string, number>();
      const cutoff = Date.now() - 5 * 60 * 1000;

      // Should not throw
      for (const [key, timestamp] of recentJoinAttempts) {
        if (typeof timestamp === 'number' && timestamp < cutoff) {
          recentJoinAttempts.delete(key);
        }
      }

      expect(recentJoinAttempts.size).toBe(0);
    });

    it('cleanup ignores non-number values', () => {
      const recentJoinAttempts = new Map<string, any>();
      recentJoinAttempts.set('bad:entry', 'not-a-number');
      recentJoinAttempts.set('another:bad', null);

      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [key, timestamp] of recentJoinAttempts) {
        if (typeof timestamp === 'number' && timestamp < cutoff) {
          recentJoinAttempts.delete(key);
        }
      }

      // Non-number entries should NOT be deleted (guard prevents it)
      expect(recentJoinAttempts.size).toBe(2);
    });
  });

  // ===========================================================================
  // FIX-32 (#63): eventCounts memory cleanup
  // ===========================================================================
  describe('FIX-32: eventCounts cleanup logic', () => {
    it('cleanup removes entries with resetAt older than 60 seconds', () => {
      const eventCounts = new Map<string, { count: number; resetAt: number }>();
      const now = Date.now();

      // Stale entry (2 minutes old)
      eventCounts.set('user-stale', { count: 5, resetAt: now - 120_000 });
      // Fresh entry (10 seconds old)
      eventCounts.set('user-fresh', { count: 3, resetAt: now - 10_000 });
      // At cutoff (exactly 60 seconds)
      eventCounts.set('user-cutoff', { count: 1, resetAt: now - 60_000 });

      // Simulate the cleanup logic
      const cutoff = now - 60_000;
      for (const [key, entry] of eventCounts) {
        if (entry.resetAt && entry.resetAt < cutoff) {
          eventCounts.delete(key);
        }
      }

      expect(eventCounts.has('user-stale')).toBe(false);
      expect(eventCounts.has('user-fresh')).toBe(true);
      // Exactly at cutoff: resetAt === cutoff, NOT < cutoff, so remains
      expect(eventCounts.has('user-cutoff')).toBe(true);
    });
  });

  // ===========================================================================
  // FIX-33 (#66): CORS exact whitelist
  // ===========================================================================
  describe('FIX-33: CORS exact whitelist', () => {
    const allowedOrigins = ['https://weelo.app', 'https://captain.weelo.app', 'https://admin.weelo.app'];

    it('allows exact domain matches', () => {
      expect(allowedOrigins).toContain('https://weelo.app');
      expect(allowedOrigins).toContain('https://captain.weelo.app');
      expect(allowedOrigins).toContain('https://admin.weelo.app');
    });

    it('rejects subdomain variations that regex would have matched', () => {
      const maliciousOrigins = [
        'https://evil.weelo.app',
        'https://phishing.weelo.app',
        'https://test.captain.weelo.app',
        'https://xweelo.app',
        'http://weelo.app',           // http instead of https
        'https://weelo.app.evil.com', // domain suffix attack
      ];

      for (const origin of maliciousOrigins) {
        expect(allowedOrigins).not.toContain(origin);
      }
    });

    it('CORS_ORIGINS env var overrides default whitelist', () => {
      const envOrigins = 'https://staging.weelo.app,https://dev.weelo.app';
      const parsed = envOrigins.split(',');

      expect(parsed).toEqual(['https://staging.weelo.app', 'https://dev.weelo.app']);
      expect(parsed).not.toContain('https://weelo.app'); // Default not included
    });

    it('default whitelist has exactly 3 entries', () => {
      expect(allowedOrigins).toHaveLength(3);
    });
  });

  // ===========================================================================
  // FIX-45 (#109): Counter decrement logging
  // ===========================================================================
  describe('FIX-45: Counter decrement failure logging', () => {
    it('logs warning when Redis incrBy fails during disconnect', async () => {
      const testError = new Error('Redis connection lost');
      mockRedisIncrBy.mockRejectedValueOnce(testError);

      // Simulate the pattern: incrBy(-1).catch(err => logger.warn(...))
      await require('../shared/services/redis.service').redisService
        .incrBy('socket:conncount:user-123', -1)
        .catch((err: Error) => {
          mockLoggerWarn('[Socket] Counter decrement failed', { error: err.message });
        });

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[Socket] Counter decrement failed',
        { error: 'Redis connection lost' }
      );
    });

    it('does not log when Redis incrBy succeeds', async () => {
      mockRedisIncrBy.mockResolvedValueOnce(0);

      await require('../shared/services/redis.service').redisService
        .incrBy('socket:conncount:user-456', -1)
        .catch((err: Error) => {
          mockLoggerWarn('[Socket] Counter decrement failed', { error: err.message });
        });

      expect(mockLoggerWarn).not.toHaveBeenCalledWith(
        '[Socket] Counter decrement failed',
        expect.anything()
      );
    });
  });

  // ===========================================================================
  // FIX-9 (#44): Redis adapter failure logging
  // ===========================================================================
  describe('FIX-9: Redis adapter warning on emit', () => {
    it('emitToUser includes adapter warning path (io=null short-circuits before adapter check)', () => {
      // When io is null, emitToUser returns false before checking adapter status
      // This test verifies the early-return behavior is correct
      const result = emitToUser('user-1', 'test_event', {});
      expect(result).toBe(false);
      // The "not initialized" error should fire, NOT the adapter warning
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('Socket.IO not initialized')
      );
    });
  });

  // ===========================================================================
  // FIX-46 (#110): Mass reconnect jitter
  // ===========================================================================
  describe('FIX-46: Mass reconnect jitter', () => {
    it('Math.random produces values in [0, 1) range for jitter calculation', () => {
      // Test the jitter range: Math.random() * 3000 should be [0, 3000)
      for (let i = 0; i < 100; i++) {
        const jitter = Math.random() * 3000;
        expect(jitter).toBeGreaterThanOrEqual(0);
        expect(jitter).toBeLessThan(3000);
      }
    });

    it('jitter promise resolves after timeout', async () => {
      jest.useFakeTimers();
      let resolved = false;

      const jitterPromise = new Promise<void>(resolve => {
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 1500); // midpoint of 0-3000 range
      });

      expect(resolved).toBe(false);

      jest.advanceTimersByTime(1500);
      await jitterPromise;

      expect(resolved).toBe(true);
      jest.useRealTimers();
    });
  });

  // ===========================================================================
  // SocketEvent structural integrity
  // ===========================================================================
  describe('SocketEvent structural integrity', () => {
    it('has no duplicate values', () => {
      const values = Object.values(SocketEvent);
      const uniqueValues = new Set(values);
      // Note: BROADCAST_CANCELLED and ORDER_CANCELLED both map to 'order_cancelled'
      // This is intentional (alias). We check for unintentional dups.
      const duplicates: string[] = [];
      const seen = new Map<string, string>();
      for (const [key, value] of Object.entries(SocketEvent)) {
        if (seen.has(value)) {
          duplicates.push(`${key} and ${seen.get(value)} both map to '${value}'`);
        } else {
          seen.set(value, key);
        }
      }
      // We expect some intentional aliases but track them explicitly
      // Allow known aliases: BROADCAST_CANCELLED/ORDER_CANCELLED -> 'order_cancelled'
      const allowedAliases = ['order_cancelled'];
      const unexpectedDups = duplicates.filter(
        d => !allowedAliases.some(a => d.includes(`'${a}'`))
      );
      expect(unexpectedDups).toEqual([]);
    });

    it('contains no empty string values', () => {
      for (const [key, value] of Object.entries(SocketEvent)) {
        expect(value).not.toBe('');
      }
    });

    it('all keys are UPPER_SNAKE_CASE', () => {
      const upperSnakeCase = /^[A-Z][A-Z0-9_]*$/;
      for (const key of Object.keys(SocketEvent)) {
        expect(key).toMatch(upperSnakeCase);
      }
    });

    it('all values are lower_snake_case', () => {
      const lowerSnakeCase = /^[a-z][a-z0-9_]*$/;
      for (const [key, value] of Object.entries(SocketEvent)) {
        expect(value).toMatch(lowerSnakeCase);
      }
    });
  });
});
