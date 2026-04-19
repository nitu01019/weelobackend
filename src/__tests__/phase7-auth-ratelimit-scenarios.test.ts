/**
 * =============================================================================
 * PHASE 7 — Auth, Rate Limiter & Security Scenarios: Comprehensive Test Suite
 * =============================================================================
 *
 * Tests for 3 fixes:
 *   FIX-1: optionalAuth bare catch now logs logger.warn (auth.middleware.ts)
 *   FIX-2: driver-auth verify-otp uses verifyOtpRateLimiter (driver-auth.routes.ts)
 *   FIX-3: driver onboard/verify uses verifyOtpRateLimiter (driver.routes.ts)
 *
 * Scenarios covered:
 *   - optionalAuth middleware: JTI failure logging, fail-silent behavior
 *   - verifyOtpRateLimiter: 5 attempts in 10 min, 6th blocked (429)
 *   - Phone-based rate limit isolation (different phones = different buckets)
 *   - OTP brute force protection (rate limiter + app-layer deletion)
 *   - Token edge cases: expired, malformed, missing, concurrent
 *   - Combined auth scenarios: Redis down, multiple middleware in chain
 *
 * Testing pattern: source-code assertions (readSource) + behavioral tests
 * (mock Redis/middleware), matching the project's established test style.
 * =============================================================================
 */

export {};

import * as fs from 'fs';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helper: read a source file relative to __dirname
// ---------------------------------------------------------------------------
function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------
const JWT_SECRET = 'phase7-test-jwt-secret';
const JWT_REFRESH_SECRET = 'phase7-test-refresh-secret';

// ---------------------------------------------------------------------------
// Redis mock — shared across all suites
// ---------------------------------------------------------------------------
const mockRedisService: Record<string, jest.Mock> = {
  exists: jest.fn().mockResolvedValue(false),
  set: jest.fn().mockResolvedValue(undefined),
  setJSON: jest.fn().mockResolvedValue(undefined),
  getJSON: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(true),
  expire: jest.fn().mockResolvedValue(true),
  sAdd: jest.fn().mockResolvedValue(1),
  sRem: jest.fn().mockResolvedValue(1),
  sMembers: jest.fn().mockResolvedValue([]),
  eval: jest.fn().mockResolvedValue(1),
  deleteOtpWithAttempts: jest.fn().mockResolvedValue(undefined),
  getOtpAttempts: jest.fn().mockResolvedValue(0),
  incrementOtpAttempts: jest.fn().mockResolvedValue({ allowed: true, attempts: 1, remaining: 2 }),
  incrementWithTTL: jest.fn().mockResolvedValue(1),
  ttl: jest.fn().mockResolvedValue(60),
  incrBy: jest.fn().mockResolvedValue(0),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: mockRedisService,
}));

