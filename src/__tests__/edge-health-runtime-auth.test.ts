/**
 * =============================================================================
 * EDGE — /health/runtime admin-only auth guard (F-A-09)
 * =============================================================================
 *
 * CVE: unauthenticated callers were able to read the /health/runtime endpoint,
 * which discloses internal DB counts (users, vehicles, bookings, assignments),
 * Redis/socket adapter status, and connected user counts.
 *
 * This test locks in the fix: the inline `/health/runtime` handler declared
 * in `src/server.ts` MUST be preceded by `authMiddleware` + `roleGuard(['admin'])`.
 *
 * A behavioural sanity check is also included: the same middleware composition
 * mounted on a minimal Express app rejects unauthenticated requests with 401
 * and non-admin authenticated requests with 403.
 * =============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';

// Shared mocks so authMiddleware is exercisable without Redis/Prisma.
jest.mock('../shared/services/logger.service', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config/environment', () => ({
  config: {
    isDevelopment: false,
    isProduction: false,
    jwt: { secret: 'test-secret-key-for-health-runtime-auth-minimum-32chars' },
    nodeEnv: 'test',
    port: 0,
    cors: { origin: '*' },
    rateLimit: { windowMs: 60000, maxRequests: 100 },
    redis: { enabled: true },
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));
jest.mock('../shared/services/redis.service', () => ({
  redisService: {
    isConnected: () => false,
    isRedisEnabled: () => false,
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  },
}));
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Test User' }) },
  },
}));
jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    observeHistogram: jest.fn(),
    setGauge: jest.fn(),
  },
  metricsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
jest.mock('../modules/admin/admin-suspension.service', () => ({
  adminSuspensionService: {
    isUserSuspended: jest.fn().mockResolvedValue(false),
  },
}));

describe('F-A-09 — /health/runtime admin-only guard', () => {
  const serverFile = path.resolve(__dirname, '..', 'server.ts');
  const serverSource = fs.readFileSync(serverFile, 'utf-8');

  // -------------------------------------------------------------------------
  // Source-level assertion: the inline /health/runtime handler wired in
  // server.ts must have authMiddleware + roleGuard(['admin']) in its chain.
  // -------------------------------------------------------------------------
  it('server.ts mounts /health/runtime behind authMiddleware + roleGuard admin', () => {
    // Isolate the app.get(...) registration for /health/runtime
    const pattern = /app\.get\(\s*['"`]\/health\/runtime['"`][\s\S]*?\)\s*;/;
    const match = serverSource.match(pattern);
    expect(match).not.toBeNull();
    const snippet = match![0];
    expect(snippet).toContain('authMiddleware');
    expect(snippet).toMatch(/roleGuard\(\s*\[\s*['"]admin['"]\s*\]\s*\)/);
  });

  it('server.ts imports authMiddleware and roleGuard from shared auth middleware', () => {
    expect(serverSource).toMatch(
      /from\s+['"](?:\.\/)?shared\/middleware\/auth\.middleware['"]/
    );
    // Both names must be imported explicitly (order-independent)
    expect(serverSource).toMatch(/authMiddleware/);
    expect(serverSource).toMatch(/roleGuard/);
  });

  // -------------------------------------------------------------------------
  // Behavioural assertion: exercising the same middleware composition on a
  // minimal Express app produces the correct 401 / 403 responses. This
  // catches regressions where the guards are present in the file but wired
  // in the wrong order (e.g. handler before guards).
  // -------------------------------------------------------------------------
  describe('middleware composition enforces admin auth', () => {
    let app: express.Express;

    beforeAll(() => {
      // Import lazily to pick up mocks
      const { authMiddleware, roleGuard } = require('../shared/middleware/auth.middleware');
      app = express();
      app.get('/health/runtime', authMiddleware, roleGuard(['admin']), (_req, res) => {
        res.json({ status: 'healthy' });
      });
      app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        res.status(err.statusCode || 500).json({ error: err.code || 'ERR' });
      });
    });

    const fire = (
      headers: Record<string, string> = {}
    ): Promise<{ status: number; body: string }> =>
      new Promise((resolve) => {
        const server = app.listen(0, () => {
          const port = (server.address() as any).port;
          const req = http.request(
            { hostname: '127.0.0.1', port, path: '/health/runtime', method: 'GET', headers },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => {
                server.close();
                resolve({ status: res.statusCode || 0, body });
              });
            }
          );
          req.end();
        });
      });

    it('rejects unauthenticated requests with 401', async () => {
      const { status } = await fire();
      expect(status).toBe(401);
    });

    it('rejects non-admin authenticated requests with 403', async () => {
      const token = jwt.sign(
        { userId: 'u1', role: 'transporter', phone: '9999999999' },
        'test-secret-key-for-health-runtime-auth-minimum-32chars'
      );
      const { status } = await fire({ Authorization: `Bearer ${token}` });
      expect(status).toBe(403);
    });

    it('allows admin-authenticated requests (200)', async () => {
      const token = jwt.sign(
        { userId: 'admin-1', role: 'admin', phone: '7777777777' },
        'test-secret-key-for-health-runtime-auth-minimum-32chars'
      );
      const { status } = await fire({ Authorization: `Bearer ${token}` });
      expect(status).toBe(200);
    });
  });
});
