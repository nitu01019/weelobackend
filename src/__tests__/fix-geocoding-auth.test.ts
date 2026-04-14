/**
 * =============================================================================
 * FIX-17: GEOCODING AUTH ENFORCEMENT TESTS
 * =============================================================================
 *
 * Verifies that geocoding routes require authentication (authMiddleware)
 * instead of allowing unauthenticated access (optionalAuthMiddleware).
 *
 * This is a BREAKING CHANGE — unauthenticated clients will receive 401.
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

export {};

const GEOCODING_ROUTES_PATH = path.resolve(
  __dirname,
  '../modules/routing/geocoding.routes.ts'
);

describe('FIX-17: Geocoding Routes Auth Enforcement', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(GEOCODING_ROUTES_PATH, 'utf-8');
  });

  describe('Import validation', () => {
    it('imports authMiddleware from auth.middleware', () => {
      expect(source).toContain(
        "import { authMiddleware } from '../../shared/middleware/auth.middleware'"
      );
    });

    it('does NOT import optionalAuthMiddleware', () => {
      expect(source).not.toMatch(/import\s*\{[^}]*optionalAuthMiddleware[^}]*\}/);
    });
  });

  describe('Middleware application', () => {
    it('applies authMiddleware via router.use()', () => {
      expect(source).toContain('router.use(authMiddleware)');
    });

    it('does NOT invoke optionalAuthMiddleware in executable code', () => {
      // Comments may reference the old middleware name for documentation.
      // Ensure no executable usage: router.use(optionalAuthMiddleware) must be gone.
      expect(source).not.toMatch(/router\.use\(\s*optionalAuthMiddleware\s*\)/);
    });
  });

  describe('All geocoding routes are covered by the router-level middleware', () => {
    // router.use(authMiddleware) is applied before all route handlers,
    // so every route defined after it inherits the auth requirement.

    it('search route exists', () => {
      expect(source).toMatch(/router\.post\(\s*['"]\/search['"]/);
    });

    it('reverse route exists', () => {
      expect(source).toMatch(/router\.post\(\s*['"]\/reverse['"]/);
    });

    it('route calculation route exists', () => {
      expect(source).toMatch(/router\.post\(\s*['"]\/route['"]/);
    });

    it('multi-point route exists', () => {
      expect(source).toMatch(/router\.post\(\s*['"]\/route-multi['"]/);
    });

    it('status route exists', () => {
      expect(source).toMatch(/router\.get\(\s*['"]\/status['"]/);
    });

    it('authMiddleware is applied BEFORE all route definitions', () => {
      const authPosition = source.indexOf('router.use(authMiddleware)');
      const firstRoutePosition = Math.min(
        source.indexOf("router.post('/search'"),
        source.indexOf("router.post('/reverse'"),
        source.indexOf("router.post('/route'"),
        source.indexOf("router.get('/status'")
      );

      expect(authPosition).toBeGreaterThan(-1);
      expect(firstRoutePosition).toBeGreaterThan(-1);
      expect(authPosition).toBeLessThan(firstRoutePosition);
    });
  });

  describe('authMiddleware rejects unauthenticated requests', () => {
    it('authMiddleware is a function export from auth.middleware', () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');
      expect(authMiddleware).toBeDefined();
      expect(typeof authMiddleware).toBe('function');
    });

    it('authMiddleware calls next(error) with 401 when no Authorization header is provided', async () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');

      const req = { headers: {} } as any;
      const res = {} as any;
      const next = jest.fn();

      await authMiddleware(req, res, next);

      // authMiddleware passes an AppError to next() for Express error handler
      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeDefined();
      expect(error.statusCode || error.status).toBe(401);
    });

    it('authMiddleware calls next(error) with 401 when Authorization header has no Bearer prefix', async () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');

      const req = { headers: { authorization: 'InvalidTokenFormat' } } as any;
      const res = {} as any;
      const next = jest.fn();

      await authMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeDefined();
      expect(error.statusCode || error.status).toBe(401);
    });

    it('authMiddleware calls next(error) with 401 when Bearer token is invalid', async () => {
      const { authMiddleware } = require('../shared/middleware/auth.middleware');

      const req = { headers: { authorization: 'Bearer invalid.jwt.token' } } as any;
      const res = {} as any;
      const next = jest.fn();

      await authMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeDefined();
      expect(error.statusCode || error.status).toBe(401);
    });
  });
});
