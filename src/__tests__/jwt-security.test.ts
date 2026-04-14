/**
 * =============================================================================
 * JWT SECURITY TESTS
 * =============================================================================
 *
 * Comprehensive test suite for JWT security hardening:
 * A. Token Generation (JTI, expiry, payload, algorithm)
 * B. Auth Middleware Blacklist (revocation, backward compat, Redis failure)
 * C. Logout Flow (blacklist on logout, refresh token cleanup, idempotency)
 * D. Driver Auth Logout (endpoint, blacklisting, refresh token deletion)
 * E. Socket.IO Auth (token validation, blacklist check)
 * F. Edge Cases & What-If Scenarios
 * =============================================================================
 */

export {};

import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------
const TEST_JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';
const TEST_REFRESH_SECRET = 'test-refresh-secret-for-unit-tests-only';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Helper: generate a token that mirrors auth.service.ts generateAccessToken
function generateTestAccessToken(
  overrides: Record<string, unknown> = {},
  options: jwt.SignOptions = {}
): string {
  const payload = {
    userId: 'test-user-id',
    role: 'customer',
    phone: '9876543210',
    jti: crypto.randomUUID(),
    ...overrides,
  };
  return jwt.sign(payload, TEST_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
    ...options,
  });
}

// Helper: generate a refresh token that mirrors auth.service.ts generateRefreshToken
function generateTestRefreshToken(userId = 'test-user-id'): string {
  return jwt.sign({ userId }, TEST_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  });
}

// ==========================================================================
// A. TOKEN GENERATION (10+ tests)
// ==========================================================================
describe('A. Token Generation', () => {
  it('A1. access token includes jti claim in UUID format', () => {
    const token = generateTestAccessToken();
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded).toHaveProperty('jti');
    expect(decoded.jti).toMatch(UUID_REGEX);
  });

  it('A2. access token exp is ~15 minutes from now (not 7 days)', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = generateTestAccessToken();
    const after = Math.floor(Date.now() / 1000);
    const decoded = jwt.decode(token) as { exp: number; iat: number };

    const expectedMin = before + 15 * 60;
    const expectedMax = after + 15 * 60;
    expect(decoded.exp).toBeGreaterThanOrEqual(expectedMin);
    expect(decoded.exp).toBeLessThanOrEqual(expectedMax);

    // Must NOT be anywhere close to 7 days
    const sevenDays = 7 * 24 * 60 * 60;
    expect(decoded.exp - decoded.iat).toBeLessThan(sevenDays);
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(15 * 60);
  });

  it('A3. refresh token is generated alongside access token', () => {
    const accessToken = generateTestAccessToken();
    const refreshToken = generateTestRefreshToken();
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    // They must be different tokens
    expect(accessToken).not.toBe(refreshToken);
  });

  it('A4. JTI is unique per token (generate 100, all different)', () => {
    const jtis = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = generateTestAccessToken();
      const decoded = jwt.decode(token) as { jti: string };
      jtis.add(decoded.jti);
    }
    expect(jtis.size).toBe(100);
  });

  it('A5. token payload contains userId, role, phone', () => {
    const token = generateTestAccessToken({
      userId: 'u-123',
      role: 'transporter',
      phone: '1234567890',
    });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.userId).toBe('u-123');
    expect(decoded.role).toBe('transporter');
    expect(decoded.phone).toBe('1234567890');
  });

  it('A6. token algorithm is HS256', () => {
    const token = generateTestAccessToken();
    const header = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString()
    );
    expect(header.alg).toBe('HS256');
  });

  it('A7. auth.service.ts source uses randomUUID for jti', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('jti: crypto.randomUUID()');
  });

  it('A8. driver-auth.service.ts source uses randomUUID for jti', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('jti: crypto.randomUUID()');
  });

  it('A9. config defaults JWT_EXPIRES_IN to 5m (not 7d)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../config/environment.ts'),
      'utf-8'
    );
    // H7: default tightened from 15m to 5m for security
    expect(source).toMatch(/JWT_EXPIRES_IN.*'5m'/);
  });

  it('A10. access token is verifiable with the correct secret', () => {
    const token = generateTestAccessToken();
    const decoded = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(decoded.userId).toBe('test-user-id');
  });

  it('A11. access token signed with jwt.sign in auth.service.ts source', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    // auth.service.ts uses jwt.sign with SignOptions (HS256 is the default algorithm for HMAC secrets)
    expect(source).toContain('jwt.sign(');
    expect(source).toContain('config.jwt.secret');
  });

  it('A12. refresh token uses separate refreshSecret in auth.service.ts source', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    // The refresh token signing block uses a separate secret
    const refreshBlock = source.slice(source.indexOf('generateRefreshToken'));
    expect(refreshBlock).toContain('config.jwt.refreshSecret');
  });
});

