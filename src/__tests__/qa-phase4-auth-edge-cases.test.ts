/**
 * =============================================================================
 * QA Phase 4 -- Auth Edge Cases
 * =============================================================================
 *
 * Tests covering edge cases for the following Phase 1 auth fixes:
 *
 *   M1 -- Redis-down cooldown check fails-open  (auth.service.ts:122)
 *   M3 -- CORS allows X-Device-Id and X-Idempotency-Key  (server.ts:264)
 *   M4 -- JTI blacklist catch logs warning  (auth.middleware.ts:100)
 *   H1 -- In-TX duplicate returns AppError(409) not plain Error  (order.service.ts:1150)
 *
 * Each section combines source-scanning assertions (read the file, verify
 * patterns) with behavioural tests (mock Redis, assert middleware behaviour).
 *
 * =============================================================================
 */

export {};

import * as fs from 'fs';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------
const TEST_JWT_SECRET = 'test-jwt-secret-auth-security';

// ---------------------------------------------------------------------------
// Mocks -- keep in sync with auth-security-fixes.test.ts
// ---------------------------------------------------------------------------

const mockRedisExists = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisGetJSON = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisSAdd = jest.fn();
const mockRedisSRem = jest.fn();
const mockRedisSMembers = jest.fn();
const mockRedisSetJSON = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisIncrementWithTTL = jest.fn();
const mockRedisTtl = jest.fn();
const mockRedisIncrBy = jest.fn();

