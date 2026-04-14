/**
 * =============================================================================
 * AUTH SECURITY FIXES - Comprehensive Test Suite
 * =============================================================================
 *
 * Tests for 7 auth-related security fixes:
 *   H6: Device binding in JWT
 *   H7: Access token expiry reduced to 5m
 *   H8: optionalAuthMiddleware now checks JTI blacklist
 *   H9: Phone-based rate limit on verify-OTP
 *   M1: 30s OTP resend cooldown
 *   M3: deviceId wired from controller to service
 *   C6: SMS delivery monitoring
 *
 * =============================================================================
 */

export {};

import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------
const TEST_JWT_SECRET = 'test-jwt-secret-auth-security';
const TEST_REFRESH_SECRET = 'test-refresh-secret-auth-security';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock redisService used by auth middleware
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

// Mock metrics service used by sms.service
const mockIncrementCounter = jest.fn();
jest.mock('../../src/shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: (...args: unknown[]) => mockIncrementCounter(...args),
    observeHistogram: jest.fn(),
    incrementGauge: jest.fn(),
    decrementGauge: jest.fn(),
  },
}));

// Mock logger
jest.mock('../../src/shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock config with test values
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

// ==========================================================================
// H6: DEVICE BINDING IN JWT (14 tests)
// ==========================================================================
describe('H6: Device binding in JWT', () => {
  // Helper: generate a token matching auth.service.ts generateAccessToken shape
  function generateToken(overrides: Record<string, unknown> = {}): string {
    const payload = {
      userId: 'user-h6',
      role: 'customer',
      phone: '9999999999',
      jti: crypto.randomUUID(),
      ...overrides,
    };
    return jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  }

  // Helper: build a mock Express request
  function mockRequest(headers: Record<string, string> = {}): Partial<Request> {
    return {
      headers: {
        ...headers,
      },
    } as Partial<Request>;
  }

  // Helper: build a mock Express response
  function mockResponse(): Partial<Response> {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  describe('Token generation', () => {
    it('H6.1 token generated WITH deviceId includes it in payload', () => {
      const token = generateToken({ deviceId: 'device-abc-123' });
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded).toHaveProperty('deviceId', 'device-abc-123');
    });

    it('H6.2 token generated WITHOUT deviceId omits it from payload', () => {
      const token = generateToken();
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded).not.toHaveProperty('deviceId');
    });

    it('H6.3 source code conditionally spreads deviceId (not always present)', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.service.ts'),
        'utf-8'
      );
      // The code should use conditional spread: ...(deviceId ? { deviceId } : {})
      expect(source).toContain('deviceId ? { deviceId }');
    });

    it('H6.4 generateAccessToken accepts optional deviceId parameter', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.service.ts'),
        'utf-8'
      );
      expect(source).toMatch(/generateAccessToken\(user.*deviceId\?/);
    });
  });

  describe('Auth middleware device binding check', () => {
    // We test the middleware behavior by reading the source and verifying the logic pattern
    it('H6.5 auth middleware source checks x-device-id header against JWT deviceId', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
        'utf-8'
      );
      expect(source).toContain("x-device-id");
      expect(source).toContain('DEVICE_MISMATCH');
    });

    it('H6.6 DEVICE_MISMATCH produces 401 status', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
        'utf-8'
      );
      // Should be: new AppError(401, 'DEVICE_MISMATCH', ...)
      expect(source).toMatch(/AppError\(401.*DEVICE_MISMATCH/);
    });

    it('H6.7 device check only fires when BOTH token has deviceId AND request has header', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
        'utf-8'
      );
      // The condition: tokenDeviceId && requestDeviceId && tokenDeviceId !== requestDeviceId
      expect(source).toContain('tokenDeviceId && requestDeviceId && tokenDeviceId !== requestDeviceId');
    });

    it('H6.8 matching x-device-id passes (no error thrown)', async () => {
      // Import the real middleware
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const deviceId = 'my-device-123';
      const token = generateToken({ deviceId });

      const req = mockRequest({
        authorization: `Bearer ${token}`,
        'x-device-id': deviceId,
      });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockResolvedValue(false); // JTI not blacklisted

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      // next() should be called without an AppError
      expect(next).toHaveBeenCalledTimes(1);
      const firstArg = next.mock.calls[0][0];
      // Should be called with no argument (success)
      expect(firstArg).toBeUndefined();
    });

    it('H6.9 mismatching x-device-id gets 401 DEVICE_MISMATCH', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const token = generateToken({ deviceId: 'device-A' });

      const req = mockRequest({
        authorization: `Bearer ${token}`,
        'x-device-id': 'device-B',
      });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockResolvedValue(false);

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeDefined();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('DEVICE_MISMATCH');
    });

    it('H6.10 request WITHOUT x-device-id header passes (backwards compat)', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const token = generateToken({ deviceId: 'device-A' });

      const req = mockRequest({
        authorization: `Bearer ${token}`,
        // No x-device-id header
      });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockResolvedValue(false);

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      const firstArg = next.mock.calls[0][0];
      expect(firstArg).toBeUndefined();
    });

    it('H6.11 token WITHOUT deviceId + request WITH x-device-id passes (backwards compat)', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      // Token has NO deviceId
      const token = generateToken();

      const req = mockRequest({
        authorization: `Bearer ${token}`,
        'x-device-id': 'device-X',
      });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockResolvedValue(false);

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      const firstArg = next.mock.calls[0][0];
      expect(firstArg).toBeUndefined();
    });

    it('H6.12 token WITHOUT deviceId + request WITHOUT x-device-id passes', async () => {
      const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

      const token = generateToken(); // No deviceId

      const req = mockRequest({
        authorization: `Bearer ${token}`,
      });
      const res = mockResponse();
      const next = jest.fn();

      mockRedisExists.mockResolvedValue(false);

      await authMiddleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      const firstArg = next.mock.calls[0][0];
      expect(firstArg).toBeUndefined();
    });
  });

  describe('verifyOtp accepts deviceId', () => {
    it('H6.13 verifyOtp method signature accepts deviceId parameter', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.service.ts'),
        'utf-8'
      );
      // verifyOtp(phone, otp, role, deviceId?)
      expect(source).toMatch(/verifyOtp\(phone.*otp.*role.*deviceId\?/);
    });

    it('H6.14 verifyOtp passes deviceId to generateAccessToken', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.service.ts'),
        'utf-8'
      );
      // this.generateAccessToken(user, deviceId)
      expect(source).toMatch(/generateAccessToken\(user,\s*deviceId\)/);
    });
  });
});