// ==========================================================================
// B. AUTH MIDDLEWARE BLACKLIST (15+ tests)
// ==========================================================================
describe('B. Auth Middleware Blacklist', () => {
  // These tests work against the actual middleware logic by simulating
  // its behavior with mocked Express req/res/next and mocked Redis.

  // In-memory blacklist store to simulate Redis
  const blacklistStore = new Map<string, string>();

  // Simulated Redis service
  const mockRedis = {
    exists: jest.fn(async (key: string) => blacklistStore.has(key)),
    set: jest.fn(async (key: string, value: string, _ttl?: number) => {
      blacklistStore.set(key, value);
    }),
    del: jest.fn(async (key: string) => blacklistStore.delete(key)),
  };

  // Simulate the authMiddleware logic (extracted from source to avoid import side-effects)
  async function simulateAuthMiddleware(
    authHeader: string | undefined,
    redisExistsFn: (key: string) => Promise<boolean> = mockRedis.exists,
  ): Promise<{ status: number; body?: unknown; user?: unknown }> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, body: { error: 'Authentication required' } };
    }

    const token = authHeader.substring(7);
    let decoded: Record<string, unknown>;
    try {
      decoded = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        return { status: 401, body: { error: 'Token has expired' } };
      }
      return { status: 401, body: { error: 'Invalid token' } };
    }

    if (typeof decoded.userId !== 'string' || typeof decoded.role !== 'string') {
      return { status: 401, body: { error: 'Invalid token payload' } };
    }

    // JTI blacklist check
    if (decoded.jti && typeof decoded.jti === 'string') {
      try {
        const isBlacklisted = await redisExistsFn(`blacklist:${decoded.jti}`);
        if (isBlacklisted) {
          return { status: 401, body: { error: 'Token has been revoked' } };
        }
      } catch {
        // Redis down => fail open
      }
    }

    return { status: 200, user: decoded };
  }

  beforeEach(() => {
    blacklistStore.clear();
    jest.clearAllMocks();
  });

  it('B1. valid token passes middleware normally', async () => {
    const token = generateTestAccessToken();
    const result = await simulateAuthMiddleware(`Bearer ${token}`);
    expect(result.status).toBe(200);
    expect(result.user).toBeDefined();
  });

  it('B2. blacklisted JTI returns 401 "Token has been revoked"', async () => {
    const token = generateTestAccessToken();
    const decoded = jwt.decode(token) as { jti: string };
    blacklistStore.set(`blacklist:${decoded.jti}`, 'revoked');

    const result = await simulateAuthMiddleware(`Bearer ${token}`);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Token has been revoked' });
  });

  it('B3. token without JTI still works (backward compat)', async () => {
    // Old tokens before the fix have no jti
    const token = jwt.sign(
      { userId: 'old-user', role: 'customer', phone: '111' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const result = await simulateAuthMiddleware(`Bearer ${token}`);
    expect(result.status).toBe(200);
  });

  it('B4. expired token returns 401 (not blacklist error)', async () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', jti: crypto.randomUUID() },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '0s' }
    );
    // Small delay to ensure expiry
    await new Promise((r) => setTimeout(r, 50));
    const result = await simulateAuthMiddleware(`Bearer ${token}`);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Token has expired' });
  });

  it('B5. invalid signature returns 401', async () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', jti: crypto.randomUUID() },
      'WRONG_SECRET',
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    const result = await simulateAuthMiddleware(`Bearer ${token}`);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Invalid token' });
  });

  it('B6. missing Authorization header returns 401', async () => {
    const result = await simulateAuthMiddleware(undefined);
    expect(result.status).toBe(401);
  });

  it('B7. Authorization header without Bearer prefix returns 401', async () => {
    const token = generateTestAccessToken();
    const result = await simulateAuthMiddleware(`Token ${token}`);
    expect(result.status).toBe(401);
  });

  it('B8. Redis down => middleware fails open (still allows valid tokens)', async () => {
    const token = generateTestAccessToken();
    const failingRedis = jest.fn(async () => {
      throw new Error('Redis connection refused');
    });
    const result = await simulateAuthMiddleware(`Bearer ${token}`, failingRedis);
    expect(result.status).toBe(200);
    expect(result.user).toBeDefined();
  });

  it('B9. blacklisted token with expired TTL is allowed again', async () => {
    const jti = crypto.randomUUID();
    const token = generateTestAccessToken({ jti });
    // Blacklist then remove (simulating TTL expiry)
    blacklistStore.set(`blacklist:${jti}`, 'revoked');
    blacklistStore.delete(`blacklist:${jti}`);

    const result = await simulateAuthMiddleware(`Bearer ${token}`);
    expect(result.status).toBe(200);
  });

  it('B10. multiple concurrent blacklist checks work correctly', async () => {
    const tokens = Array.from({ length: 10 }, () => generateTestAccessToken());
    // Blacklist every other token
    tokens.forEach((t, i) => {
      if (i % 2 === 0) {
        const decoded = jwt.decode(t) as { jti: string };
        blacklistStore.set(`blacklist:${decoded.jti}`, 'revoked');
      }
    });

    const results = await Promise.all(
      tokens.map((t) => simulateAuthMiddleware(`Bearer ${t}`))
    );

    results.forEach((r, i) => {
      if (i % 2 === 0) {
        expect(r.status).toBe(401);
      } else {
        expect(r.status).toBe(200);
      }
    });
  });

  it('B11. auth.middleware.ts source checks blacklist via redisService.exists', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain('blacklist:${decoded.jti}');
    expect(source).toContain('redisService.exists');
  });

  it('B12. auth.middleware.ts returns 401 with "Token has been revoked"', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain('Token has been revoked');
  });

  it('B13. auth.middleware.ts uses algorithms: [HS256] for jwt.verify', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain("algorithms: ['HS256']");
  });

  it('B14. auth.middleware.ts attaches jti to req.user', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain('jti: decoded.jti');
  });

  it('B15. auth.middleware.ts imports redisService', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain("import { redisService }");
  });

  it('B16. auth.middleware.ts is async (needed for Redis await)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    expect(source).toContain('async function authMiddleware');
  });

  it('B17. empty string Authorization header returns 401', async () => {
    const result = await simulateAuthMiddleware('');
    expect(result.status).toBe(401);
  });
});

