/**
 * =============================================================================
 * PRICING ROUTES INTEGRATION TESTS (F-A-25)
 * =============================================================================
 *
 * Asserts that `POST /api/v1/pricing/estimate` and `POST /api/v1/pricing/suggestions`
 * accept the documented FLAT payload and return 200 with numeric `pricePerTruck`
 * and numeric `totalPrice`.
 *
 * Before F-A-25 fix: the two Zod schemas were wrapped in `body: z.object({...})`,
 * but the `validateRequest` middleware at src/shared/utils/validation.utils.ts
 * already calls `schema.parse(req.body)`. So every well-formed client call was
 * rejected with 400 VALIDATION_ERROR. This test is the regression guard.
 *
 * After F-A-25 fix: both schemas are flat; these tests pass.
 *
 * Pattern: Node http helper (no supertest dependency) — matches routes-split.test.ts
 * =============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';

// =============================================================================
// MOCK SETUP — must precede imports that use mocked modules
// =============================================================================

// Mock logger (pricing.service logs info-level messages; mute in test)
jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Bypass authMiddleware — we only care about schema validation + route handler
jest.mock('../shared/middleware/auth.middleware', () => ({
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  roleGuard: (_roles: string[]) => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { pricingRouter } from '../modules/pricing/pricing.routes';

// =============================================================================
// TEST APP + HTTP HELPER
// =============================================================================

function createTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/pricing', pricingRouter);

  // Error handler matches the AppError shape produced by validateRequest
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode || 500;
    res.status(status).json({
      success: false,
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Internal server error',
        details: err.details,
      },
    });
  });

  return app;
}

type HttpResponse = {
  status: number;
  body: any;
};

function makeRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });

      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('F-A-25 — Pricing routes accept flat payload', () => {
  let app: express.Express;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('POST /api/v1/pricing/estimate', () => {
    it('returns 200 with numeric pricePerTruck and numeric totalPrice for flat payload', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/estimate', {
        vehicleType: 'tipper',
        distanceKm: 50,
        trucksNeeded: 1,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(typeof response.body.data.pricePerTruck).toBe('number');
      expect(Number.isFinite(response.body.data.pricePerTruck)).toBe(true);
      expect(response.body.data.pricePerTruck).toBeGreaterThan(0);
      expect(typeof response.body.data.totalPrice).toBe('number');
      expect(Number.isFinite(response.body.data.totalPrice)).toBe(true);
      expect(response.body.data.totalPrice).toBeGreaterThan(0);
    });

    it('accepts optional cargoWeightKg and returns numeric prices', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/estimate', {
        vehicleType: 'tipper',
        vehicleSubtype: '15-17 Ton',
        distanceKm: 100,
        trucksNeeded: 2,
        cargoWeightKg: 12000,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(typeof response.body.data.pricePerTruck).toBe('number');
      expect(typeof response.body.data.totalPrice).toBe('number');
      expect(Number.isFinite(response.body.data.pricePerTruck)).toBe(true);
      expect(Number.isFinite(response.body.data.totalPrice)).toBe(true);
    });

    it('returns 400 VALIDATION_ERROR when vehicleType is a number (type mismatch)', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/estimate', {
        vehicleType: 123,
        distanceKm: 50,
        trucksNeeded: 1,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR when distanceKm is missing', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/estimate', {
        vehicleType: 'tipper',
        trucksNeeded: 1,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects double-wrapped legacy payload (regression guard for F-A-25)', async () => {
      // Pre-fix: a double-wrapped `{body:{...}}` payload passed validation but
      // produced `pricePerTruck: null, totalPrice: NaN`. After the fix the
      // validator sees unknown required fields at the top level → 400.
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/estimate', {
        body: {
          vehicleType: 'tipper',
          distanceKm: 50,
          trucksNeeded: 1,
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/pricing/suggestions', () => {
    it('returns 200 with suggestions whose pricePerTruck/totalPrice are numeric', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/suggestions', {
        cargoWeightKg: 5000,
        distanceKm: 100,
        trucksNeeded: 1,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data.suggestions)).toBe(true);
      expect(response.body.data.suggestions.length).toBeGreaterThan(0);

      for (const suggestion of response.body.data.suggestions) {
        expect(typeof suggestion.pricePerTruck).toBe('number');
        expect(Number.isFinite(suggestion.pricePerTruck)).toBe(true);
        expect(suggestion.pricePerTruck).toBeGreaterThan(0);
        expect(typeof suggestion.totalPrice).toBe('number');
        expect(Number.isFinite(suggestion.totalPrice)).toBe(true);
        expect(suggestion.totalPrice).toBeGreaterThan(0);
      }
    });

    it('accepts default trucksNeeded when omitted (schema default = 1)', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/suggestions', {
        cargoWeightKg: 5000,
        distanceKm: 100,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data.suggestions)).toBe(true);
    });

    it('returns 400 VALIDATION_ERROR when cargoWeightKg is missing', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/suggestions', {
        distanceKm: 100,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR when cargoWeightKg is a string', async () => {
      const response = await makeRequest(app, 'POST', '/api/v1/pricing/suggestions', {
        cargoWeightKg: 'heavy',
        distanceKm: 100,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