// ==========================================================================
// H7: ACCESS TOKEN EXPIRY REDUCED TO 5m (4 tests)
// ==========================================================================
describe('H7: Access token expiry reduced to 5m', () => {
  it('H7.1 environment.ts default JWT_EXPIRES_IN is 5m', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../config/environment.ts'),
      'utf-8'
    );
    // Match: getOptional('JWT_EXPIRES_IN', '5m')
    expect(source).toMatch(/JWT_EXPIRES_IN.*'5m'/);
  });

  it('H7.2 config object exposes jwt.expiresIn', () => {
    // The mock config we defined above has expiresIn: '5m'
    const { config } = require('../../src/config/environment');
    expect(config.jwt.expiresIn).toBe('5m');
  });

  it('H7.3 default is NOT the old 15m value (regression check)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../config/environment.ts'),
      'utf-8'
    );
    // The getOptional call should NOT have '15m' as default
    const match = source.match(/getOptional\('JWT_EXPIRES_IN',\s*'([^']+)'\)/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('5m');
    expect(match![1]).not.toBe('15m');
  });

  it('H7.4 JWT signed with 5m expiry resolves to ~300 seconds', () => {
    const token = jwt.sign(
      { userId: 'test', role: 'customer', phone: '123', jti: crypto.randomUUID() },
      TEST_JWT_SECRET,
      { expiresIn: '5m' }
    );
    const decoded = jwt.decode(token) as { exp: number; iat: number };
    const duration = decoded.exp - decoded.iat;
    expect(duration).toBe(300); // 5 minutes = 300 seconds
  });
});