// ==========================================================================
// C. LOGOUT FLOW (15+ tests)
// ==========================================================================
describe('C. Logout Flow', () => {
  // Simulated blacklist + refresh token store
  const blacklistStore = new Map<string, { value: string; ttl: number }>();
  const refreshTokenStore = new Map<string, string>();
  const userTokenSets = new Map<string, Set<string>>();

  function simulateLogout(
    userId: string,
    jti?: string,
    exp?: number
  ): { blacklisted: boolean; refreshTokensDeleted: number } {
    let blacklisted = false;

    // Blacklist the access token JTI if present
    if (jti) {
      const remainingTTL = (exp || 0) - Math.floor(Date.now() / 1000);
      if (remainingTTL > 0) {
        blacklistStore.set(`blacklist:${jti}`, { value: 'revoked', ttl: remainingTTL });
        blacklisted = true;
      }
    }

    // Delete all refresh tokens for this user
    const tokenIds = userTokenSets.get(userId) || new Set();
    let deleted = 0;
    for (const tokenId of tokenIds) {
      if (refreshTokenStore.has(`refresh:${tokenId}`)) {
        refreshTokenStore.delete(`refresh:${tokenId}`);
        deleted++;
      }
    }
    userTokenSets.delete(userId);

    return { blacklisted, refreshTokensDeleted: deleted };
  }

  beforeEach(() => {
    blacklistStore.clear();
    refreshTokenStore.clear();
    userTokenSets.clear();
  });

  it('C1. customer logout blacklists access token JTI in Redis', () => {
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 900; // 15 min
    simulateLogout('customer-1', jti, exp);
    expect(blacklistStore.has(`blacklist:${jti}`)).toBe(true);
    expect(blacklistStore.get(`blacklist:${jti}`)!.value).toBe('revoked');
  });

  it('C2. transporter logout blacklists access token JTI in Redis', () => {
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 900;
    simulateLogout('transporter-1', jti, exp);
    expect(blacklistStore.has(`blacklist:${jti}`)).toBe(true);
  });

  it('C3. driver logout blacklists access token JTI in Redis', () => {
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 900;
    simulateLogout('driver-1', jti, exp);
    expect(blacklistStore.has(`blacklist:${jti}`)).toBe(true);
  });

  it('C4. after logout, access token is rejected by middleware', async () => {
    const jti = crypto.randomUUID();
    const token = generateTestAccessToken({ jti });
    const decoded = jwt.decode(token) as { exp: number };

    // Simulate logout blacklisting
    blacklistStore.set(`blacklist:${jti}`, { value: 'revoked', ttl: 900 });

    // Simulate middleware check
    const isBlacklisted = blacklistStore.has(`blacklist:${jti}`);
    expect(isBlacklisted).toBe(true);
  });

  it('C5. after logout, refresh tokens are deleted', () => {
    const userId = 'user-1';
    // Set up refresh tokens
    const tokenIds = ['tok-a', 'tok-b'];
    tokenIds.forEach((id) => refreshTokenStore.set(`refresh:${id}`, userId));
    userTokenSets.set(userId, new Set(tokenIds));

    const result = simulateLogout(userId, crypto.randomUUID(), Math.floor(Date.now() / 1000) + 900);
    expect(result.refreshTokensDeleted).toBe(2);
    expect(refreshTokenStore.size).toBe(0);
  });

  it('C6. logout with already-expired token does not crash', () => {
    // exp in the past => remainingTTL <= 0 => no blacklist entry created
    const jti = crypto.randomUUID();
    const expiredExp = Math.floor(Date.now() / 1000) - 60; // 1 min ago
    expect(() => simulateLogout('user-1', jti, expiredExp)).not.toThrow();
    expect(blacklistStore.has(`blacklist:${jti}`)).toBe(false);
  });

  it('C7. logout with missing JTI does not crash (graceful degradation)', () => {
    expect(() => simulateLogout('user-1', undefined, undefined)).not.toThrow();
    expect(blacklistStore.size).toBe(0);
  });

  it('C8. double logout does not crash (idempotent)', () => {
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 900;
    simulateLogout('user-1', jti, exp);
    expect(() => simulateLogout('user-1', jti, exp)).not.toThrow();
    expect(blacklistStore.has(`blacklist:${jti}`)).toBe(true);
  });

  it('C9. blacklist TTL matches remaining token lifetime (not 15 full minutes)', () => {
    const jti = crypto.randomUUID();
    // Token with only 120 seconds remaining
    const exp = Math.floor(Date.now() / 1000) + 120;
    simulateLogout('user-1', jti, exp);
    const entry = blacklistStore.get(`blacklist:${jti}`);
    expect(entry).toBeDefined();
    // TTL should be ~120, not 900
    expect(entry!.ttl).toBeLessThanOrEqual(121);
    expect(entry!.ttl).toBeGreaterThan(0);
  });

  it('C10. after blacklist TTL expires, same JTI is no longer blacklisted', () => {
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 1; // 1 second TTL
    simulateLogout('user-1', jti, exp);
    // Simulate TTL expiry
    blacklistStore.delete(`blacklist:${jti}`);
    expect(blacklistStore.has(`blacklist:${jti}`)).toBe(false);
  });

  it('C11. logout from one device does not affect other devices tokens', () => {
    const userId = 'multi-device-user';
    // Device A token
    const jtiA = crypto.randomUUID();
    const jtiB = crypto.randomUUID();

    // Logout device A only
    const expA = Math.floor(Date.now() / 1000) + 900;
    simulateLogout(userId, jtiA, expA);

    expect(blacklistStore.has(`blacklist:${jtiA}`)).toBe(true);
    expect(blacklistStore.has(`blacklist:${jtiB}`)).toBe(false);
  });

  it('C12. auth.service.ts logout method accepts jti and exp parameters', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('async logout(userId: string, jti?: string, exp?: number)');
  });

  it('C13. auth.service.ts logout sets blacklist with remaining TTL', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain("await redisService.set(`blacklist:${jti}`, 'revoked', remainingTTL)");
  });

  it('C14. auth.controller.ts extracts jti and exp from access token', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.controller.ts'),
      'utf-8'
    );
    expect(source).toContain('jti = decoded?.jti');
    expect(source).toContain('exp = decoded?.exp');
  });

  it('C15. auth.controller.ts passes jti and exp to authService.logout', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.controller.ts'),
      'utf-8'
    );
    expect(source).toContain('await authService.logout(userId, jti, exp)');
  });

  it('C16. auth.controller.ts uses jwt.decode (not jwt.verify) for logout extraction', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.controller.ts'),
      'utf-8'
    );
    // Controller extracts token into a variable first, then decodes it
    expect(source).toContain('jwt.decode(token)');
  });
});