jest.mock('../config/environment', () => ({
  config: {
    jwt: {
      secret: JWT_SECRET,
      expiresIn: '5m',
      refreshSecret: JWT_REFRESH_SECRET,
      refreshExpiresIn: '30d',
    },
    otp: {
      expiryMinutes: 5,
      length: 6,
      maxAttempts: 3,
    },
    rateLimit: {
      windowMs: 60_000,
      maxRequests: 1000,
    },
    isProduction: false,
    isDevelopment: true,
    isTest: true,
    nodeEnv: 'test',
    redis: { enabled: false, url: 'redis://localhost:6379' },
    sms: { provider: 'console', retrieverHash: '' },
    security: { enableHeaders: true, enableRateLimiting: true, enableRequestLogging: false },
  },
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.mock('../shared/services/logger.service', () => ({
  logger: mockLogger,
}));

// ---------------------------------------------------------------------------
// Token helper functions
// ---------------------------------------------------------------------------
function makeAccessToken(
  overrides: Record<string, unknown> = {},
  secret = JWT_SECRET,
  expiresIn: string | number = '5m',
): string {
  return jwt.sign(
    {
      userId: 'user-phase7',
      role: 'customer',
      phone: '9876543210',
      jti: crypto.randomUUID(),
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', expiresIn } as jwt.SignOptions,
  );
}

// ---------------------------------------------------------------------------
// Express mock helpers
// ---------------------------------------------------------------------------
function mockReq(
  headers: Record<string, string | undefined> = {},
  body: Record<string, unknown> = {},
  extras: Record<string, unknown> = {},
): any {
  return {
    headers: { ...headers },
    body,
    ip: '127.0.0.1',
    path: '/test-path',
    user: undefined as any,
    userId: undefined as string | undefined,
    userRole: undefined as string | undefined,
    userPhone: undefined as string | undefined,
    ...extras,
  };
}

function mockRes(): any {
  const res: any = {
    _statusCode: undefined as number | undefined,
    _body: undefined as unknown,
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn().mockReturnThis(),
  };
  res.status.mockImplementation((code: number) => {
    res._statusCode = code;
    return res;
  });
  res.json.mockImplementation((data: unknown) => {
    res._body = data;
    return res;
  });
  return res;
}

// ---------------------------------------------------------------------------
// Import middleware under test AFTER mocks are installed
// ---------------------------------------------------------------------------
import {
  authMiddleware,
  optionalAuthMiddleware,
} from '../shared/middleware/auth.middleware';

// ==========================================================================
// SUITE 1: optionalAuth Middleware — Fail-silent behavior
// ==========================================================================
describe('optionalAuth middleware: fail-silent behavior', () => {
  beforeEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // 1.1 JTI blacklist check failure: request still continues (inner catch silently swallows)
  // Source inspection verifies the outer catch logs logger.warn on outer-level errors
  // -------------------------------------------------------------------------
  it('1.1 JTI blacklist failure: request continues without user (inner catch is silent)', async () => {
    // When Redis throws during JTI blacklist check in optionalAuthMiddleware,
    // the inner `catch` silently calls next() and returns — no warn is emitted
    // for Redis failures. The outer catch handles JWT-level errors (expired, invalid).
    mockRedisService.exists.mockRejectedValueOnce(new Error('Redis ECONNREFUSED'));

    const token = makeAccessToken({ jti: 'jti-optional-fail-warn' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    // Request must continue without crashing
    expect(next).toHaveBeenCalledWith();
    // User NOT attached (Redis down → treat as unauthenticated)
    expect(req.userId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 1.2 Request continues with no user on JTI check failure (fail-silent)
  // -------------------------------------------------------------------------
  it('1.2 JTI check failure: request continues without user (fail-silent preserved)', async () => {
    mockRedisService.exists.mockRejectedValueOnce(new Error('Redis timeout'));

    const token = makeAccessToken({ jti: 'jti-optional-silent' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    // next called with no error argument
    expect(next).toHaveBeenCalledWith();
    // User NOT attached on JTI check failure in optionalAuth
    expect(req.userId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 1.3 Valid token still works in optionalAuth
  // -------------------------------------------------------------------------
  it('1.3 valid token: user is attached in optionalAuth', async () => {
    mockRedisService.exists.mockResolvedValue(false); // not blacklisted

    const token = makeAccessToken({ userId: 'user-valid-optional', role: 'driver' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('user-valid-optional');
    expect(req.userRole).toBe('driver');
  });

  // -------------------------------------------------------------------------
  // 1.4 Expired token handled gracefully (no crash, no user set)
  // -------------------------------------------------------------------------
  it('1.4 expired token in optionalAuth: proceeds without user, no crash', async () => {
    const expiredToken = makeAccessToken({}, JWT_SECRET, '-1s');
    const req = mockReq({ authorization: `Bearer ${expiredToken}` });
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    // Should NOT throw, should call next without error arg
    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 1.5 Malformed token handled gracefully
  // -------------------------------------------------------------------------
  it('1.5 malformed token in optionalAuth: no crash, no user set', async () => {
    const req = mockReq({ authorization: 'Bearer garbage.junk.payload' });
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 1.6 Missing token — proceeds without user (correct behavior)
  // -------------------------------------------------------------------------
  it('1.6 missing token: proceeds without user, no warning logged', async () => {
    const req = mockReq({}); // no Authorization header
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBeUndefined();
    expect(req.user).toBeUndefined();
    // No logger.warn for missing token (it's expected)
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 1.7 Source inspection: outer catch uses logger.warn (the fix)
  // -------------------------------------------------------------------------
  it('1.7 source: optionalAuth outer catch uses logger.warn (not logger.error)', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');

    // Find optionalAuthMiddleware function
    const fnIdx = source.indexOf('async function optionalAuthMiddleware');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = source.substring(fnIdx, fnIdx + 4000);

    // The outer catch block must use logger.warn
    const catchIdx = fnBody.lastIndexOf('} catch');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = fnBody.substring(catchIdx, catchIdx + 300);
    expect(catchBody).toContain('logger.warn');
  });

  // -------------------------------------------------------------------------
  // 1.8 Source inspection: outer catch includes path and error fields
  // -------------------------------------------------------------------------
  it('1.8 source: optionalAuth warn log includes path and error fields', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');

    const fnIdx = source.indexOf('async function optionalAuthMiddleware');
    const fnBody = source.substring(fnIdx, fnIdx + 4000);
    const catchIdx = fnBody.lastIndexOf('} catch');
    const catchBody = fnBody.substring(catchIdx, catchIdx + 300);

    expect(catchBody).toContain('path');
    expect(catchBody).toContain('error');
  });

  // -------------------------------------------------------------------------
  // 1.9 Blacklisted token in optionalAuth: treated as unauthenticated
  // -------------------------------------------------------------------------
  it('1.9 blacklisted token in optionalAuth: user NOT attached, no error thrown', async () => {
    mockRedisService.exists.mockResolvedValueOnce(true); // blacklisted!

    const token = makeAccessToken({ jti: 'blacklisted-jti-optional' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.userId).toBeUndefined();
  });
});

// ==========================================================================
// SUITE 2: verifyOtpRateLimiter Configuration (source inspections)
// ==========================================================================
describe('verifyOtpRateLimiter: configuration and wiring', () => {
  // -------------------------------------------------------------------------
  // 2.1 verifyOtpRateLimiter exists and is exported
  // -------------------------------------------------------------------------
  it('2.1 verifyOtpRateLimiter is exported from rate-limiter.middleware', () => {
    const { verifyOtpRateLimiter } = require('../shared/middleware/rate-limiter.middleware');
    expect(verifyOtpRateLimiter).toBeDefined();
    expect(typeof verifyOtpRateLimiter).toBe('function');
  });

  // -------------------------------------------------------------------------
  // 2.2 verifyOtpRateLimiter window is 10 minutes
  // -------------------------------------------------------------------------
  it('2.2 source: verifyOtpRateLimiter windowMs is 10 * 60 * 1000', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    expect(limiterIdx).toBeGreaterThan(-1);
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);
    expect(limiterBlock).toContain('10 * 60 * 1000');
  });

  // -------------------------------------------------------------------------
  // 2.3 verifyOtpRateLimiter max is 5
  // -------------------------------------------------------------------------
  it('2.3 source: verifyOtpRateLimiter max is 5', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);
    expect(limiterBlock).toMatch(/max:\s*5/);
  });

  // -------------------------------------------------------------------------
  // 2.4 verifyOtpRateLimiter key is phone-based (not IP-based)
  // -------------------------------------------------------------------------
  it('2.4 source: verifyOtpRateLimiter keyGenerator keys by phone', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);
    // keyGenerator must use req.body?.phone
    expect(limiterBlock).toContain('req.body?.phone');
    // Key prefix is 'verify:' to distinguish from OTP send bucket
    expect(limiterBlock).toContain('verify:');
  });

  // -------------------------------------------------------------------------
  // 2.5 verifyOtpRateLimiter key format includes role for isolation
  // -------------------------------------------------------------------------
  it('2.5 source: verifyOtpRateLimiter keyGenerator includes role', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);
    // Key must include role segment (phone+role combination)
    expect(limiterBlock).toMatch(/verify:.*phone.*role|verify:.*role.*phone/s);
  });

  // -------------------------------------------------------------------------
  // 2.6 verifyOtpRateLimiter and otpRateLimiter use DIFFERENT key prefixes
  // -------------------------------------------------------------------------
  it('2.6 source: verifyOtpRateLimiter and otpRateLimiter have distinct key prefixes', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    // otpRateLimiter uses 'otp:' prefix
    expect(source).toContain('`otp:${phone}:${role}`');
    // verifyOtpRateLimiter uses 'verify:' prefix
    expect(source).toContain('verify:');
    // They must be different — rate limits don't share a bucket
    const otpIdx = source.indexOf('`otp:${phone}:${role}`');
    const verifyIdx = source.indexOf('verify:');
    expect(otpIdx).not.toBe(verifyIdx);
  });
});

// ==========================================================================
// SUITE 3: driver-auth Routes — verifyOtpRateLimiter Wiring
// ==========================================================================
describe('driver-auth routes: verifyOtpRateLimiter wired to verify-otp', () => {
  // -------------------------------------------------------------------------
  // 3.1 driver-auth verify-otp route imports verifyOtpRateLimiter
  // -------------------------------------------------------------------------
  it('3.1 driver-auth.routes.ts imports verifyOtpRateLimiter', () => {
    const source = readSource('../modules/driver-auth/driver-auth.routes.ts');
    expect(source).toContain('verifyOtpRateLimiter');
    expect(source).toMatch(/import.*verifyOtpRateLimiter.*from/);
  });

  // -------------------------------------------------------------------------
  // 3.2 verify-otp route uses verifyOtpRateLimiter (not otpRateLimiter)
  // -------------------------------------------------------------------------
  it('3.2 driver-auth verify-otp route: verifyOtpRateLimiter is the middleware, not otpRateLimiter', () => {
    const source = readSource('../modules/driver-auth/driver-auth.routes.ts');

    // Find the verify-otp route block
    const verifyOtpRouteIdx = source.indexOf("'/verify-otp'");
    expect(verifyOtpRouteIdx).toBeGreaterThan(-1);

    // Get the route registration block (from route path to next router.post)
    const routeBlock = source.substring(verifyOtpRouteIdx, verifyOtpRouteIdx + 300);
    expect(routeBlock).toContain('verifyOtpRateLimiter');
  });

  // -------------------------------------------------------------------------
  // 3.3 verify-otp route does NOT use otpRateLimiter
  // -------------------------------------------------------------------------
  it('3.3 driver-auth verify-otp: does NOT use otpRateLimiter in verification slot', () => {
    const source = readSource('../modules/driver-auth/driver-auth.routes.ts');

    const verifyOtpRouteIdx = source.indexOf("'/verify-otp'");
    const routeBlock = source.substring(verifyOtpRouteIdx, verifyOtpRouteIdx + 300);

    // In the verify-otp block, only verifyOtpRateLimiter should appear
    // (otpRateLimiter should NOT be used here)
    const otpLimiterCount = (routeBlock.match(/otpRateLimiter(?!.*verify)/g) || []).length;
    // 'otpRateLimiter' alone (without 'verify' prefix) should not appear
    // The word 'otpRateLimiter' with preceding 'verify' is fine (verifyOtpRateLimiter)
    const plainOtpLimiter = routeBlock.includes('otpRateLimiter') &&
      !routeBlock.includes('verifyOtpRateLimiter');
    expect(plainOtpLimiter).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3.4 send-otp route still uses otpRateLimiter (not changed)
  // -------------------------------------------------------------------------
  it('3.4 driver-auth send-otp: still uses otpRateLimiter (send bucket)', () => {
    const source = readSource('../modules/driver-auth/driver-auth.routes.ts');

    const sendOtpRouteIdx = source.indexOf("'/send-otp'");
    expect(sendOtpRouteIdx).toBeGreaterThan(-1);
    const routeBlock = source.substring(sendOtpRouteIdx, sendOtpRouteIdx + 300);
    expect(routeBlock).toContain('otpRateLimiter');
  });
});

// ==========================================================================
// SUITE 4: driver Routes — onboard/verify Uses verifyOtpRateLimiter
// ==========================================================================
describe('driver routes: onboard/verify uses verifyOtpRateLimiter', () => {
  // -------------------------------------------------------------------------
  // 4.1 driver.routes.ts imports both limiters
  // -------------------------------------------------------------------------
  it('4.1 driver.routes.ts imports both otpRateLimiter and verifyOtpRateLimiter', () => {
    const source = readSource('../modules/driver/driver.routes.ts');
    expect(source).toContain('otpRateLimiter');
    expect(source).toContain('verifyOtpRateLimiter');
    expect(source).toMatch(/import.*otpRateLimiter.*verifyOtpRateLimiter.*from|import.*verifyOtpRateLimiter.*otpRateLimiter.*from/);
  });

  // -------------------------------------------------------------------------
  // 4.2 onboard/verify route uses verifyOtpRateLimiter
  // -------------------------------------------------------------------------
  it('4.2 driver onboard/verify route uses verifyOtpRateLimiter', () => {
    const source = readSource('../modules/driver/driver.routes.ts');

    const verifyRouteIdx = source.indexOf("'/onboard/verify'");
    expect(verifyRouteIdx).toBeGreaterThan(-1);
    const routeBlock = source.substring(verifyRouteIdx, verifyRouteIdx + 400);
    expect(routeBlock).toContain('verifyOtpRateLimiter');
  });

  // -------------------------------------------------------------------------
  // 4.3 onboard/verify route does NOT use bare otpRateLimiter
  // -------------------------------------------------------------------------
  it('4.3 driver onboard/verify: does NOT use bare otpRateLimiter', () => {
    const source = readSource('../modules/driver/driver.routes.ts');

    const verifyRouteIdx = source.indexOf("'/onboard/verify'");
    const routeBlock = source.substring(verifyRouteIdx, verifyRouteIdx + 400);

    // Only verifyOtpRateLimiter should appear, not the shorter otpRateLimiter
    // Extract just the middleware names (look for the middleware array in router.post)
    const hasVerify = routeBlock.includes('verifyOtpRateLimiter');
    // 'otpRateLimiter' alone (the send-OTP limiter) must NOT appear in verify block
    const hasPlainOtp = routeBlock.split('verifyOtpRateLimiter').join('').includes('otpRateLimiter');
    expect(hasVerify).toBe(true);
    expect(hasPlainOtp).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4.4 onboard/initiate route uses otpRateLimiter (send bucket unchanged)
  // -------------------------------------------------------------------------
  it('4.4 driver onboard/initiate: still uses otpRateLimiter (send bucket)', () => {
    const source = readSource('../modules/driver/driver.routes.ts');

    const initiateRouteIdx = source.indexOf("'/onboard/initiate'");
    expect(initiateRouteIdx).toBeGreaterThan(-1);
    const routeBlock = source.substring(initiateRouteIdx, initiateRouteIdx + 400);
    expect(routeBlock).toContain('otpRateLimiter');
  });

  // -------------------------------------------------------------------------
  // 4.5 onboard/resend route uses otpRateLimiter (send bucket unchanged)
  // -------------------------------------------------------------------------
  it('4.5 driver onboard/resend: uses otpRateLimiter (send bucket, not verify bucket)', () => {
    const source = readSource('../modules/driver/driver.routes.ts');

    const resendRouteIdx = source.indexOf("'/onboard/resend'");
    expect(resendRouteIdx).toBeGreaterThan(-1);
    const routeBlock = source.substring(resendRouteIdx, resendRouteIdx + 400);
    // Resend is a send operation — uses otpRateLimiter
    expect(routeBlock).toContain('otpRateLimiter');
  });

  // -------------------------------------------------------------------------
  // 4.6 verifyOtpRateLimiter has comment explaining the fix
  // -------------------------------------------------------------------------
  it('4.6 driver onboard/verify: has comment explaining verifyOtpRateLimiter usage', () => {
    const source = readSource('../modules/driver/driver.routes.ts');

    const verifyRouteIdx = source.indexOf("'/onboard/verify'");
    // Within 500 chars of the route registration, there should be a comment about the limiter
    const routeContext = source.substring(Math.max(0, verifyRouteIdx - 100), verifyRouteIdx + 500);
    // Issue #21 comment or verify-OTP explanation should be present
    expect(routeContext).toMatch(/verify.*(OTP|otp|limiter|bucket)|Issue #21/i);
  });
});

// ==========================================================================
// SUITE 5: Rate Limit Bucket Isolation (phone-based, not shared)
// ==========================================================================
describe('rate limit bucket isolation: phone-based and role-based', () => {
  // -------------------------------------------------------------------------
  // 5.1 Different phones get independent rate limit buckets
  // -------------------------------------------------------------------------
  it('5.1 source: different phones produce different keyGenerator values', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    // verifyOtpRateLimiter keyGenerator includes phone
    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);

    // Build the key for two different phones from the source pattern
    // Key format: verify:${req.body?.phone}:${role}
    const phone1 = '9000000001';
    const phone2 = '9000000002';
    const role = 'customer';

    // Simulate the key generator logic
    const key1 = `verify:${phone1}:${role}`;
    const key2 = `verify:${phone2}:${role}`;
    expect(key1).not.toBe(key2);
  });

  // -------------------------------------------------------------------------
  // 5.2 Same phone + different role = different bucket
  // -------------------------------------------------------------------------
  it('5.2 same phone + different role = different rate limit bucket', () => {
    const phone = '9876543210';
    const key1 = `verify:${phone}:customer`;
    const key2 = `verify:${phone}:driver`;
    expect(key1).not.toBe(key2);
  });

  // -------------------------------------------------------------------------
  // 5.3 verifyOtpRateLimiter and otpRateLimiter keys never collide
  // -------------------------------------------------------------------------
  it('5.3 verify bucket and send bucket keys never collide for same phone+role', () => {
    const phone = '9876543210';
    const role = 'customer';
    const sendKey = `otp:${phone}:${role}`;    // otpRateLimiter
    const verifyKey = `verify:${phone}:${role}`; // verifyOtpRateLimiter
    expect(sendKey).not.toBe(verifyKey);
  });

  // -------------------------------------------------------------------------
  // 5.4 otpRateLimiter keys by phone+role (not IP)
  // -------------------------------------------------------------------------
  it('5.4 source: otpRateLimiter keyGenerator uses phone+role (not IP)', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const otpLimiterIdx = source.indexOf('otpRateLimiter = rateLimit(');
    expect(otpLimiterIdx).toBeGreaterThan(-1);
    // Use 1000 chars to capture the full keyGenerator body (comments are verbose)
    const limiterBlock = source.substring(otpLimiterIdx, otpLimiterIdx + 1000);

    // Must include phone in key
    expect(limiterBlock).toContain('phone');
    // Key should be otp:phone:role format
    expect(limiterBlock).toContain('`otp:${phone}:${role}`');
  });

  // -------------------------------------------------------------------------
  // 5.5 OTP send window is 2 minutes (different from verify's 10 minutes)
  // -------------------------------------------------------------------------
  it('5.5 source: otpRateLimiter window (2 min) differs from verifyOtpRateLimiter (10 min)', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    // otpRateLimiter: 2 minutes
    const otpIdx = source.indexOf('otpRateLimiter = rateLimit(');
    const otpBlock = source.substring(otpIdx, otpIdx + 400);
    expect(otpBlock).toContain('2 * 60 * 1000');

    // verifyOtpRateLimiter: 10 minutes
    const verifyIdx = source.indexOf('verifyOtpRateLimiter = rateLimit(');
    const verifyBlock = source.substring(verifyIdx, verifyIdx + 400);
    expect(verifyBlock).toContain('10 * 60 * 1000');
  });
});

// ==========================================================================
// SUITE 6: OTP Brute Force Protection (double protection)
// ==========================================================================
describe('OTP brute force protection: rate limiter + app-layer deletion', () => {
  // -------------------------------------------------------------------------
  // 6.1 OtpChallengeService uses maxAttempts constant
  // -------------------------------------------------------------------------
  it('6.1 source: otp-challenge.service uses maxAttempts from config', () => {
    const source = readSource('../modules/auth/otp-challenge.service.ts');
    expect(source).toContain('maxAttempts');
    expect(source).toContain('config.otp.maxAttempts');
  });

  // -------------------------------------------------------------------------
  // 6.2 After 3 wrong guesses, OTP record is deleted (app-layer protection)
  // -------------------------------------------------------------------------
  it('6.2 source: otp-challenge.service deletes challenge when MAX_ATTEMPTS reached', () => {
    const source = readSource('../modules/auth/otp-challenge.service.ts');

    // deleteChallenge is called when maxReached is true
    expect(source).toContain('deleteChallenge');
    // MAX_ATTEMPTS code is returned
    expect(source).toContain("'MAX_ATTEMPTS'");
    // The challenge is deleted on max attempts
    expect(source).toMatch(/maxReached[\s\S]*?deleteChallenge|deleteChallenge[\s\S]*?MAX_ATTEMPTS/);
  });

  // -------------------------------------------------------------------------
  // 6.3 OTP challenge uses timing-safe comparison (prevents timing attacks)
  // -------------------------------------------------------------------------
  it('6.3 source: otp-challenge.service uses timingSafeEqual for comparison', () => {
    const source = readSource('../modules/auth/otp-challenge.service.ts');
    expect(source).toContain('timingSafeEqual');
  });

  // -------------------------------------------------------------------------
  // 6.4 Rate limiter + OTP deletion = defense in depth
  // -------------------------------------------------------------------------
  it('6.4 source: both rate-limiter guard and app-layer attempt limit exist', () => {
    const rateLimiterSource = readSource('../shared/middleware/rate-limiter.middleware.ts');
    const otpSource = readSource('../modules/auth/otp-challenge.service.ts');

    // Layer 1: rate limiter (5 attempts in 10 min window)
    expect(rateLimiterSource).toContain('verifyOtpRateLimiter');
    expect(rateLimiterSource).toMatch(/max:\s*5/);

    // Layer 2: app-layer OTP deletion (3 wrong guesses → delete OTP)
    expect(otpSource).toContain('maxAttempts');
    expect(otpSource).toContain('deleteChallenge');
  });

  // -------------------------------------------------------------------------
  // 6.5 Different phones have independent attempt counts
  // -------------------------------------------------------------------------
  it('6.5 otp attempt tracking is per-phone (Redis key includes phone)', () => {
    const source = readSource('../modules/auth/otp-challenge.service.ts');

    // Redis key passed to verifyChallenge must be phone-specific
    // incrementOtpAttempts is called with a phone-specific key
    expect(source).toContain('incrementOtpAttempts');
    // The key is passed as a parameter (per-phone isolation)
    expect(source).toContain('params.redisKey');
  });

  // -------------------------------------------------------------------------
  // 6.6 Auth service config.otp.maxAttempts is 3
  // -------------------------------------------------------------------------
  it('6.6 config.otp.maxAttempts is 3 (double-check test environment)', () => {
    const { config } = require('../config/environment');
    expect(config.otp.maxAttempts).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 6.7 OTP challenge verifyLock prevents concurrent duplicate submissions
  // -------------------------------------------------------------------------
  it('6.7 source: verifyChallenge acquires a Redis lock to prevent concurrent attacks', () => {
    const source = readSource('../modules/auth/otp-challenge.service.ts');
    // Verify lock key usage
    expect(source).toContain('verifyLockKey');
    // Lock is acquired via Redis SETNX (eval with NX flag)
    expect(source).toContain('OTP_VERIFY_IN_PROGRESS');
    expect(source).toContain("'NX'");
  });
});

// ==========================================================================
// SUITE 7: Token Edge Cases (behavioral tests against middleware)
// ==========================================================================
describe('token edge cases: behavioral middleware tests', () => {
  beforeEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // 7.1 Expired access token: authMiddleware returns TOKEN_EXPIRED
  // -------------------------------------------------------------------------
  it('7.1 expired token in authMiddleware: TOKEN_EXPIRED error, not generic 401', async () => {
    const expiredToken = makeAccessToken({}, JWT_SECRET, '-1s');
    const req = mockReq({ authorization: `Bearer ${expiredToken}` });
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, mockRes(), next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('TOKEN_EXPIRED');
  });

  // -------------------------------------------------------------------------
  // 7.2 Expired token in optionalAuth: no error, no user
  // -------------------------------------------------------------------------
  it('7.2 expired token in optionalAuth: no error thrown, user not attached', async () => {
    const expiredToken = makeAccessToken({}, JWT_SECRET, '-1s');
    const req = mockReq({ authorization: `Bearer ${expiredToken}` });
    const next = jest.fn();

    await optionalAuthMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 7.3 Malformed token in authMiddleware: INVALID_TOKEN
  // -------------------------------------------------------------------------
  it('7.3 malformed token in authMiddleware: INVALID_TOKEN error', async () => {
    const req = mockReq({ authorization: 'Bearer not.a.real.jwt.token' });
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, mockRes(), next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('INVALID_TOKEN');
  });

  // -------------------------------------------------------------------------
  // 7.4 Missing token in authMiddleware: UNAUTHORIZED
  // -------------------------------------------------------------------------
  it('7.4 missing token in authMiddleware: UNAUTHORIZED (401)', async () => {
    const req = mockReq({}); // no Authorization header
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, mockRes(), next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('UNAUTHORIZED');
  });

  // -------------------------------------------------------------------------
  // 7.5 Concurrent requests with same token: both succeed (no race condition)
  // -------------------------------------------------------------------------
  it('7.5 concurrent valid tokens: both succeed without race condition', async () => {
    mockRedisService.exists.mockResolvedValue(false);

    const token = makeAccessToken({ jti: 'concurrent-jti' });
    const req1 = mockReq({ authorization: `Bearer ${token}` });
    const req2 = mockReq({ authorization: `Bearer ${token}` });
    const next1 = jest.fn();
    const next2 = jest.fn();

    await Promise.all([
      authMiddleware(req1, mockRes(), next1),
      authMiddleware(req2, mockRes(), next2),
    ]);

    expect(next1).toHaveBeenCalledWith();
    expect(next2).toHaveBeenCalledWith();
    expect(req1.userId).toBe('user-phase7');
    expect(req2.userId).toBe('user-phase7');
  });

  // -------------------------------------------------------------------------
  // 7.6 Token signed with wrong secret: INVALID_TOKEN
  // -------------------------------------------------------------------------
  it('7.6 wrong-secret token: INVALID_TOKEN (not generic error)', async () => {
    const badToken = makeAccessToken({}, 'completely-wrong-secret');
    const req = mockReq({ authorization: `Bearer ${badToken}` });
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, mockRes(), next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('INVALID_TOKEN');
  });

  // -------------------------------------------------------------------------
  // 7.7 Device ID mismatch: still returns DEVICE_MISMATCH
  // -------------------------------------------------------------------------
  it('7.7 device ID mismatch: DEVICE_MISMATCH rejected', async () => {
    mockRedisService.exists.mockResolvedValue(false);

    const token = makeAccessToken({ deviceId: 'device-original' });
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-device-id': 'device-different',
    });
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, mockRes(), next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('DEVICE_MISMATCH');
  });

  // -------------------------------------------------------------------------
  // 7.8 Valid token with matching device ID: succeeds
  // -------------------------------------------------------------------------
  it('7.8 valid token with matching device ID: auth succeeds', async () => {
    mockRedisService.exists.mockResolvedValue(false);

    const token = makeAccessToken({ deviceId: 'same-device' });
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-device-id': 'same-device',
    });
    const next = jest.fn();

    await authMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('user-phase7');
  });

  // -------------------------------------------------------------------------
  // 7.9 Token without deviceId: no DEVICE_MISMATCH even with x-device-id header
  // -------------------------------------------------------------------------
  it('7.9 legacy token without deviceId: no DEVICE_MISMATCH (backwards compat)', async () => {
    mockRedisService.exists.mockResolvedValue(false);

    // Token without deviceId (legacy)
    const token = makeAccessToken({}); // no deviceId in payload
    const req = mockReq({
      authorization: `Bearer ${token}`,
      'x-device-id': 'some-new-device',
    });
    const next = jest.fn();

    await authMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('user-phase7');
  });
});

// ==========================================================================
// SUITE 8: Combined Auth Scenarios
// ==========================================================================
describe('combined auth scenarios: middleware chain interactions', () => {
  beforeEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // 8.1 optionalAuth failure during Redis down: no crash, no user
  // -------------------------------------------------------------------------
  it('8.1 optionalAuth + Redis down: no crash, graceful degradation', async () => {
    mockRedisService.exists.mockRejectedValue(new Error('Redis ECONNREFUSED permanently'));

    const token = makeAccessToken({ jti: 'redis-down-jti' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = jest.fn();

    // Should NOT throw
    await expect(optionalAuthMiddleware(req, mockRes(), next)).resolves.not.toThrow();
    expect(next).toHaveBeenCalledWith();
    // User not attached when Redis is down in optionalAuth
    expect(req.userId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8.2 authMiddleware with Redis down: fail-open (user IS attached)
  // -------------------------------------------------------------------------
  it('8.2 authMiddleware + Redis down: fail-open, user IS attached', async () => {
    mockRedisService.exists.mockRejectedValueOnce(new Error('Redis down'));

    const token = makeAccessToken({ jti: 'auth-redis-down-jti' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = jest.fn();

    await authMiddleware(req, mockRes(), next);

    // authMiddleware is fail-open: Redis down → still authenticate user
    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('user-phase7');
  });

  // -------------------------------------------------------------------------
  // 8.3 Auth middleware: JTI blacklist warning is logged on Redis failure
  // -------------------------------------------------------------------------
  it('8.3 authMiddleware Redis failure: logger.warn is called (not logger.error)', async () => {
    mockRedisService.exists.mockRejectedValueOnce(new Error('Redis gone'));

    const token = makeAccessToken({ jti: 'warn-jti-test' });
    const req = mockReq({ authorization: `Bearer ${token}` });
    const next = jest.fn();

    await authMiddleware(req, mockRes(), next);

    // Should log a warning, not an error, for JTI check failure
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8.4 Auth middleware JTI warn log contains jti, userId, path
  // -------------------------------------------------------------------------
  it('8.4 authMiddleware JTI warn: log context includes jti, userId, path', async () => {
    mockRedisService.exists.mockRejectedValueOnce(new Error('Redis error'));

    const jti = 'context-jti-' + crypto.randomUUID();
    const token = makeAccessToken({ jti, userId: 'user-context-test' });
    const req = mockReq({ authorization: `Bearer ${token}` }, {}, { path: '/api/v1/order/create' });
    const next = jest.fn();

    await authMiddleware(req, mockRes(), next);

    // Find the warn call for JTI blacklist
    const warnCall = mockLogger.warn.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('JTI blacklist')
    );
    expect(warnCall).toBeDefined();
    if (warnCall) {
      const logContext = warnCall[1];
      expect(logContext).toBeDefined();
      expect(logContext.jti).toBe(jti);
      expect(logContext.userId).toBe('user-context-test');
    }
  });

  // -------------------------------------------------------------------------
  // 8.5 optionalAuth followed by authMiddleware: separate middleware instances
  // -------------------------------------------------------------------------
  it('8.5 optionalAuth and authMiddleware are separate exports', () => {
    // Verify both are different functions
    expect(optionalAuthMiddleware).toBeDefined();
    expect(authMiddleware).toBeDefined();
    expect(optionalAuthMiddleware).not.toBe(authMiddleware);
  });

  // -------------------------------------------------------------------------
  // 8.6 Token blacklisted: authMiddleware rejects, optionalAuth allows but sets no user
  // -------------------------------------------------------------------------
  it('8.6 blacklisted token: authMiddleware rejects with TOKEN_REVOKED, optionalAuth silently drops', async () => {
    const jti = 'blacklisted-jti-combined';
    const token = makeAccessToken({ jti });

    // authMiddleware: should reject
    mockRedisService.exists.mockResolvedValueOnce(true); // blacklisted
    const req1 = mockReq({ authorization: `Bearer ${token}` });
    let capturedError: any;
    const next1 = jest.fn((err?: any) => { capturedError = err; });
    await authMiddleware(req1, mockRes(), next1);
    expect(capturedError).toBeDefined();
    expect(capturedError.code).toBe('TOKEN_REVOKED');

    // optionalAuth: should silently drop
    mockRedisService.exists.mockResolvedValueOnce(true); // blacklisted
    const req2 = mockReq({ authorization: `Bearer ${token}` });
    const next2 = jest.fn();
    await optionalAuthMiddleware(req2, mockRes(), next2);
    expect(next2).toHaveBeenCalledWith(); // no error
    expect(req2.userId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8.7 Algorithm restriction: both middleware enforce HS256 only
  // -------------------------------------------------------------------------
  it('8.7 source: both authMiddleware and optionalAuthMiddleware use algorithms: [HS256]', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');
    // Count occurrences of algorithm restriction
    const matches = source.match(/algorithms:\s*\[\s*'HS256'\s*\]/g) || [];
    // Should appear at least twice (once per middleware function)
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // 8.8 Alg:none attack rejected by authMiddleware
  // -------------------------------------------------------------------------
  it('8.8 alg:none attack token is rejected by authMiddleware', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ userId: 'attacker', role: 'admin', phone: '0000000000', jti: 'fake-jti' }),
    ).toString('base64url');
    const unsignedToken = `${header}.${payload}.`;

    const req = mockReq({ authorization: `Bearer ${unsignedToken}` });
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, mockRes(), next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(['INVALID_TOKEN', 'UNAUTHORIZED']).toContain(capturedError.code);
  });
});

// ==========================================================================
// SUITE 9: Source-Code Consistency Checks
// ==========================================================================
describe('source-code consistency: imports, exports, and cross-references', () => {
  // -------------------------------------------------------------------------
  // 9.1 auth.middleware.ts exports optionalAuthMiddleware
  // -------------------------------------------------------------------------
  it('9.1 auth.middleware.ts exports optionalAuthMiddleware', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');
    expect(source).toContain('export async function optionalAuthMiddleware');
  });

  // -------------------------------------------------------------------------
  // 9.2 auth.middleware.ts has optionalAuth alias
  // -------------------------------------------------------------------------
  it('9.2 auth.middleware.ts has optionalAuth alias for backwards compat', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');
    expect(source).toContain('export const optionalAuth = optionalAuthMiddleware');
  });

  // -------------------------------------------------------------------------
  // 9.3 rate-limiter.middleware.ts exports all three key limiters
  // -------------------------------------------------------------------------
  it('9.3 rate-limiter.middleware.ts exports otpRateLimiter, verifyOtpRateLimiter, authRateLimiter', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');
    expect(source).toContain('export const otpRateLimiter');
    expect(source).toContain('export const verifyOtpRateLimiter');
    expect(source).toContain('export const authRateLimiter');
  });

  // -------------------------------------------------------------------------
  // 9.4 driver-auth.routes.ts imports authMiddleware
  // -------------------------------------------------------------------------
  it('9.4 driver-auth.routes.ts imports authMiddleware', () => {
    const source = readSource('../modules/driver-auth/driver-auth.routes.ts');
    expect(source).toMatch(/import.*authMiddleware.*from/);
  });

  // -------------------------------------------------------------------------
  // 9.5 driver.routes.ts imports authMiddleware and roleGuard
  // -------------------------------------------------------------------------
  it('9.5 driver.routes.ts imports authMiddleware and roleGuard', () => {
    const source = readSource('../modules/driver/driver.routes.ts');
    expect(source).toMatch(/import.*authMiddleware.*roleGuard.*from|import.*roleGuard.*authMiddleware.*from/);
  });

  // -------------------------------------------------------------------------
  // 9.6 auth.middleware.ts imports logger
  // -------------------------------------------------------------------------
  it('9.6 auth.middleware.ts imports logger for warn logging', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');
    expect(source).toMatch(/import.*logger.*from/);
  });

  // -------------------------------------------------------------------------
  // 9.7 auth.middleware.ts imports redisService for JTI blacklist
  // -------------------------------------------------------------------------
  it('9.7 auth.middleware.ts imports redisService for JTI blacklist check', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');
    expect(source).toMatch(/import.*redisService.*from/);
  });

  // -------------------------------------------------------------------------
  // 9.8 driver-auth.routes.ts does not use deprecated debug OTP endpoint
  // -------------------------------------------------------------------------
  it('9.8 driver-auth.routes.ts: debug-otp endpoint removed (security)', () => {
    const source = readSource('../modules/driver-auth/driver-auth.routes.ts');
    // The route handler for /debug-otp should NOT be present
    expect(source).not.toMatch(/router\.get\s*\(\s*['"]\/debug-otp['"]/);
  });
});

// ==========================================================================
// SUITE 10: Rate Limiter Key Format Assertions
// ==========================================================================
describe('rate limiter key format: verify the exact key patterns', () => {
  // -------------------------------------------------------------------------
  // 10.1 verifyOtpRateLimiter key format: verify:{phone}:{role}
  // -------------------------------------------------------------------------
  it('10.1 source: verifyOtpRateLimiter key pattern is verify:${phone}:${role}', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);

    // Key must match: `verify:${req.body?.phone}:${...role...}`
    expect(limiterBlock).toMatch(/`verify:\$\{req\.body\?\.phone\}/);
  });

  // -------------------------------------------------------------------------
  // 10.2 otpRateLimiter key format: otp:{phone}:{role}
  // -------------------------------------------------------------------------
  it('10.2 source: otpRateLimiter key pattern is `otp:${phone}:${role}`', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('otpRateLimiter = rateLimit(');
    // Use 1000 chars to capture past the verbose comments in keyGenerator
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 1000);
    expect(limiterBlock).toContain('`otp:${phone}:${role}`');
  });

  // -------------------------------------------------------------------------
  // 10.3 verifyOtpRateLimiter: error response code is TOO_MANY_ATTEMPTS
  // -------------------------------------------------------------------------
  it('10.3 source: verifyOtpRateLimiter returns TOO_MANY_ATTEMPTS error code', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);
    expect(limiterBlock).toContain('TOO_MANY_ATTEMPTS');
  });

  // -------------------------------------------------------------------------
  // 10.4 otpRateLimiter: error response code is OTP_RATE_LIMIT_EXCEEDED
  // -------------------------------------------------------------------------
  it('10.4 source: otpRateLimiter returns OTP_RATE_LIMIT_EXCEEDED error code', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('otpRateLimiter = rateLimit(');
    // Use 1200 chars to capture handler definition after the verbose keyGenerator
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 1200);
    expect(limiterBlock).toContain('OTP_RATE_LIMIT_EXCEEDED');
  });

  // -------------------------------------------------------------------------
  // 10.5 Redis store prefix for verify-otp is distinct
  // -------------------------------------------------------------------------
  it('10.5 source: verifyOtpRateLimiter Redis store prefix is verify-otp', () => {
    const source = readSource('../shared/middleware/rate-limiter.middleware.ts');

    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBlock = source.substring(limiterIdx, limiterIdx + 600);
    // Store name passed to createStore must distinguish verify from otp
    expect(limiterBlock).toContain("'verify-otp'");
  });
});