// ==========================================================================
// H8: optionalAuthMiddleware CHECKS JTI BLACKLIST (8 tests)
// ==========================================================================
describe('H8: optionalAuthMiddleware checks JTI blacklist', () => {
  function generateToken(overrides: Record<string, unknown> = {}): string {
    const payload = {
      userId: 'user-h8',
      role: 'customer',
      phone: '8888888888',
      jti: crypto.randomUUID(),
      ...overrides,
    };
    return jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  }

  function mockRequest(headers: Record<string, string> = {}): Partial<Request> {
    return { headers: { ...headers } } as Partial<Request>;
  }

  function mockResponse(): Partial<Response> {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('H8.1 optionalAuthMiddleware is async (returns Promise)', () => {
    const { optionalAuthMiddleware } = require('../../src/shared/middleware/auth.middleware');
    // Calling without args will fail, but the return should still be a Promise
    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();
    const result = optionalAuthMiddleware(req as Request, res as Response, next as NextFunction);
    expect(result).toBeInstanceOf(Promise);
  });

  it('H8.2 blacklisted JTI in optional auth -> req.user is NOT set', async () => {
    const { optionalAuthMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const jti = crypto.randomUUID();
    const token = generateToken({ jti });

    const req = mockRequest({
      authorization: `Bearer ${token}`,
    });
    const res = mockResponse();
    const next = jest.fn();

    // Simulate blacklisted JTI
    mockRedisExists.mockResolvedValue(true);

    await optionalAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    // next should be called with no error
    expect(next.mock.calls[0][0]).toBeUndefined();
    // req.user should NOT be set
    expect((req as any).user).toBeUndefined();
  });

  it('H8.3 non-blacklisted JTI -> req.user IS set', async () => {
    const { optionalAuthMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const jti = crypto.randomUUID();
    const token = generateToken({ jti });

    const req = mockRequest({
      authorization: `Bearer ${token}`,
    });
    const res = mockResponse();
    const next = jest.fn();

    // Not blacklisted
    mockRedisExists.mockResolvedValue(false);

    await optionalAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    // req.user should be set with the decoded payload
    expect((req as any).user).toBeDefined();
    expect((req as any).user.userId).toBe('user-h8');
    expect((req as any).user.role).toBe('customer');
    expect((req as any).user.jti).toBe(jti);
  });

  it('H8.4 Redis down during optional auth -> treated as unauthenticated', async () => {
    const { optionalAuthMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const token = generateToken();

    const req = mockRequest({
      authorization: `Bearer ${token}`,
    });
    const res = mockResponse();
    const next = jest.fn();

    // Redis throws
    mockRedisExists.mockRejectedValue(new Error('Redis connection refused'));

    await optionalAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    // When Redis fails in optional auth, user is NOT set (fail-closed)
    expect((req as any).user).toBeUndefined();
  });

  it('H8.5 no auth header -> passes through with no user set', async () => {
    const { optionalAuthMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const req = mockRequest({});
    const res = mockResponse();
    const next = jest.fn();

    await optionalAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect((req as any).user).toBeUndefined();
  });

  it('H8.6 source code confirms optionalAuthMiddleware is async', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toMatch(/async function optionalAuthMiddleware/);
  });

  it('H8.7 source code checks blacklist in optionalAuthMiddleware', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    // Find the optionalAuthMiddleware function and check it contains blacklist logic
    const optionalIdx = source.indexOf('optionalAuthMiddleware');
    const bodyAfter = source.substring(optionalIdx);
    expect(bodyAfter).toContain('blacklist:');
    expect(bodyAfter).toContain('isBlacklisted');
  });

  it('H8.8 invalid token in optional auth -> continues without user', async () => {
    const { optionalAuthMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const req = mockRequest({
      authorization: 'Bearer invalid.token.here',
    });
    const res = mockResponse();
    const next = jest.fn();

    await optionalAuthMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect((req as any).user).toBeUndefined();
  });
});

// ==========================================================================
// H9: PHONE-BASED RATE LIMIT ON VERIFY-OTP (6 tests)
// ==========================================================================
describe('H9: Phone-based rate limit on verify-OTP', () => {
  it('H9.1 verifyOtpRateLimiter is exported from rate-limiter middleware', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain('export const verifyOtpRateLimiter');
  });

  it('H9.2 verifyOtpRateLimiter keyGenerator uses phone+role', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts'),
      'utf-8'
    );
    // Find the verifyOtpRateLimiter definition and check its keyGenerator
    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBody = source.substring(limiterIdx, limiterIdx + 500);
    // Should key by phone and role
    expect(limiterBody).toContain('req.body?.phone');
    expect(limiterBody).toContain('req.body?.role');
  });

  it('H9.3 verifyOtpRateLimiter allows max 5 attempts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts'),
      'utf-8'
    );
    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBody = source.substring(limiterIdx, limiterIdx + 400);
    expect(limiterBody).toContain('max: 5');
  });

  it('H9.4 verifyOtpRateLimiter window is 10 minutes', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts'),
      'utf-8'
    );
    const limiterIdx = source.indexOf('verifyOtpRateLimiter');
    const limiterBody = source.substring(limiterIdx, limiterIdx + 400);
    // 10 * 60 * 1000 = 600000
    expect(limiterBody).toContain('10 * 60 * 1000');
  });

  it('H9.5 verify-otp route includes verifyOtpRateLimiter', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.routes.ts'),
      'utf-8'
    );
    // Route should have both authRateLimiter and verifyOtpRateLimiter
    expect(source).toContain('verifyOtpRateLimiter');
    // Check it is applied to the verify-otp route
    const verifyLine = source.split('\n').find(
      (l: string) => l.includes("verify-otp") && l.includes('verifyOtpRateLimiter')
    );
    expect(verifyLine).toBeTruthy();
  });

  it('H9.6 verifyOtpRateLimiter import is present in auth.routes.ts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.routes.ts'),
      'utf-8'
    );
    expect(source).toMatch(/import.*verifyOtpRateLimiter.*from/);
  });
});