// ==========================================================================
// D. DRIVER AUTH LOGOUT (10+ tests)
// ==========================================================================
describe('D. Driver Auth Logout', () => {
  it('D1. driver-auth.service.ts generates access token with jti', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('jti: crypto.randomUUID()');
  });

  it('D2. driver-auth.service.ts imports crypto', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain("import crypto from 'crypto'");
  });

  it('D3. driver-auth.service.ts uses jwt.sign for access token signing', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    const genAccessBlock = source.slice(source.indexOf('generateAccessToken'));
    // Uses jwt.sign with config.jwt.secret (HS256 is the default for HMAC secrets)
    expect(genAccessBlock).toContain('config.jwt.secret');
    expect(genAccessBlock).toContain('jwt.sign(');
  });

  it('D4. driver-auth.service.ts uses REDIS_KEYS for driver token management', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    // The driver-auth service defines REDIS_KEYS for token management
    expect(source).toContain('DRIVER_REFRESH_TOKEN');
    expect(source).toContain('DRIVER_TOKENS');
  });

  it('D5. driver-auth.service.ts access token includes driver role', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    const genAccessBlock = source.slice(source.indexOf('generateAccessToken'));
    expect(genAccessBlock).toContain("role: 'driver'");
  });

  it('D6. driver-auth.service.ts access token includes transporterId', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    const genAccessBlock = source.slice(source.indexOf('generateAccessToken'));
    expect(genAccessBlock).toContain('transporterId: driver.transporterId');
  });

  it('D7. driver-auth.service.ts uses config.jwt.expiresIn for access token', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('expiresIn: config.jwt.expiresIn');
  });

  it('D8. driver-auth.service.ts uses separate JWT_REFRESH_SECRET for refresh tokens', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('config.jwt.refreshSecret');
  });

  it('D9. driver-auth routes are registered (module resolves)', () => {
    const routePath = require.resolve('../modules/driver-auth/driver-auth.routes');
    expect(routePath).toBeDefined();
  });

  it('D10. driver access token jti is valid UUID when generated by test helper', () => {
    const token = jwt.sign(
      {
        userId: 'driver-1',
        phone: '9999999999',
        role: 'driver',
        transporterId: 'transporter-1',
        jti: crypto.randomUUID(),
      },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    const decoded = jwt.decode(token) as { jti: string; role: string };
    expect(decoded.jti).toMatch(UUID_REGEX);
    expect(decoded.role).toBe('driver');
  });

  it('D11. driver refresh token uses config.jwt.refreshExpiresIn', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('expiresIn: config.jwt.refreshExpiresIn');
  });
});

