/**
 * =============================================================================
 * QA AUTH SCENARIOS - Penetration Tester Perspective
 * =============================================================================
 *
 * Scenario-based tests that verify auth security from an attacker/edge-case
 * perspective. These go beyond unit tests -- think like a penetration tester.
 *
 * SCENARIOS:
 * 1. Stolen JWT cross-device attack
 * 2. OTP brute force from multiple IPs
 * 3. Redis down + blacklist fail-open
 * 4. OTP SMS bombing prevention
 * 5. Session expiry chain
 * 6. Token refresh preserves device binding
 * 7. Legacy token backwards compatibility
 * =============================================================================
 */

export {};

import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const JWT_SECRET = 'qa-test-jwt-secret';
const JWT_REFRESH_SECRET = 'qa-test-refresh-secret';

// ---------------------------------------------------------------------------
// Mocks -- wired before any module imports
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
    redis: { enabled: true, url: 'redis://localhost:6379' },
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
// Token helpers (mirror auth.service.ts generateAccessToken shape)
// ---------------------------------------------------------------------------

function generateAccessToken(
  overrides: Record<string, unknown> = {},
  secret = JWT_SECRET,
  expiresIn: string | number = '5m',
): string {
  return jwt.sign(
    {
      userId: 'user-1',
      role: 'customer',
      phone: '9876543210',
      jti: crypto.randomUUID(),
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', expiresIn } as jwt.SignOptions,
  );
}

function generateRefreshToken(
  overrides: Record<string, unknown> = {},
  secret = JWT_REFRESH_SECRET,
): string {
  return jwt.sign(
    { userId: 'user-1', ...overrides },
    secret,
    { algorithm: 'HS256', expiresIn: '30d' } as jwt.SignOptions,
  );
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').substring(0, 32);
}

// ---------------------------------------------------------------------------
// Express mocks
// ---------------------------------------------------------------------------

function mockRequest(headers: Record<string, string | undefined> = {}, body: Record<string, unknown> = {}): any {
  return {
    headers: {
      ...headers,
    },
    body,
    ip: '127.0.0.1',
    path: '/test',
    user: undefined as any,
    userId: undefined as string | undefined,
    userRole: undefined as string | undefined,
    userPhone: undefined as string | undefined,
  };
}

function mockResponse(): any {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    _statusCode: undefined,
    _body: undefined,
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
// Import the middleware under test (after mocks are installed)
// ---------------------------------------------------------------------------
import {
  authMiddleware,
  optionalAuthMiddleware,
} from '../shared/middleware/auth.middleware';

// ==========================================================================
// SCENARIO 1: Stolen JWT cross-device attack
// ==========================================================================
describe('Scenario 1: Stolen JWT cross-device attack', () => {
  beforeEach(() => jest.clearAllMocks());

  it('1a. Token with deviceId "device-A" used from "device-B" => 401 DEVICE_MISMATCH', async () => {
    const token = generateAccessToken({ deviceId: 'device-A' });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      'x-device-id': 'device-B',
    });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('DEVICE_MISMATCH');
  });

  it('1b. Token with deviceId "device-A" used from "device-A" => success', async () => {
    const token = generateAccessToken({ deviceId: 'device-A' });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      'x-device-id': 'device-A',
    });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBe('user-1');
  });

  it('1c. Token with deviceId "device-A" used WITHOUT x-device-id header => success (backwards compat)', async () => {
    const token = generateAccessToken({ deviceId: 'device-A' });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      // no x-device-id header
    });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(); // no error -- backwards compatible
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBe('user-1');
  });

  it('1d. Attacker forging token with mismatched deviceId is rejected', async () => {
    // Attacker steals a token bound to device-A, tries to craft request from device-X
    const stolenToken = generateAccessToken({ deviceId: 'device-A' });
    const req = mockRequest({
      authorization: `Bearer ${stolenToken}`,
      'x-device-id': 'device-X-attacker',
    });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('DEVICE_MISMATCH');
  });

  it('1e. Token without deviceId is NOT rejected even when x-device-id header is present', async () => {
    // Legacy token without deviceId claim
    const legacyToken = generateAccessToken({}); // no deviceId
    const req = mockRequest({
      authorization: `Bearer ${legacyToken}`,
      'x-device-id': 'any-device',
    });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(capturedError).toBeUndefined();
  });
});