jest.mock('../../src/shared/services/redis.service', () => ({
  redisService: {
    exists: (...args: unknown[]) => mockRedisExists(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
    getJSON: (...args: unknown[]) => mockRedisGetJSON(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    sAdd: (...args: unknown[]) => mockRedisSAdd(...args),
    sRem: (...args: unknown[]) => mockRedisSRem(...args),
    sMembers: (...args: unknown[]) => mockRedisSMembers(...args),
    setJSON: (...args: unknown[]) => mockRedisSetJSON(...args),
    expire: (...args: unknown[]) => mockRedisExpire(...args),
    incrementWithTTL: (...args: unknown[]) => mockRedisIncrementWithTTL(...args),
    ttl: (...args: unknown[]) => mockRedisTtl(...args),
    incrBy: (...args: unknown[]) => mockRedisIncrBy(...args),
  },
}));

jest.mock('../../src/shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
    incrementGauge: jest.fn(),
    decrementGauge: jest.fn(),
  },
}));

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock('../../src/shared/services/logger.service', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/config/environment', () => ({
  config: {
    jwt: {
      secret: 'test-jwt-secret-auth-security',
      expiresIn: '5m',
      refreshSecret: 'test-refresh-secret-auth-security',
      refreshExpiresIn: '30d',
    },
    otp: {
      expiryMinutes: 5,
      length: 6,
      maxAttempts: 3,
    },
    sms: {
      provider: 'console',
      retrieverHash: '',
      twilio: { accountSid: '', authToken: '', phoneNumber: '' },
      msg91: { authKey: '', senderId: '', templateId: '' },
      awsSns: { region: 'ap-south-1', accessKeyId: '', secretAccessKey: '' },
    },
    redis: { enabled: false, url: '' },
    isProduction: false,
    isDevelopment: true,
    isTest: true,
    nodeEnv: 'test',
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    userId: 'user-qa-phase4',
    role: 'customer',
    phone: '9876543210',
    jti: crypto.randomUUID(),
    ...overrides,
  };
  return jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

function mockRequest(headers: Record<string, string> = {}): Partial<Request> {
  return { headers: { ...headers }, path: '/test' } as Partial<Request>;
}

function mockResponse(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ---------------------------------------------------------------------------
// Read source files once (shared across describe blocks)
// ---------------------------------------------------------------------------
const SRC_ROOT = path.resolve(__dirname, '..');

const authServiceSource = fs.readFileSync(
  path.join(SRC_ROOT, 'modules/auth/auth.service.ts'),
  'utf-8'
);
const serverSource = fs.readFileSync(
  path.join(SRC_ROOT, '..', 'src', 'server.ts'),
  'utf-8'
);
const authMiddlewareSource = fs.readFileSync(
  path.join(SRC_ROOT, 'shared/middleware/auth.middleware.ts'),
  'utf-8'
);
const orderServiceSource = fs.readFileSync(
  path.join(SRC_ROOT, 'modules/order/order.service.ts'),
  'utf-8'
);

// ==========================================================================
// TOP-LEVEL DESCRIBE
// ==========================================================================
describe('QA Phase 4 — Auth Edge Cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // M1 — Cooldown fail-open when Redis is down
  // ========================================================================
  describe('M1 — Cooldown fail-open', () => {
    // --- Source scanning ---

    it('M1.1 sendOtp wraps cooldown check in try-catch', () => {
      // The cooldown check (redisService.exists) must be inside a try-catch
      // that allows OTP sending to proceed when Redis is unavailable.
      const sendOtpStart = authServiceSource.indexOf('async sendOtp(');
      const sendOtpBody = authServiceSource.substring(sendOtpStart, sendOtpStart + 800);
      // Must have try around cooldownKey check
      expect(sendOtpBody).toContain('try {');
      expect(sendOtpBody).toContain('exists(cooldownKey)');
    });

    it('M1.2 catch block logs warning with "Cooldown check failed-open"', () => {
      const sendOtpStart = authServiceSource.indexOf('async sendOtp(');
      const sendOtpBody = authServiceSource.substring(sendOtpStart, sendOtpStart + 800);
      expect(sendOtpBody).toContain('Cooldown check failed-open');
    });

    it('M1.3 catch block does NOT rethrow (fail-open behaviour)', () => {
      // After the catch block that mentions "failed-open", there should be
      // no `throw` inside that catch -- execution continues to `if (cooldownActive)`.
      const sendOtpStart = authServiceSource.indexOf('async sendOtp(');
      const body = authServiceSource.substring(sendOtpStart, sendOtpStart + 800);

      // Extract the catch block that logs "Cooldown check failed-open"
      const catchIdx = body.indexOf('Cooldown check failed-open');
      // Walk backward to find the opening of the catch block
      const catchStart = body.lastIndexOf('catch', catchIdx);
      // Find the closing brace of the catch block
      const catchEnd = body.indexOf('}', catchIdx);
      const catchBlock = body.substring(catchStart, catchEnd + 1);

      expect(catchBlock).not.toContain('throw');
    });

    it('M1.4 cooldownActive defaults to false before the try block', () => {
      // The variable must be initialized to false so that when Redis throws,
      // the subsequent `if (cooldownActive)` check does NOT block the OTP send.
      const sendOtpStart = authServiceSource.indexOf('async sendOtp(');
      const body = authServiceSource.substring(sendOtpStart, sendOtpStart + 600);
      expect(body).toContain('let cooldownActive = false');
    });

    it('M1.5 when cooldownActive is true, throws 429 OTP_COOLDOWN', () => {
      expect(authServiceSource).toMatch(/AppError\(429.*OTP_COOLDOWN/);
      expect(authServiceSource).toContain('Please wait 30 seconds');
    });

    it('M1.6 cooldown TTL is 30 seconds', () => {
      expect(authServiceSource).toMatch(/set\(cooldownKey,\s*'1',\s*30\)/);
    });

    it('M1.7 cooldown check is phone+role scoped', () => {
      expect(authServiceSource).toContain('`otp:cooldown:${phone}:${role}`');
    });

    // --- Behavioural tests (via auth middleware proxy -- tests fail-open at middleware layer) ---

    it('M1.8 authMiddleware: Redis.exists() throws -> request proceeds (fail-open)', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const token = generateToken();
      const req = mockRequest({ authorization: `Bearer ${token}` });
      const res = mockResponse();
      const next = jest.fn();

      // Redis throws ECONNREFUSED
      mockRedisExists.mockRejectedValue(new Error('ECONNREFUSED'));

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      // Fail-open: next() called with no error, user is set
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeUndefined();
      expect((req as any).user).toBeDefined();
    });

    it('M1.9 authMiddleware: Redis.exists() returns true for blacklisted JTI -> 401', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const jti = crypto.randomUUID();
      const token = generateToken({ jti });
      const req = mockRequest({ authorization: `Bearer ${token}` });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockResolvedValue(true); // blacklisted

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeDefined();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('TOKEN_REVOKED');
    });

    it('M1.10 authMiddleware: Redis.exists() returns false -> request proceeds normally', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const token = generateToken();
      const req = mockRequest({ authorization: `Bearer ${token}` });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockResolvedValue(false);

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeUndefined();
      expect((req as any).user).toBeDefined();
      expect((req as any).user.userId).toBe('user-qa-phase4');
    });

    it('M1.11 authMiddleware: JTI blacklist check logs warning on Redis failure', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const jti = crypto.randomUUID();
      const token = generateToken({ jti });
      const req = mockRequest({ authorization: `Bearer ${token}` });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockRejectedValue(new Error('Redis timeout'));

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      // Should have logged a warning about the failed blacklist check
      expect(mockLoggerWarn).toHaveBeenCalled();
      const warnArgs = mockLoggerWarn.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('blacklist')
      );
      expect(warnArgs).toBeTruthy();
    });
  });

  // ========================================================================
  // M3 — CORS allows X-Device-Id and X-Idempotency-Key
  // ========================================================================
  describe('M3 — CORS headers', () => {
    it('M3.1 allowedHeaders array contains X-Device-Id', () => {
      expect(serverSource).toContain("'X-Device-Id'");
    });

    it('M3.2 allowedHeaders array contains X-Idempotency-Key', () => {
      expect(serverSource).toContain("'X-Idempotency-Key'");
    });

    it('M3.3 allowedHeaders still contains Content-Type', () => {
      expect(serverSource).toContain("'Content-Type'");
    });

    it('M3.4 allowedHeaders still contains Authorization', () => {
      expect(serverSource).toContain("'Authorization'");
    });

    it('M3.5 allowedHeaders still contains X-Request-ID', () => {
      expect(serverSource).toContain("'X-Request-ID'");
    });

    it('M3.6 CORS configuration uses cors() middleware', () => {
      expect(serverSource).toContain('app.use(cors(');
    });

    it('M3.7 X-Device-Id and X-Idempotency-Key are in the same allowedHeaders array', () => {
      // Find the allowedHeaders array block and verify both headers are inside it
      const headersStart = serverSource.indexOf('allowedHeaders:');
      expect(headersStart).toBeGreaterThan(-1);
      // Get the block between allowedHeaders: [ ... ]
      const bracketStart = serverSource.indexOf('[', headersStart);
      const bracketEnd = serverSource.indexOf(']', bracketStart);
      const headersBlock = serverSource.substring(bracketStart, bracketEnd + 1);

      expect(headersBlock).toContain('X-Device-Id');
      expect(headersBlock).toContain('X-Idempotency-Key');
    });

    it('M3.8 credentials is true for CORS', () => {
      const corsStart = serverSource.indexOf('app.use(cors(');
      const corsBlock = serverSource.substring(corsStart, corsStart + 600);
      expect(corsBlock).toContain('credentials: true');
    });

    it('M3.9 preflight cache maxAge is set', () => {
      const corsStart = serverSource.indexOf('app.use(cors(');
      const corsBlock = serverSource.substring(corsStart, corsStart + 600);
      expect(corsBlock).toContain('maxAge:');
    });

    it('M3.10 CORS allows standard HTTP methods', () => {
      const corsStart = serverSource.indexOf('app.use(cors(');
      const corsBlock = serverSource.substring(corsStart, corsStart + 600);
      expect(corsBlock).toContain('GET');
      expect(corsBlock).toContain('POST');
      expect(corsBlock).toContain('PUT');
      expect(corsBlock).toContain('DELETE');
    });
  });

  // ========================================================================
  // M4 — JTI blacklist catch logs warning
  // ========================================================================
  describe('M4 — JTI blacklist logging', () => {
    it('M4.1 authMiddleware catch block includes logger.warn for blacklist failure', () => {
      // The catch block around the JTI blacklist check must call logger.warn
      const jtiSection = authMiddlewareSource.indexOf('blacklist:${decoded.jti}');
      expect(jtiSection).toBeGreaterThan(-1);

      // Get the surrounding try/catch block (up to 600 chars after to cover fail-closed branch + fail-open branch)
      const surroundingBlock = authMiddlewareSource.substring(jtiSection, jtiSection + 600);
      expect(surroundingBlock).toContain('logger.warn');
    });

    it('M4.2 warning log includes jti field', () => {
      const catchStart = authMiddlewareSource.indexOf('JTI blacklist check failed-open');
      expect(catchStart).toBeGreaterThan(-1);

      const logBlock = authMiddlewareSource.substring(catchStart, catchStart + 200);
      expect(logBlock).toContain('jti:');
    });

    it('M4.3 warning log includes userId field', () => {
      const catchStart = authMiddlewareSource.indexOf('JTI blacklist check failed-open');
      expect(catchStart).toBeGreaterThan(-1);

      const logBlock = authMiddlewareSource.substring(catchStart, catchStart + 200);
      expect(logBlock).toContain('userId:');
    });

    it('M4.4 warning log includes path field', () => {
      const catchStart = authMiddlewareSource.indexOf('JTI blacklist check failed-open');
      expect(catchStart).toBeGreaterThan(-1);

      const logBlock = authMiddlewareSource.substring(catchStart, catchStart + 200);
      expect(logBlock).toContain('path:');
    });

    it('M4.5 log message text is "[Auth] JTI blacklist check failed-open"', () => {
      expect(authMiddlewareSource).toContain('[Auth] JTI blacklist check failed-open');
    });

    it('M4.6 fail-open: request proceeds even when Redis is down for JTI check', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const jti = crypto.randomUUID();
      const token = generateToken({ jti });
      const req = mockRequest({ authorization: `Bearer ${token}` });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockRejectedValue(new Error('ECONNREFUSED'));

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      // User should be set (fail-open)
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeUndefined();
      expect((req as any).user).toBeDefined();
      expect((req as any).user.jti).toBe(jti);
    });

    it('M4.7 optionalAuthMiddleware treats Redis failure as unauthenticated (fail-closed)', async () => {
      const { optionalAuthMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const token = generateToken();
      const req = mockRequest({ authorization: `Bearer ${token}` });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockRejectedValue(new Error('Redis down'));

      await optionalAuthMiddleware(req as Request, res as Response, next as NextFunction);

      // optionalAuth should NOT set user when Redis fails
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeUndefined();
      expect((req as any).user).toBeUndefined();
    });

    it('M4.8 authMiddleware vs optionalAuth differ in fail behaviour', () => {
      // authMiddleware: catch block has logger.warn and continues (fail-open)
      // optionalAuth: catch block returns without setting user (fail-closed for user)
      const authFn = authMiddlewareSource.indexOf('async function authMiddleware');
      const optionalFn = authMiddlewareSource.indexOf('async function optionalAuthMiddleware');

      expect(authFn).toBeGreaterThan(-1);
      expect(optionalFn).toBeGreaterThan(-1);

      // authMiddleware has logger.warn in its JTI catch block
      const authBody = authMiddlewareSource.substring(authFn, optionalFn);
      expect(authBody).toContain('logger.warn');
      expect(authBody).toContain('JTI blacklist check failed-open');

      // optionalAuth JTI catch just returns (no warn needed, user simply not set)
      const optionalBody = authMiddlewareSource.substring(optionalFn);
      const optionalJtiCatch = optionalBody.indexOf('catch');
      const optionalCatchBlock = optionalBody.substring(optionalJtiCatch, optionalJtiCatch + 400);
      // Should contain next() or return to allow request to pass through
      expect(optionalCatchBlock).toContain('next()');
    });
  });

  // ========================================================================
  // H1 — In-TX duplicate returns AppError(409) not plain Error
  // ========================================================================
  describe('H1 — In-TX duplicate 409', () => {
    it('H1.1 in-TX duplicate check throws AppError(409, "ACTIVE_ORDER_EXISTS")', () => {
      // The line around ~1150 must use AppError, not plain Error
      const txSection = orderServiceSource.indexOf('withDbTimeout(async (tx)');
      expect(txSection).toBeGreaterThan(-1);

      const txBody = orderServiceSource.substring(txSection, txSection + 600);
      // Must find AppError(409 inside the transaction block
      expect(txBody).toMatch(/AppError\(409.*ACTIVE_ORDER_EXISTS/);
    });

    it('H1.2 in-TX duplicate check is NOT a plain Error', () => {
      const txSection = orderServiceSource.indexOf('withDbTimeout(async (tx)');
      const txBody = orderServiceSource.substring(txSection, txSection + 600);

      // Find the duplicate throw line
      const dupThrowIdx = txBody.indexOf('throw new');
      const dupThrowLine = txBody.substring(dupThrowIdx, dupThrowIdx + 100);

      // It should throw AppError, not plain Error
      expect(dupThrowLine).toContain('AppError');
      expect(dupThrowLine).not.toMatch(/throw new Error\(/);
    });

    it('H1.3 pre-TX Redis check at line ~735 also uses AppError(409)', () => {
      // The Redis-based check before the lock acquisition
      const redisCheckIdx = orderServiceSource.indexOf('customer:active-broadcast:');
      expect(redisCheckIdx).toBeGreaterThan(-1);

      const blockAfterRedisCheck = orderServiceSource.substring(redisCheckIdx, redisCheckIdx + 500);
      expect(blockAfterRedisCheck).toMatch(/AppError\(409.*ACTIVE_ORDER_EXISTS/);
    });

    it('H1.4 pre-TX DB check at line ~753 also uses AppError(409)', () => {
      // After the lock is acquired, DB authoritative check also throws AppError(409)
      const dbCheckIdx = orderServiceSource.indexOf('DB authoritative check');
      expect(dbCheckIdx).toBeGreaterThan(-1);

      // Widen the window to capture the throw statement after both findFirst calls
      const blockAfterDbCheck = orderServiceSource.substring(dbCheckIdx, dbCheckIdx + 800);
      expect(blockAfterDbCheck).toMatch(/AppError\(409.*ACTIVE_ORDER_EXISTS/);
    });

    it('H1.5 all three duplicate checks use the same error code "ACTIVE_ORDER_EXISTS"', () => {
      // Count occurrences of AppError(409, 'ACTIVE_ORDER_EXISTS' in order.service.ts
      const matches = orderServiceSource.match(/AppError\(409,\s*'ACTIVE_ORDER_EXISTS'/g);
      // Should have at least 3: Redis guard, DB guard, in-TX guard
      expect(matches).toBeTruthy();
      expect(matches!.length).toBeGreaterThanOrEqual(3);
    });

    it('H1.6 in-TX check queries both Booking and Order tables', () => {
      const txSection = orderServiceSource.indexOf('withDbTimeout(async (tx)');
      const txBody = orderServiceSource.substring(txSection, txSection + 400);

      expect(txBody).toContain('tx.booking.findFirst');
      expect(txBody).toContain('tx.order.findFirst');
    });

    it('H1.7 in-TX check filters by active statuses only', () => {
      const txSection = orderServiceSource.indexOf('withDbTimeout(async (tx)');
      const txBody = orderServiceSource.substring(txSection, txSection + 400);

      // Both queries should filter by active-like statuses
      expect(txBody).toContain('created');
      expect(txBody).toContain('broadcasting');
      expect(txBody).toContain('active');
      expect(txBody).toContain('partially_filled');
    });

    it('H1.8 transaction uses Serializable isolation level', () => {
      // Serializable isolation prevents phantom reads that would let two
      // concurrent requests both pass the duplicate check.
      const txCallIdx = orderServiceSource.indexOf('withDbTimeout(async (tx)');
      const txCallEnd = orderServiceSource.indexOf('}, {', txCallIdx);
      const isolationBlock = orderServiceSource.substring(txCallEnd, txCallEnd + 200);
      expect(isolationBlock).toContain('Serializable');
    });

    it('H1.9 pre-TX Redis check, DB check, and in-TX check all have status 409', () => {
      // Verify consistency: all three layers return HTTP 409
      const lines = orderServiceSource.split('\n');
      const activeOrderLines = lines.filter(
        (line: string) => line.includes('ACTIVE_ORDER_EXISTS') && line.includes('AppError')
      );

      for (const line of activeOrderLines) {
        expect(line).toContain('409');
      }
    });

    it('H1.10 lock contention also returns 409 (not 500)', () => {
      // The lock acquisition failure should also be a 409, not a 500
      expect(orderServiceSource).toMatch(/AppError\(409.*LOCK_CONTENTION/);
    });
  });

  // ========================================================================
  // Cross-cutting: Source structure consistency
  // ========================================================================
  describe('Cross-cutting: Source structure consistency', () => {
    it('CC.1 authMiddleware is an async function', () => {
      expect(authMiddlewareSource).toMatch(/async function authMiddleware/);
    });

    it('CC.2 optionalAuthMiddleware is an async function', () => {
      expect(authMiddlewareSource).toMatch(/async function optionalAuthMiddleware/);
    });

    it('CC.3 isValidJwtPayload type guard includes deviceId? field', () => {
      expect(authMiddlewareSource).toContain('deviceId?');
    });

    it('CC.4 authMiddleware uses HS256 algorithm restriction', () => {
      expect(authMiddlewareSource).toContain("algorithms: ['HS256']");
    });

    it('CC.5 server.ts CORS block does not use wildcard in production', () => {
      // The server has logic to block wildcard CORS in production
      expect(serverSource).toContain("config.cors.origin === '*' && config.isProduction");
    });

    it('CC.6 server.ts registers requestIdMiddleware before CORS', () => {
      const requestIdIdx = serverSource.indexOf('app.use(requestIdMiddleware)');
      const corsIdx = serverSource.indexOf('app.use(cors(');
      expect(requestIdIdx).toBeGreaterThan(-1);
      expect(corsIdx).toBeGreaterThan(-1);
      expect(requestIdIdx).toBeLessThan(corsIdx);
    });
  });
});