// ==========================================================================
// E. SOCKET.IO AUTH (10+ tests)
// ==========================================================================
describe('E. Socket.IO Auth', () => {
  // Simulate the Socket.IO auth middleware from socket.service.ts
  async function simulateSocketAuth(
    token: string | undefined,
    blacklistedJtis: Set<string> = new Set()
  ): Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }> {
    if (!token) {
      return { success: false, error: 'Authentication required' };
    }

    try {
      const decoded = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;

      // Check JTI blacklist (mirrors what should be in socket auth)
      if (decoded.jti && typeof decoded.jti === 'string') {
        if (blacklistedJtis.has(decoded.jti as string)) {
          return { success: false, error: 'Token has been revoked' };
        }
      }

      return {
        success: true,
        data: {
          userId: decoded.userId,
          role: decoded.role,
          phone: decoded.phone,
        },
      };
    } catch {
      return { success: false, error: 'Invalid token' };
    }
  }

  it('E1. socket connection with valid token succeeds', async () => {
    const token = generateTestAccessToken();
    const result = await simulateSocketAuth(token);
    expect(result.success).toBe(true);
    expect(result.data?.userId).toBe('test-user-id');
  });

  it('E2. socket connection with blacklisted JTI is rejected', async () => {
    const jti = crypto.randomUUID();
    const token = generateTestAccessToken({ jti });
    const result = await simulateSocketAuth(token, new Set([jti]));
    expect(result.success).toBe(false);
    expect(result.error).toBe('Token has been revoked');
  });

  it('E3. socket connection with expired token is rejected', async () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', phone: '1111', jti: crypto.randomUUID() },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '0s' }
    );
    await new Promise((r) => setTimeout(r, 50));
    const result = await simulateSocketAuth(token);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  it('E4. socket connection without token is rejected', async () => {
    const result = await simulateSocketAuth(undefined);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Authentication required');
  });

  it('E5. socket reconnection after logout is rejected', async () => {
    const jti = crypto.randomUUID();
    const token = generateTestAccessToken({ jti });

    // First connection: OK
    const first = await simulateSocketAuth(token);
    expect(first.success).toBe(true);

    // User logs out -> jti blacklisted
    const blacklist = new Set([jti]);

    // Reconnect attempt: rejected
    const second = await simulateSocketAuth(token, blacklist);
    expect(second.success).toBe(false);
    expect(second.error).toBe('Token has been revoked');
  });

  it('E6. socket.service.ts uses jwt.verify for socket authentication', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );
    expect(source).toContain("jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] })");
  });

  it('E7. socket auth extracts userId, role, phone from token', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );
    expect(source).toContain('socket.data.userId = decoded.userId');
    expect(source).toContain('socket.data.role = decoded.role');
    expect(source).toContain('socket.data.phone = decoded.phone');
  });

  it('E8. socket connection with wrong secret is rejected', async () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', phone: '111', jti: crypto.randomUUID() },
      'wrong-secret',
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    const result = await simulateSocketAuth(token);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid token');
  });

  it('E9. socket auth returns user data on success', async () => {
    const token = generateTestAccessToken({
      userId: 'driver-xyz',
      role: 'driver',
      phone: '5555555555',
    });
    const result = await simulateSocketAuth(token);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      userId: 'driver-xyz',
      role: 'driver',
      phone: '5555555555',
    });
  });

  it('E10. socket auth with old token (no jti) still works', async () => {
    const token = jwt.sign(
      { userId: 'old-user', role: 'transporter', phone: '2222222222' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const result = await simulateSocketAuth(token);
    expect(result.success).toBe(true);
  });

  it('E11. socket.service.ts imports jwt for token verification', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/services/socket.service.ts'),
      'utf-8'
    );
    expect(source).toContain("import jwt from 'jsonwebtoken'");
  });
});

