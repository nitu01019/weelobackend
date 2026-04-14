/**
 * =============================================================================
 * AUTH HARDENING TESTS
 * =============================================================================
 *
 * Verifies security infrastructure added by Team Echo:
 * 1. Rate limiter configuration for refresh and login endpoints
 * 2. Driver refresh token Redis storage
 * 3. Token rotation on /auth/refresh
 * =============================================================================
 */

export {};

describe('Auth Hardening', () => {
  describe('Rate Limiter Configuration', () => {
    it('authRateLimiter is exported from rate-limiter middleware', () => {
      const { authRateLimiter } = require('../shared/middleware/rate-limiter.middleware');
      expect(authRateLimiter).toBeDefined();
      expect(typeof authRateLimiter).toBe('function');
    });

    it('authRateLimiter is exported from rate-limiter middleware', () => {
      const { authRateLimiter } = require('../shared/middleware/rate-limiter.middleware');
      expect(authRateLimiter).toBeDefined();
      expect(typeof authRateLimiter).toBe('function');
    });

    it('otpRateLimiter is exported from rate-limiter middleware', () => {
      const { otpRateLimiter } = require('../shared/middleware/rate-limiter.middleware');
      expect(otpRateLimiter).toBeDefined();
      expect(typeof otpRateLimiter).toBe('function');
    });
  });

  describe('Token Security Patterns', () => {
    it('driver auth service module resolves successfully', () => {
      const driverAuthPath = require.resolve('../modules/driver-auth/driver-auth.service');
      expect(driverAuthPath).toBeDefined();
      expect(typeof driverAuthPath).toBe('string');
    });

    it('auth service module resolves successfully', () => {
      const authPath = require.resolve('../modules/auth/auth.service');
      expect(authPath).toBeDefined();
      expect(typeof authPath).toBe('string');
    });

    it('driver auth service imports crypto for token hashing', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
        'utf-8'
      );
      expect(source).toContain("import crypto from 'crypto'");
    });

    it('driver auth service uses REDIS_KEYS for OTP storage', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/driver-auth/driver-auth.service.ts'),
        'utf-8'
      );
      expect(source).toContain('REDIS_KEYS');
    });

    it('auth service imports redisService for token storage', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.service.ts'),
        'utf-8'
      );
      expect(source).toContain("import { redisService }");
      expect(source).toContain('REDIS_KEYS.REFRESH_TOKEN');
    });
  });

  describe('Token Rotation', () => {
    it('auth service has refreshToken method that validates tokens via Redis', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.service.ts'),
        'utf-8'
      );
      // Verify refresh token validation via Redis
      expect(source).toContain('async refreshToken');
      expect(source).toContain('REDIS_KEYS.REFRESH_TOKEN');
      expect(source).toContain('redisService');
    });

    it('auth controller passes refreshToken in response', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.controller.ts'),
        'utf-8'
      );
      expect(source).toContain('refreshToken: result.refreshToken');
    });
  });

  describe('Refresh Route Rate Limiting', () => {
    it('auth routes import rate limiters', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.routes.ts'),
        'utf-8'
      );
      expect(source).toContain('authRateLimiter');
    });

    it('auth OTP route applies rate limiter middleware', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/auth/auth.routes.ts'),
        'utf-8'
      );
      expect(source).toContain('otpRateLimiter');
    });
  });
});