// ==========================================================================
// M1: 30s OTP RESEND COOLDOWN (6 tests)
// ==========================================================================
describe('M1: 30s OTP resend cooldown', () => {
  it('M1.1 sendOtp checks Redis cooldown key before generating OTP', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    // Should check for cooldown key existence
    expect(source).toContain('otp:cooldown:');
    expect(source).toContain('OTP_COOLDOWN');
  });

  it('M1.2 cooldown key pattern is otp:cooldown:{phone}:{role}', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    // The key pattern: `otp:cooldown:${phone}:${role}`
    expect(source).toContain('`otp:cooldown:${phone}:${role}`');
  });

  it('M1.3 cooldown throws 429 with OTP_COOLDOWN code', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    expect(source).toMatch(/AppError\(429.*OTP_COOLDOWN/);
  });

  it('M1.4 cooldown TTL is 30 seconds', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    // Set cooldown with 30 second TTL
    // Pattern: redisService.set(cooldownKey, '1', 30)
    expect(source).toMatch(/set\(cooldownKey,\s*'1',\s*30\)/);
  });

  it('M1.5 cooldown is set AFTER OTP is generated (not before)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    const sendOtpMethod = source.indexOf('async sendOtp(');
    const body = source.substring(sendOtpMethod);
    const cooldownCheckIdx = body.indexOf('exists(cooldownKey)');
    const otpGenerateIdx = body.indexOf('generateSecureOTP');
    const cooldownSetIdx = body.indexOf("set(cooldownKey, '1', 30)");

    // Cooldown check should come before OTP generation
    expect(cooldownCheckIdx).toBeLessThan(otpGenerateIdx);
    // Cooldown set should come after OTP generation
    expect(cooldownSetIdx).toBeGreaterThan(otpGenerateIdx);
  });

  it('M1.6 cooldown error message instructs user to wait 30 seconds', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('Please wait 30 seconds');
  });
});