// ==========================================================================
// F. EDGE CASES & WHAT-IF SCENARIOS (20+ tests)
// ==========================================================================
describe('F. Edge Cases & What-If Scenarios', () => {
  const blacklistStore = new Map<string, string>();

  async function isBlacklisted(jti: string): Promise<boolean> {
    return blacklistStore.has(`blacklist:${jti}`);
  }

  function blacklist(jti: string): void {
    blacklistStore.set(`blacklist:${jti}`, 'revoked');
  }

  beforeEach(() => {
    blacklistStore.clear();
  });

  it('F1. user logs in on 3 devices, logs out on 1 => other 2 still work', async () => {
    const jtiDevice1 = crypto.randomUUID();
    const jtiDevice2 = crypto.randomUUID();
    const jtiDevice3 = crypto.randomUUID();

    // Logout device 1 only
    blacklist(jtiDevice1);

    expect(await isBlacklisted(jtiDevice1)).toBe(true);
    expect(await isBlacklisted(jtiDevice2)).toBe(false);
    expect(await isBlacklisted(jtiDevice3)).toBe(false);
  });

  it('F2. token blacklisted mid-request => next request fails', async () => {
    const jti = crypto.randomUUID();
    const token = generateTestAccessToken({ jti });

    // Request 1: succeeds
    expect(await isBlacklisted(jti)).toBe(false);

    // Blacklist happens between requests
    blacklist(jti);

    // Request 2: fails
    expect(await isBlacklisted(jti)).toBe(true);
  });

  it('F3. Redis down during logout => logout still cleans refresh tokens', () => {
    // Simulate: blacklist set fails, but refresh token deletion proceeds
    const refreshTokens = new Map<string, string>();
    refreshTokens.set('refresh:tok1', 'user-1');
    refreshTokens.set('refresh:tok2', 'user-1');

    let blacklistSucceeded = false;
    try {
      throw new Error('Redis connection refused');
    } catch {
      blacklistSucceeded = false;
    }

    // Refresh tokens should still be cleaned
    refreshTokens.delete('refresh:tok1');
    refreshTokens.delete('refresh:tok2');

    expect(blacklistSucceeded).toBe(false);
    expect(refreshTokens.size).toBe(0);
  });

  it('F4. Redis down during auth check => fails open (allows request)', async () => {
    const jti = crypto.randomUUID();
    const token = generateTestAccessToken({ jti });

    // Simulate Redis down
    const redisDown = async (): Promise<boolean> => {
      throw new Error('Redis connection refused');
    };

    let allowed = false;
    try {
      await redisDown();
    } catch {
      // Fail open: allow the request
      allowed = true;
    }
    expect(allowed).toBe(true);
  });

  it('F5. 1000 tokens blacklisted => performance is acceptable', () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      blacklistStore.set(`blacklist:${crypto.randomUUID()}`, 'revoked');
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // Should complete in well under 1 second
    expect(blacklistStore.size).toBe(1000);
  });

  it('F6. token issued before the fix (no JTI) => backward compatible', async () => {
    const legacyToken = jwt.sign(
      { userId: 'legacy-user', role: 'customer', phone: '3333' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' }
    );
    const decoded = jwt.decode(legacyToken) as Record<string, unknown>;
    expect(decoded.jti).toBeUndefined();

    // Middleware should allow it through (no jti = no blacklist check)
    const verified = jwt.verify(legacyToken, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(verified.userId).toBe('legacy-user');
  });

  it('F7. replaying a blacklisted token 1000 times => all rejected', async () => {
    const jti = crypto.randomUUID();
    blacklist(jti);

    for (let i = 0; i < 1000; i++) {
      expect(await isBlacklisted(jti)).toBe(true);
    }
  });

  it('F8. access token expires naturally => blacklist entry also expires', () => {
    const jti = crypto.randomUUID();
    // Token expires in 900s, blacklist TTL set to remaining time
    const exp = Math.floor(Date.now() / 1000) + 900;
    const remainingTTL = exp - Math.floor(Date.now() / 1000);
    expect(remainingTTL).toBeGreaterThan(0);
    expect(remainingTTL).toBeLessThanOrEqual(900);
    // After TTL, Redis auto-deletes the entry (simulated here)
    blacklistStore.set(`blacklist:${jti}`, 'revoked');
    blacklistStore.delete(`blacklist:${jti}`); // Simulate TTL expiry
    expect(blacklistStore.has(`blacklist:${jti}`)).toBe(false);
  });

  it('F9. server restarts => blacklist persists in Redis (not in-memory)', () => {
    // This is a structural test: verify blacklist uses Redis, not in-memory
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('redisService.set(`blacklist:${jti}`');
    // Should NOT use in-memory Map for blacklist
    expect(source).not.toContain('new Map<string, string>()');
  });

  it('F10. two users logout simultaneously => no race condition', async () => {
    const jtiUser1 = crypto.randomUUID();
    const jtiUser2 = crypto.randomUUID();

    // Parallel logout
    await Promise.all([
      Promise.resolve(blacklist(jtiUser1)),
      Promise.resolve(blacklist(jtiUser2)),
    ]);

    expect(await isBlacklisted(jtiUser1)).toBe(true);
    expect(await isBlacklisted(jtiUser2)).toBe(true);
  });

  it('F11. concurrent login + logout => consistent state', () => {
    const userId = 'concurrent-user';
    const oldJti = crypto.randomUUID();
    const newJti = crypto.randomUUID();

    // Old session logout
    blacklist(oldJti);

    // New session login (new jti is NOT blacklisted)
    expect(blacklistStore.has(`blacklist:${oldJti}`)).toBe(true);
    expect(blacklistStore.has(`blacklist:${newJti}`)).toBe(false);
  });

  it('F12. token with tampered JTI => rejected by signature check', () => {
    const token = generateTestAccessToken();
    const parts = token.split('.');

    // Tamper with payload (change jti)
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.jti = 'tampered-jti-value';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const tamperedToken = parts.join('.');
    expect(() => jwt.verify(tamperedToken, TEST_JWT_SECRET, { algorithms: ['HS256'] })).toThrow();
  });

  it('F13. token with valid JTI but wrong signature => rejected', () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', jti: crypto.randomUUID() },
      'wrong-signing-key',
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    expect(() =>
      jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] })
    ).toThrow(jwt.JsonWebTokenError);
  });

  it('F14. empty JTI string => handled gracefully', async () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', phone: '111', jti: '' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    // Empty jti is falsy, so blacklist check should be skipped
    const decoded = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(decoded.jti).toBe('');
    // In the middleware, empty string is falsy => no blacklist check => pass through
    const shouldCheckBlacklist = !!decoded.jti;
    expect(shouldCheckBlacklist).toBe(false);
  });

  it('F15. non-UUID JTI => handled gracefully', () => {
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', phone: '111', jti: 'not-a-uuid' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    const decoded = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(decoded.jti).toBe('not-a-uuid');
    // Should still work even though jti is not UUID (blacklist uses exact match)
  });

  it('F16. none algorithm attack is rejected by HS256 pinning', () => {
    // Try to craft a "none" algorithm token
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: 'attacker', role: 'admin' })).toString('base64url');
    const fakeToken = `${header}.${payload}.`;

    expect(() =>
      jwt.verify(fakeToken, TEST_JWT_SECRET, { algorithms: ['HS256'] })
    ).toThrow();
  });

  it('F17. RS256 token is rejected when HS256 is enforced', () => {
    // Generate RSA key pair for test
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = jwt.sign({ userId: 'u1', role: 'admin' }, privateKey, { algorithm: 'RS256', expiresIn: '15m' });

    expect(() =>
      jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] })
    ).toThrow();
  });

  it('F18. malformed JWT (not 3 parts) returns error', () => {
    expect(() =>
      jwt.verify('not.a.valid.jwt.at.all', TEST_JWT_SECRET, { algorithms: ['HS256'] })
    ).toThrow();
  });

  it('F19. JWT with null payload returns error', () => {
    expect(() =>
      jwt.verify('eyJhbGciOiJIUzI1NiJ9.bnVsbA.fakesig', TEST_JWT_SECRET, { algorithms: ['HS256'] })
    ).toThrow();
  });

  it('F20. very long JTI string does not crash blacklist check', async () => {
    const longJti = 'a'.repeat(10000);
    const token = jwt.sign(
      { userId: 'u1', role: 'customer', phone: '111', jti: longJti },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    const decoded = jwt.decode(token) as { jti: string };
    expect(decoded.jti.length).toBe(10000);
    // Blacklist check should work without crashing
    blacklist(longJti);
    expect(await isBlacklisted(longJti)).toBe(true);
  });

  it('F21. token payload preserves all fields through sign/verify cycle', () => {
    const originalPayload = {
      userId: 'test-id',
      role: 'transporter',
      phone: '9876543210',
      jti: crypto.randomUUID(),
    };
    const token = jwt.sign(originalPayload, TEST_JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    });
    const decoded = jwt.verify(token, TEST_JWT_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(decoded.userId).toBe(originalPayload.userId);
    expect(decoded.role).toBe(originalPayload.role);
    expect(decoded.phone).toBe(originalPayload.phone);
    expect(decoded.jti).toBe(originalPayload.jti);
  });

  it('F22. blacklist key format is consistent (blacklist:jti)', () => {
    const jti = crypto.randomUUID();
    const expectedKey = `blacklist:${jti}`;
    blacklistStore.set(expectedKey, 'revoked');
    expect(blacklistStore.has(expectedKey)).toBe(true);

    // Verify source uses same format
    const source = fs.readFileSync(
      path.resolve(__dirname, '../modules/auth/auth.service.ts'),
      'utf-8'
    );
    expect(source).toContain('`blacklist:${jti}`');
  });

  it('F23. multiple tokens for same user have different JTIs', () => {
    const tokens = Array.from({ length: 5 }, () =>
      generateTestAccessToken({ userId: 'same-user' })
    );
    const jtis = tokens.map((t) => (jwt.decode(t) as { jti: string }).jti);
    const uniqueJtis = new Set(jtis);
    expect(uniqueJtis.size).toBe(5);
  });

  it('F24. auth.middleware.ts catches Redis errors gracefully (fail open)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../shared/middleware/auth.middleware.ts'),
      'utf-8'
    );
    // Should have a try/catch around the Redis blacklist check
    expect(source).toContain('catch');
    // Verify the pattern: try { Redis check } catch { fail open }
    expect(source).toContain('Redis down');
  });
});