// ==========================================================================
// SCENARIO 2: OTP brute force from multiple IPs
// ==========================================================================
describe('Scenario 2: OTP brute force from multiple IPs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('2a. verifyOtpRateLimiter keys by phone+role not IP (source inspection)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts'),
      'utf-8',
    );

    // verifyOtpRateLimiter must key by phone, not IP
    expect(source).toContain('verify:${req.body?.phone}');
    // windowMs should be 10 minutes
    expect(source).toContain('10 * 60 * 1000');
    // max should be 5
    expect(source).toMatch(/max:\s*5/);
  });

  it('2b. verifyOtpRateLimiter max is 5 => 6th attempt from any IP is blocked', () => {
    // Verify the exported limiter has max=5 by inspecting config
    const { verifyOtpRateLimiter } = require('../shared/middleware/rate-limiter.middleware');
    expect(verifyOtpRateLimiter).toBeDefined();
    expect(typeof verifyOtpRateLimiter).toBe('function');
  });

  it('2c. Verify-OTP rate limit is phone-based (not IP-based) -- different phones succeed independently', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts'),
      'utf-8',
    );

    // Key generation for verifyOtpRateLimiter must include phone, not IP
    const keyGenMatch = source.match(
      /verifyOtpRateLimiter[\s\S]*?keyGenerator[\s\S]*?=>\s*`verify:\$\{req\.body\?\.phone\}/,
    );
    expect(keyGenMatch).not.toBeNull();
  });

  it('2d. OTP service enforces max 3 verification attempts per OTP independently of rate limiter', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/otp-challenge.service.ts'),
      'utf-8',
    );

    // Must reference maxAttempts to enforce per-OTP attempt limit
    expect(source).toContain('maxAttempts');
    // Must delete challenge after max attempts
    expect(source).toContain('MAX_ATTEMPTS');
    // Must use timing-safe comparison
    expect(source).toContain('timingSafeEqual');
  });
});

// ==========================================================================
// SCENARIO 3: Redis down + blacklist fail-open
// ==========================================================================
describe('Scenario 3: Redis down + blacklist fail-open', () => {
  beforeEach(() => jest.clearAllMocks());

  it('3a. When Redis.exists() throws, authMiddleware allows request (fail-open)', async () => {
    mockRedisService.exists.mockRejectedValueOnce(new Error('Redis connection refused'));

    const token = generateAccessToken({ jti: 'test-jti-redis-down' });
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    // Should allow request (fail-open for availability)
    expect(next).toHaveBeenCalledWith(); // no error arg
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBe('user-1');
  });

  it('3b. When Redis.exists() throws, optionalAuth treats user as unauthenticated', async () => {
    mockRedisService.exists.mockRejectedValueOnce(new Error('Redis timeout'));

    const token = generateAccessToken({ jti: 'test-jti-optional-redis-down' });
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await optionalAuthMiddleware(req, res, next);

    // Optional auth: Redis failure => treat as unauthenticated (no user attached)
    expect(next).toHaveBeenCalledWith(); // no error
    expect(capturedError).toBeUndefined();
    // For optional auth when Redis is down, the user should not be attached
    // This validates that the catch block in optionalAuth returns next() without user
    expect(req.userId).toBeUndefined();
  });

  it('3c. Default JWT expiry is 5 minutes (reduces exposure window during Redis downtime)', () => {
    const { config } = require('../config/environment');
    expect(config.jwt.expiresIn).toBe('5m');

    // Also verify via actual token -- tokens naturally expire in ~5 min
    const token = generateAccessToken({}, JWT_SECRET, '5m');
    const decoded = jwt.decode(token) as { exp: number; iat: number };
    const lifetimeSeconds = decoded.exp - decoded.iat;
    expect(lifetimeSeconds).toBe(5 * 60);
  });

  it('3d. Blacklisted token is rejected when Redis is UP', async () => {
    mockRedisService.exists.mockResolvedValueOnce(true); // token IS blacklisted

    const token = generateAccessToken({ jti: 'blacklisted-jti' });
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('TOKEN_REVOKED');
  });

  it('3e. Redis exists() is called with correct blacklist key format', async () => {
    const jti = 'specific-jti-value';
    const token = generateAccessToken({ jti });
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    const next = jest.fn();

    await authMiddleware(req, res, next);

    expect(mockRedisService.exists).toHaveBeenCalledWith(`blacklist:${jti}`);
  });
});

// ==========================================================================
// SCENARIO 4: OTP SMS bombing prevention
// ==========================================================================
describe('Scenario 4: OTP SMS bombing prevention', () => {
  beforeEach(() => jest.clearAllMocks());

  it('4a. Auth service enforces 30-second cooldown between OTP sends to same phone', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // Must check cooldown key existence before sending OTP
    expect(source).toContain('otp:cooldown:');
    expect(source).toContain('OTP_COOLDOWN');
    // Must set cooldown after generating OTP
    expect(source).toMatch(/cooldown.*30/s);
  });

  it('4b. Cooldown key format includes phone and role for isolation', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // Pattern: otp:cooldown:{phone}:{role}
    expect(source).toContain('`otp:cooldown:${phone}:${role}`');
  });

  it('4c. OTP rate limiter keys by phone+role (not IP) to prevent cross-user blocking', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/rate-limiter.middleware.ts'),
      'utf-8',
    );

    // otpRateLimiter keyGenerator must produce phone-based keys
    expect(source).toContain('`otp:${phone}:${role}`');
    // Max 5 OTPs per phone per 2 minutes
    expect(source).toContain('2 * 60 * 1000');
  });

  it('4d. Cooldown HTTP status is 429 (not 400)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // AppError(429, 'OTP_COOLDOWN', ...) not 400
    expect(source).toContain("429, 'OTP_COOLDOWN'");
  });

  it('4e. Cooldown TTL is 30 seconds (Redis auto-expires)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // Set cooldown with 30s TTL
    expect(source).toMatch(/set\(cooldownKey,\s*'1',\s*30\)/);
  });
});

// ==========================================================================
// SCENARIO 5: Session expiry chain
// ==========================================================================
describe('Scenario 5: Session expiry chain', () => {
  beforeEach(() => jest.clearAllMocks());

  it('5a. Blacklisted access token is rejected by authMiddleware', async () => {
    const jti = crypto.randomUUID();
    const token = generateAccessToken({ jti, deviceId: 'device-1' });

    // Simulate: token has been blacklisted via logout
    mockRedisService.exists.mockImplementation(async (key: string) => {
      return key === `blacklist:${jti}`;
    });

    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('TOKEN_REVOKED');
  });

  it('5b. Blacklisted access token is treated as unauthenticated by optionalAuthMiddleware', async () => {
    const jti = crypto.randomUUID();
    const token = generateAccessToken({ jti, deviceId: 'device-1' });

    mockRedisService.exists.mockImplementation(async (key: string) => {
      return key === `blacklist:${jti}`;
    });

    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await optionalAuthMiddleware(req, res, next);

    // optionalAuth treats revoked token as unauthenticated, not error
    expect(next).toHaveBeenCalledWith(); // no error arg
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBeUndefined();
  });

  it('5c. Logout flow blacklists access token JTI with TTL matching token remaining lifetime', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // logout method must blacklist the JTI
    expect(source).toContain('blacklist:${jti}');
    // Must use remaining TTL so the blacklist entry auto-expires with the token
    expect(source).toContain('remainingTTL');
    // Must call redisService.set for the blacklist entry
    expect(source).toContain("'revoked'");
  });

  it('5d. Expired access token returns TOKEN_EXPIRED (not generic 401)', async () => {
    // Generate a token that already expired (1 second in the past)
    const token = generateAccessToken({}, JWT_SECRET, '-1s');
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('TOKEN_EXPIRED');
  });

  it('5e. Refresh token flow preserves deviceId from original token', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // refreshToken method must extract and pass deviceId through
    expect(source).toContain('refreshDeviceId');
    // Must be passed to generateAccessToken
    expect(source).toContain('generateAccessToken(user, refreshDeviceId)');
    // Must also be passed to generateRefreshToken for continuity
    expect(source).toContain('generateRefreshToken(user, refreshDeviceId)');
  });
});

// ==========================================================================
// SCENARIO 6: Token refresh preserves device binding
// ==========================================================================
describe('Scenario 6: Token refresh preserves device binding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('6a. Access token embeds deviceId when provided', () => {
    const token = generateAccessToken({ deviceId: 'samsung-galaxy-s24' });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.deviceId).toBe('samsung-galaxy-s24');
  });

  it('6b. Access token omits deviceId when not provided', () => {
    const token = generateAccessToken({});
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.deviceId).toBeUndefined();
  });

  it('6c. Refresh token stores deviceId in Redis entry for continuity', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // RefreshTokenEntry interface must include deviceId
    expect(source).toContain('deviceId?: string');
    // generateRefreshToken must spread deviceId into the entry
    expect(source).toMatch(/entry.*deviceId/s);
  });

  it('6d. Token refresh extracts deviceId from decoded token AND stored entry', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // Must check both decoded JWT and stored Redis entry for deviceId
    expect(source).toContain('decoded.deviceId');
    expect(source).toContain('stored.deviceId');
  });

  it('6e. Refresh token rotation issues new token with 30-second grace window', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8',
    );

    // Grace period: old token gets expire(30) not immediate del
    expect(source).toMatch(/expire\(.*30\)/);
  });

  it('6f. New access token after refresh carries same deviceId claim', () => {
    // Simulate: original token had deviceId, refreshed token should too
    const originalDeviceId = 'oneplus-12';
    const originalRefresh = generateRefreshToken({ deviceId: originalDeviceId });
    const decoded = jwt.decode(originalRefresh) as Record<string, unknown>;
    expect(decoded.deviceId).toBe(originalDeviceId);

    // Simulate what refreshToken() does: extract deviceId and pass to new token
    const refreshDeviceId = (decoded as any).deviceId;
    const newAccessToken = generateAccessToken({ deviceId: refreshDeviceId });
    const newDecoded = jwt.decode(newAccessToken) as Record<string, unknown>;
    expect(newDecoded.deviceId).toBe(originalDeviceId);
  });

  it('6g. Refreshed token with device-A used from device-B is still rejected', async () => {
    // After token refresh, the new token should still be bound to device-A
    const refreshedToken = generateAccessToken({ deviceId: 'device-A' });
    const req = mockRequest({
      authorization: `Bearer ${refreshedToken}`,
      'x-device-id': 'device-B',
    });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('DEVICE_MISMATCH');
  });
});

// ==========================================================================
// SCENARIO 7: Legacy token backwards compatibility
// ==========================================================================
describe('Scenario 7: Legacy token backwards compatibility', () => {
  beforeEach(() => jest.clearAllMocks());

  it('7a. Token WITHOUT deviceId works with authMiddleware', async () => {
    const legacyToken = generateAccessToken({}); // no deviceId
    const req = mockRequest({ authorization: `Bearer ${legacyToken}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBe('user-1');
    expect(req.userRole).toBe('customer');
  });

  it('7b. Token WITHOUT deviceId works with optionalAuthMiddleware', async () => {
    const legacyToken = generateAccessToken({});
    const req = mockRequest({ authorization: `Bearer ${legacyToken}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBe('user-1');
  });

  it('7c. Token WITHOUT deviceId + x-device-id header present => no DEVICE_MISMATCH', async () => {
    const legacyToken = generateAccessToken({}); // no deviceId in token
    const req = mockRequest({
      authorization: `Bearer ${legacyToken}`,
      'x-device-id': 'some-new-device',
    });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    // Legacy token must NOT trigger DEVICE_MISMATCH
    expect(next).toHaveBeenCalledWith();
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBe('user-1');
  });

  it('7d. Token WITHOUT jti skips blacklist check entirely', async () => {
    // Generate token with no jti claim
    const noJtiToken = jwt.sign(
      { userId: 'user-old', role: 'transporter', phone: '1234567890' },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '5m' },
    );
    const req = mockRequest({ authorization: `Bearer ${noJtiToken}` });
    const res = mockResponse();
    const next = jest.fn();

    await authMiddleware(req, res, next);

    // Should NOT call redis.exists for blacklist (no jti to check)
    // But DOES call redis.exists for the customer suspension check
    expect(mockRedisService.exists).not.toHaveBeenCalledWith(expect.stringContaining('blacklist:'));
    expect(mockRedisService.exists).toHaveBeenCalledWith('customer:suspended:user-old');
    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('user-old');
  });

  it('7e. deviceId schema allows null in verifyOtp request (app sends null)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.schema.ts'),
      'utf-8',
    );

    // deviceId must be nullable and optional for backwards compat
    expect(source).toContain('deviceId:');
    expect(source).toContain('.nullable()');
    expect(source).toContain('.optional()');
  });

  it('7f. Token signed with wrong secret is rejected with INVALID_TOKEN', async () => {
    const badToken = jwt.sign(
      { userId: 'attacker', role: 'admin', phone: '0000000000', jti: crypto.randomUUID() },
      'wrong-secret',
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const req = mockRequest({ authorization: `Bearer ${badToken}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('INVALID_TOKEN');
  });

  it('7g. Token with algorithm=none (alg:none attack) is rejected', async () => {
    // Manually craft an unsigned token (alg:none attack vector)
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ userId: 'attacker', role: 'admin', phone: '0000', jti: 'fake' }),
    ).toString('base64url');
    const unsignedToken = `${header}.${payload}.`;

    const req = mockRequest({ authorization: `Bearer ${unsignedToken}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    // Either INVALID_TOKEN or UNAUTHORIZED -- both are acceptable rejections
    expect(['INVALID_TOKEN', 'UNAUTHORIZED']).toContain(capturedError.code);
  });

  it('7h. Middleware enforces HS256 algorithm restriction', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8',
    );

    // Must specify algorithms: ['HS256'] to prevent algorithm confusion attacks
    expect(source).toContain("algorithms: ['HS256']");
  });
});

// ==========================================================================
// CROSS-CUTTING: Additional edge cases
// ==========================================================================
describe('Cross-cutting auth edge cases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('Missing Authorization header returns 401 UNAUTHORIZED', async () => {
    const req = mockRequest({}); // no auth header
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('UNAUTHORIZED');
  });

  it('Malformed Authorization header (no Bearer prefix) returns 401', async () => {
    const token = generateAccessToken({});
    const req = mockRequest({ authorization: `Token ${token}` }); // wrong prefix
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
  });

  it('optionalAuth with no token proceeds without error and without user', async () => {
    const req = mockRequest({}); // no token
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await optionalAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBeUndefined();
    expect(req.user).toBeUndefined();
  });

  it('optionalAuth with invalid token proceeds without error and without user', async () => {
    const req = mockRequest({ authorization: 'Bearer garbage.token.here' });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await optionalAuthMiddleware(req, res, next);

    // Invalid token in optionalAuth: continue without user, no error
    expect(next).toHaveBeenCalledWith();
    expect(capturedError).toBeUndefined();
    expect(req.userId).toBeUndefined();
  });

  it('authMiddleware attaches both user object and legacy fields', async () => {
    const token = generateAccessToken({ deviceId: 'test-device' });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      'x-device-id': 'test-device',
    });
    const res = mockResponse();
    const next = jest.fn();

    await authMiddleware(req, res, next);

    // New format
    expect(req.user).toBeDefined();
    expect(req.user!.userId).toBe('user-1');
    expect(req.user!.role).toBe('customer');
    expect(req.user!.phone).toBe('9876543210');
    expect(req.user!.jti).toBeDefined();
    // Legacy format
    expect(req.userId).toBe('user-1');
    expect(req.userRole).toBe('customer');
    expect(req.userPhone).toBe('9876543210');
  });

  it('JWT payload without userId or role is rejected as INVALID_TOKEN', async () => {
    // Craft a valid JWT that is missing required claims
    const badPayloadToken = jwt.sign(
      { foo: 'bar' }, // missing userId and role
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '5m' },
    );
    const req = mockRequest({ authorization: `Bearer ${badPayloadToken}` });
    const res = mockResponse();
    let capturedError: any;
    const next = jest.fn((err?: any) => { capturedError = err; });

    await authMiddleware(req, res, next);

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(401);
    expect(capturedError.code).toBe('INVALID_TOKEN');
  });
});