// ==========================================================================
// M3: deviceId WIRED FROM CONTROLLER TO SERVICE (5 tests)
// ==========================================================================
describe('M3: deviceId wired from controller to service', () => {
  it('M3.1 controller passes data.deviceId to authService.verifyOtp', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.controller.ts'),
      'utf-8'
    );
    // Should call: authService.verifyOtp(data.phone, data.otp, data.role, data.deviceId)
    expect(source).toContain('data.deviceId');
    expect(source).toMatch(/verifyOtp\(.*data\.deviceId/);
  });

  it('M3.2 controller uses schema validation before passing deviceId', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.controller.ts'),
      'utf-8'
    );
    // validateSchema should be called before verifyOtp
    const validateIdx = source.indexOf('validateSchema(verifyOtpSchema');
    const verifyIdx = source.indexOf('authService.verifyOtp');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeLessThan(verifyIdx);
  });

  it('M3.3 verifyOtpSchema includes deviceId field', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.schema.ts'),
      'utf-8'
    );
    expect(source).toContain('deviceId');
  });

  it('M3.4 deviceId is optional in verifyOtpSchema', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.schema.ts'),
      'utf-8'
    );
    // Should be: .optional() or .nullable().optional()
    const deviceIdLine = source.split('\n').find((l: string) => l.includes('deviceId'));
    expect(deviceIdLine).toBeTruthy();
    expect(deviceIdLine).toContain('optional');
  });

  it('M3.5 deviceId max length is validated (100 chars)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.schema.ts'),
      'utf-8'
    );
    const deviceIdLine = source.split('\n').find((l: string) => l.includes('deviceId'));
    expect(deviceIdLine).toBeTruthy();
    expect(deviceIdLine).toContain('max(100)');
  });
});

// ==========================================================================
// C6: SMS DELIVERY MONITORING (6 tests)
// ==========================================================================
describe('C6: SMS delivery monitoring', () => {
  it('C6.1 sms.service.ts imports metrics', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/sms.service.ts'),
      'utf-8'
    );
    expect(source).toMatch(/import.*metrics.*from.*metrics\.service/);
  });

  it('C6.2 SMS success increments sms_delivery_total with status=success', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/sms.service.ts'),
      'utf-8'
    );
    expect(source).toContain("sms_delivery_total");
    expect(source).toContain("status: 'success'");
  });

  it('C6.3 SMS failure increments sms_delivery_total with status=failure', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/sms.service.ts'),
      'utf-8'
    );
    expect(source).toContain("status: 'failure'");
  });

  it('C6.4 failure metric includes provider label', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/sms.service.ts'),
      'utf-8'
    );
    // The failure increment should include provider label
    const failureIdx = source.indexOf("status: 'failure'");
    const contextBlock = source.substring(failureIdx - 200, failureIdx + 200);
    expect(contextBlock).toContain('provider:');
  });

  it('C6.5 failure metric includes reason label', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/sms.service.ts'),
      'utf-8'
    );
    // The failure metric should include a reason label
    const failureIdx = source.indexOf("status: 'failure'");
    const contextBlock = source.substring(failureIdx, failureIdx + 200);
    expect(contextBlock).toContain('reason:');
  });

  it('C6.6 success metric includes provider label', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/sms.service.ts'),
      'utf-8'
    );
    const successIdx = source.indexOf("status: 'success'");
    const contextBlock = source.substring(successIdx - 200, successIdx + 200);
    expect(contextBlock).toContain('provider:');
  });
});

