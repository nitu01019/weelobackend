/**
 * =============================================================================
 * PHASE 3 — AUTH SECURITY TESTS
 * =============================================================================
 *
 * Validates 4 auth security fixes:
 *
 *  Issue #7:  IP rate limiter (authRateLimiter) on /send-otp route
 *  Issue #14: jwt.verify algorithms restriction on refresh token
 *  Issue #6:  OTP cooldown write wrapped in try/catch (fail-open)
 *  Issue #2:  Customer suspension blacklist in auth middleware
 *
 * @author beta-auth-qa (Team Beta)
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// =============================================================================
// MOCK SETUP — Must come before imports of modules under test
// =============================================================================

const mockRedisExists = jest.fn().mockResolvedValue(false);
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisGetJSON = jest.fn().mockResolvedValue(null);
const mockRedisSetJSON = jest.fn().mockResolvedValue('OK');
const mockRedisDeleteOtp = jest.fn().mockResolvedValue(undefined);
const mockRedisIncrOtpAttempts = jest.fn().mockResolvedValue({ allowed: true, remaining: 2 });
const mockRedisGetOtpAttempts = jest.fn().mockResolvedValue(0);
const mockRedisEval = jest.fn().mockResolvedValue(1);
const mockRedisSMembers = jest.fn().mockResolvedValue([]);
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisSAdd = jest.fn().mockResolvedValue(1);
const mockRedisSRem = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(true);
const mockRedisIncrBy = jest.fn().mockResolvedValue(1);

jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    exists: mockRedisExists,
    set: mockRedisSet,
    getJSON: mockRedisGetJSON,
    setJSON: mockRedisSetJSON,
    deleteOtpWithAttempts: mockRedisDeleteOtp,
    incrementOtpAttempts: mockRedisIncrOtpAttempts,
    getOtpAttempts: mockRedisGetOtpAttempts,
    eval: mockRedisEval,
    sMembers: mockRedisSMembers,
    del: mockRedisDel,
    sAdd: mockRedisSAdd,
    sRem: mockRedisSRem,
    expire: mockRedisExpire,
    incrBy: mockRedisIncrBy,
    incrementWithTTL: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
  },
}));

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
    observeHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    isDevelopment: true,
    otp: { expiryMinutes: 5, length: 6, maxAttempts: 3 },
    sms: { provider: 'mock' },
    jwt: {
      secret: 'test-jwt-secret-256-bits-long-xx',
      refreshSecret: 'test-refresh-secret-256-bits-xx',
      expiresIn: '1h',
      refreshExpiresIn: '7d',
    },
    rateLimit: { windowMs: 60000, maxRequests: 100 },
  },
}));

jest.mock('../shared/database/db', () => ({
  db: {
    getUserByPhone: jest.fn(),
    getUserById: jest.fn(),
    createUser: jest.fn(),
    prisma: {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    },
  },
}));

jest.mock('./../../src/modules/auth/sms.service', () => ({
  smsService: {
    sendOtp: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../shared/services/fcm.service', () => ({
  fcmService: { removeAllTokens: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../shared/services/availability.service', () => ({
  availabilityService: { setOffline: jest.fn() },
}));

jest.mock('../shared/services/transporter-online.service', () => ({
  ONLINE_TRANSPORTERS_SET: 'online:transporters',
  TRANSPORTER_PRESENCE_KEY: (id: string) => `transporter:presence:${id}`,
}));

// =============================================================================
// ISSUE #7: IP rate limiter (authRateLimiter) on /send-otp
// =============================================================================

describe('Issue #7: authRateLimiter on /send-otp route', () => {
  const routesPath = path.resolve(__dirname, '../modules/auth/auth.routes.ts');
  const routeSource = fs.readFileSync(routesPath, 'utf-8');

  test('auth.routes.ts imports authRateLimiter from rate-limiter middleware', () => {
    expect(routeSource).toContain('authRateLimiter');
    expect(routeSource).toMatch(/import\s+\{[^}]*authRateLimiter[^}]*\}\s+from/);
  });

  test('/send-otp route has authRateLimiter BEFORE otpRateLimiter', () => {
    // Find the line that defines the /send-otp route
    const sendOtpLine = routeSource
      .split('\n')
      .find((line) => line.includes("'/send-otp'") && line.includes('router.post'));

    expect(sendOtpLine).toBeDefined();
    // authRateLimiter must appear before otpRateLimiter on that line
    const authIdx = sendOtpLine!.indexOf('authRateLimiter');
    const otpIdx = sendOtpLine!.indexOf('otpRateLimiter');
    expect(authIdx).toBeGreaterThan(-1);
    expect(otpIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(otpIdx);
  });

  test('/verify-otp route also has authRateLimiter', () => {
    const verifyOtpLine = routeSource
      .split('\n')
      .find((line) => line.includes("'/verify-otp'") && line.includes('router.post'));

    expect(verifyOtpLine).toBeDefined();
    expect(verifyOtpLine).toContain('authRateLimiter');
  });

  test('/refresh route has authRateLimiter', () => {
    const refreshLine = routeSource
      .split('\n')
      .find((line) => line.includes("'/refresh'") && line.includes('router.post'));

    expect(refreshLine).toBeDefined();
    expect(refreshLine).toContain('authRateLimiter');
  });
});

// =============================================================================
// ISSUE #14: jwt.verify algorithms restriction on refresh token
// =============================================================================

describe('Issue #14: refresh token jwt.verify with { algorithms: [HS256] }', () => {
  const servicePath = path.resolve(__dirname, '../modules/auth/auth.service.ts');
  const serviceSource = fs.readFileSync(servicePath, 'utf-8');

  test('refreshToken method specifies algorithms: [HS256] in jwt.verify call', () => {
    // Find the refreshToken method and verify it has algorithms restriction
    expect(serviceSource).toContain("algorithms: ['HS256']");

    // Ensure it's in the jwt.verify call context (within refreshToken method)
    const refreshMethodMatch = serviceSource.match(
      /async\s+refreshToken[\s\S]*?jwt\.verify\(refreshToken,\s*config\.jwt\.refreshSecret,\s*\{\s*algorithms:\s*\['HS256'\]\s*\}\)/
    );
    expect(refreshMethodMatch).not.toBeNull();
  });

  test('alg:none token is rejected on refresh', () => {
    const { config } = require('../config/environment');

    // Create an unsigned token (alg:none attack)
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ userId: 'user-1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    // jwt.verify with algorithms: ['HS256'] should reject alg:none
    expect(() => {
      jwt.verify(noneToken, config.jwt.refreshSecret, { algorithms: ['HS256'] });
    }).toThrow();
  });

  test('valid HS256 token is accepted by jwt.verify', () => {
    const { config } = require('../config/environment');

    const validToken = jwt.sign(
      { userId: 'user-1' },
      config.jwt.refreshSecret,
      { algorithm: 'HS256', expiresIn: '7d' }
    );

    const decoded = jwt.verify(validToken, config.jwt.refreshSecret, { algorithms: ['HS256'] }) as any;
    expect(decoded.userId).toBe('user-1');
  });

  test('RS256-signed token is rejected when only HS256 is allowed', () => {
    const { config } = require('../config/environment');

    // Create an RS256 header but sign with the HS256 secret to simulate confusion attack
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ userId: 'user-1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    const fakeSignature = crypto
      .createHmac('sha256', config.jwt.refreshSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const confusionToken = `${header}.${payload}.${fakeSignature}`;

    expect(() => {
      jwt.verify(confusionToken, config.jwt.refreshSecret, { algorithms: ['HS256'] });
    }).toThrow();
  });
});

// =============================================================================
// ISSUE #6: OTP cooldown write wrapped in try/catch (fail-open)
// =============================================================================

describe('Issue #6: OTP cooldown write try/catch (fail-open)', () => {
  const servicePath = path.resolve(__dirname, '../modules/auth/auth.service.ts');
  const serviceSource = fs.readFileSync(servicePath, 'utf-8');

  test('cooldown write is wrapped in try/catch (structural verification)', () => {
    // The cooldown write (redisService.set(cooldownKey, ...)) must be inside a try block
    // Look for the pattern: try { ...cooldownKey... } catch
    const cooldownTryCatch = serviceSource.match(
      /try\s*\{[\s\S]*?await\s+redisService\.set\(cooldownKey[\s\S]*?\}\s*catch/
    );
    expect(cooldownTryCatch).not.toBeNull();
  });

  test('cooldown write failure logs warning but does not throw', () => {
    // Verify the catch block logs a warning (fail-open behavior)
    const cooldownCatchBlock = serviceSource.match(
      /catch\s*\(err\)\s*\{[\s\S]*?logger\.warn\(\s*'\[OTP\] Cooldown write failed/
    );
    expect(cooldownCatchBlock).not.toBeNull();
  });

  test('sendOtp succeeds even when Redis cooldown write throws', async () => {
    // Reset all mocks
    jest.clearAllMocks();

    // Make cooldown check pass (no active cooldown)
    mockRedisExists.mockResolvedValueOnce(false);

    // Make cooldown WRITE throw an error
    mockRedisSet.mockRejectedValueOnce(new Error('Redis connection refused'));

    // Mock otpChallengeService to return a successful issue
    const otpChallengeService = require('../modules/auth/otp-challenge.service').otpChallengeService;
    const issueSpy = jest.spyOn(otpChallengeService, 'issueChallenge').mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 300_000),
      ttlSeconds: 300,
      hash: 'fakehash',
      storedInRedis: true,
      storedInDb: true,
    });

    // Mock smsService
    const smsService = require('../modules/auth/sms.service').smsService;
    smsService.sendOtp.mockResolvedValueOnce(undefined);

    const { authService } = require('../modules/auth/auth.service');
    const result = await authService.sendOtp('9876543210', 'customer');

    // Should succeed despite cooldown write failure
    expect(result).toBeDefined();
    expect(result.expiresIn).toBe(300); // 5 min * 60
    expect(result.message).toContain('OTP sent');

    issueSpy.mockRestore();
  });

  test('sendOtp succeeds with Redis cooldown write working normally', async () => {
    jest.clearAllMocks();

    // Cooldown check: no active cooldown
    mockRedisExists.mockResolvedValueOnce(false);

    // Cooldown write succeeds
    mockRedisSet.mockResolvedValueOnce('OK');

    const otpChallengeService = require('../modules/auth/otp-challenge.service').otpChallengeService;
    const issueSpy = jest.spyOn(otpChallengeService, 'issueChallenge').mockResolvedValueOnce({
      expiresAt: new Date(Date.now() + 300_000),
      ttlSeconds: 300,
      hash: 'fakehash',
      storedInRedis: true,
      storedInDb: true,
    });

    const smsService = require('../modules/auth/sms.service').smsService;
    smsService.sendOtp.mockResolvedValueOnce(undefined);

    const { authService } = require('../modules/auth/auth.service');
    const result = await authService.sendOtp('9876543210', 'customer');

    expect(result).toBeDefined();
    expect(result.expiresIn).toBe(300);

    issueSpy.mockRestore();
  });
});

// =============================================================================
// ISSUE #2: Customer suspension blacklist in auth middleware
// =============================================================================

describe('Issue #2: Customer suspension blacklist in authMiddleware', () => {
  // Helper: create a valid JWT for testing
  function createTestToken(payload: Record<string, unknown>): string {
    const { config } = require('../config/environment');
    return jwt.sign(
      { jti: crypto.randomUUID(), phone: '9876543210', ...payload },
      config.jwt.secret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
  }

  // Helper: create mock Express req/res/next
  function createMockReqResNext(token?: string) {
    const req: any = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      path: '/test',
    };
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    return { req, res, next };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: not blacklisted, not suspended
    mockRedisExists.mockResolvedValue(false);
  });

  test('suspended customer gets 403 ACCOUNT_SUSPENDED from authMiddleware', async () => {
    const { authMiddleware } = require('../shared/middleware/auth.middleware');
    const token = createTestToken({ userId: 'suspended-user', role: 'customer' });
    const { req, res, next } = createMockReqResNext(token);

    // JTI blacklist check: not blacklisted
    mockRedisExists.mockResolvedValueOnce(false);
    // Suspension check: IS suspended
    mockRedisExists.mockResolvedValueOnce(true);

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error).toBeDefined();
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('ACCOUNT_SUSPENDED');
  });

  test('unsuspended customer passes through authMiddleware', async () => {
    const { authMiddleware } = require('../shared/middleware/auth.middleware');
    const token = createTestToken({ userId: 'active-user', role: 'customer' });
    const { req, res, next } = createMockReqResNext(token);

    // JTI blacklist check: not blacklisted
    mockRedisExists.mockResolvedValueOnce(false);
    // Suspension check: NOT suspended
    mockRedisExists.mockResolvedValueOnce(false);

    await authMiddleware(req, res, next);

    // next() called with no error
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    // User should be attached to request
    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe('active-user');
  });

  test('suspension check happens AFTER JTI blacklist check', () => {
    const middlewarePath = path.resolve(__dirname, '../shared/middleware/auth.middleware.ts');
    const middlewareSource = fs.readFileSync(middlewarePath, 'utf-8');

    // Find position of JTI blacklist check and suspension check
    const jtiCheckIdx = middlewareSource.indexOf('blacklist:');
    const suspensionCheckIdx = middlewareSource.indexOf('customer:suspended:');

    expect(jtiCheckIdx).toBeGreaterThan(-1);
    expect(suspensionCheckIdx).toBeGreaterThan(-1);
    // Suspension check must come AFTER JTI blacklist check
    expect(suspensionCheckIdx).toBeGreaterThan(jtiCheckIdx);
  });

  test('Redis failure during suspension check fails-open (request passes)', async () => {
    const { authMiddleware } = require('../shared/middleware/auth.middleware');
    const token = createTestToken({ userId: 'user-redis-down', role: 'customer' });
    const { req, res, next } = createMockReqResNext(token);

    // JTI blacklist check: not blacklisted
    mockRedisExists.mockResolvedValueOnce(false);
    // Suspension check: Redis throws
    mockRedisExists.mockRejectedValueOnce(new Error('Redis connection refused'));

    await authMiddleware(req, res, next);

    // Should pass through (fail-open)
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe('user-redis-down');
  });

  test('no token → 401 UNAUTHORIZED from authMiddleware', async () => {
    const { authMiddleware } = require('../shared/middleware/auth.middleware');
    const { req, res, next } = createMockReqResNext(); // no token

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error).toBeDefined();
    expect(error.statusCode).toBe(401);
  });
});

// =============================================================================
// ISSUE #2 (continued): optionalAuthMiddleware suspension handling
// =============================================================================

describe('Issue #2: optionalAuthMiddleware treats suspended user as unauthenticated', () => {
  function createTestToken(payload: Record<string, unknown>): string {
    const { config } = require('../config/environment');
    return jwt.sign(
      { jti: crypto.randomUUID(), phone: '9876543210', ...payload },
      config.jwt.secret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
  }

  function createMockReqResNext(token?: string) {
    const req: any = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      path: '/test',
    };
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    return { req, res, next };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisExists.mockResolvedValue(false);
  });

  test('suspended user in optionalAuth → req.user NOT set (unauthenticated)', async () => {
    const { optionalAuthMiddleware } = require('../shared/middleware/auth.middleware');
    const token = createTestToken({ userId: 'suspended-user', role: 'customer' });
    const { req, res, next } = createMockReqResNext(token);

    // JTI blacklist: not blacklisted
    mockRedisExists.mockResolvedValueOnce(false);
    // Suspension check: IS suspended
    mockRedisExists.mockResolvedValueOnce(true);

    await optionalAuthMiddleware(req, res, next);

    // Should proceed but WITHOUT req.user (treated as unauthenticated)
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });

  test('active user in optionalAuth → req.user IS set', async () => {
    const { optionalAuthMiddleware } = require('../shared/middleware/auth.middleware');
    const token = createTestToken({ userId: 'active-user', role: 'customer' });
    const { req, res, next } = createMockReqResNext(token);

    // JTI blacklist: not blacklisted
    mockRedisExists.mockResolvedValueOnce(false);
    // Suspension check: NOT suspended
    mockRedisExists.mockResolvedValueOnce(false);

    await optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe('active-user');
  });

  test('Redis down during optionalAuth suspension check → treated as unauthenticated', async () => {
    const { optionalAuthMiddleware } = require('../shared/middleware/auth.middleware');
    const token = createTestToken({ userId: 'user-redis-down', role: 'customer' });
    const { req, res, next } = createMockReqResNext(token);

    // JTI blacklist: not blacklisted
    mockRedisExists.mockResolvedValueOnce(false);
    // Suspension check: Redis throws
    mockRedisExists.mockRejectedValueOnce(new Error('Redis timeout'));

    await optionalAuthMiddleware(req, res, next);

    // optionalAuth treats Redis failure as unauthenticated
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });

  test('no token in optionalAuth → passes through without user', async () => {
    const { optionalAuthMiddleware } = require('../shared/middleware/auth.middleware');
    const { req, res, next } = createMockReqResNext(); // no token

    await optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });
});

// =============================================================================
// STRUCTURAL: authMiddleware uses algorithms restriction
// =============================================================================

describe('Structural: authMiddleware also uses algorithms: [HS256]', () => {
  test('authMiddleware source contains algorithms restriction in jwt.verify', () => {
    const middlewarePath = path.resolve(__dirname, '../shared/middleware/auth.middleware.ts');
    const middlewareSource = fs.readFileSync(middlewarePath, 'utf-8');

    // Both authMiddleware and optionalAuthMiddleware should have algorithms: ['HS256']
    const algorithmsMatches = middlewareSource.match(/algorithms:\s*\['HS256'\]/g);
    expect(algorithmsMatches).not.toBeNull();
    // At least 2 occurrences: one in authMiddleware, one in optionalAuthMiddleware
    expect(algorithmsMatches!.length).toBeGreaterThanOrEqual(2);
  });
});