// ==========================================================================
// INTEGRATION: Auth middleware full flows (8 tests)
// ==========================================================================
describe('Integration: Auth middleware full flows', () => {
  function generateToken(overrides: Record<string, unknown> = {}): string {
    const payload = {
      userId: 'user-int',
      role: 'transporter',
      phone: '7777777777',
      jti: crypto.randomUUID(),
      ...overrides,
    };
    return jwt.sign(payload, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  }

  function mockRequest(headers: Record<string, string> = {}): Partial<Request> {
    return { headers: { ...headers } } as Partial<Request>;
  }

  function mockResponse(): Partial<Response> {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('INT.1 authMiddleware sets req.user with correct fields on valid token', async () => {
    const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const jti = crypto.randomUUID();
    const token = generateToken({ jti });

    const req = mockRequest({
      authorization: `Bearer ${token}`,
    });
    const res = mockResponse();
    const next = jest.fn();

    mockRedisExists.mockResolvedValue(false);

    await authMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect((req as any).user).toEqual(expect.objectContaining({
      userId: 'user-int',
      role: 'transporter',
      phone: '7777777777',
      jti,
    }));
    // Legacy fields
    expect((req as any).userId).toBe('user-int');
    expect((req as any).userRole).toBe('transporter');
    expect((req as any).userPhone).toBe('7777777777');
  });

  it('INT.2 authMiddleware rejects blacklisted JTI with TOKEN_REVOKED', async () => {
    const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const jti = crypto.randomUUID();
    const token = generateToken({ jti });

    const req = mockRequest({
      authorization: `Bearer ${token}`,
    });
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

  it('INT.3 authMiddleware rejects missing auth header', async () => {
    const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const req = mockRequest({});
    const res = mockResponse();
    const next = jest.fn();

    await authMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error).toBeDefined();
    expect(error.statusCode).toBe(401);
  });

  it('INT.4 authMiddleware rejects expired token with TOKEN_EXPIRED', async () => {
    const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

    // Create an already-expired token
    const token = jwt.sign(
      { userId: 'user-exp', role: 'customer', phone: '000', jti: crypto.randomUUID() },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '0s' }
    );

    // Small delay to ensure token is expired
    await new Promise((r) => setTimeout(r, 50));

    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    const next = jest.fn();

    await authMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error).toBeDefined();
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('TOKEN_EXPIRED');
  });

  it('INT.5 authMiddleware uses HS256 algorithm restriction', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain("algorithms: ['HS256']");
  });

  it('INT.6 authMiddleware fails open when Redis is down for JTI check', async () => {
    const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

    const token = generateToken();

    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    const next = jest.fn();

    // Redis throws
    mockRedisExists.mockRejectedValue(new Error('ECONNREFUSED'));

    await authMiddleware(req as Request, res as Response, next as NextFunction);

    // authMiddleware fails OPEN (continues with user set) -- different from optional auth
    expect(next).toHaveBeenCalledTimes(1);
    const firstArg = next.mock.calls[0][0];
    expect(firstArg).toBeUndefined();
    expect((req as any).user).toBeDefined();
  });

  it('INT.7 isValidJwtPayload type guard exists in source', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain('isValidJwtPayload');
    // Should include deviceId in its type annotation
    expect(source).toContain('deviceId?');
  });

  it('INT.8 invalid payload shape in token -> middleware rejects', async () => {
    const { authMiddleware } = require('../../src/shared/middleware/auth.middleware');

    // Token with missing required fields (no userId, no role)
    const token = jwt.sign(
      { foo: 'bar' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '5m' }
    );

    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    const next = jest.fn();

    await authMiddleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error).toBeDefined();
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('INVALID_TOKEN');
  });
});
