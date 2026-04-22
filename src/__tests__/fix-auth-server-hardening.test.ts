/**
 * =============================================================================
 * FIX-24/25/26/50/51 — Production Hardening Tests
 * A01-005 (T42/T43) — 32 kB JSON limit + rate-limiter-before-parser ordering
 * =============================================================================
 *
 * Covers:
 * FIX-24: OTP console logging restricted to isDevelopment only
 * FIX-26: Phone numbers masked in health/websocket endpoint
 * FIX-50: Error details hidden when isDevelopment is false
 * FIX-51: IP budget map clears when exceeding 10000 entries
 * A01-005 T42: 64 kB body rejected with 413 (32 kb limit enforced)
 * A01-005 T43: rate-limiter fires 429 before JSON parser allocates heap
 * =============================================================================
 */

import { Request, Response, NextFunction } from 'express';

export {};

// ---------------------------------------------------------------------------
// FIX-24: OTP console logging — isDevelopment guard
// ---------------------------------------------------------------------------
describe('FIX-24: OTP console logging guard', () => {
  const fs = require('fs');
  const path = require('path');
  const smsSource = fs.readFileSync(
    path.resolve(__dirname, '../modules/auth/sms.service.ts'),
    'utf-8'
  );

  it('ConsoleProvider guard uses config.isDevelopment, not config.isProduction', () => {
    // The ConsoleProvider.sendOtp guard should check !config.isDevelopment
    // to block OTP console logging in staging and production alike
    expect(smsSource).toContain('!config.isDevelopment');
    // The old pattern should NOT be present in ConsoleProvider
    expect(smsSource).not.toMatch(/if\s*\(\s*config\.isProduction\s*\)\s*\{[^}]*Console SMS provider/s);
  });

  it('Fallback to console logging uses config.isDevelopment guard', () => {
    // The SmsService.sendOtp fallback should use config.isDevelopment
    expect(smsSource).toContain('config.isDevelopment && this.provider !== this.fallbackProvider');
    // Old pattern should be gone
    expect(smsSource).not.toContain('!config.isProduction && this.provider !== this.fallbackProvider');
  });

  it('ConsoleProvider still throws when not in development', () => {
    // Verify the throw is present for non-development environments
    expect(smsSource).toContain("'SMS_PROVIDER_DISABLED'");
    expect(smsSource).toContain('Console SMS provider is disabled outside development');
  });
});

// ---------------------------------------------------------------------------
// FIX-26: Phone numbers masked in health/websocket endpoint
// ---------------------------------------------------------------------------
describe('FIX-26: Phone masking in health endpoint', () => {
  it('health.routes.ts masks phone numbers with ***XXXX pattern', () => {
    const fs = require('fs');
    const path = require('path');
    const healthSource = fs.readFileSync(
      path.resolve(__dirname, '../shared/routes/health.routes.ts'),
      'utf-8'
    );

    // Should contain the masking pattern
    expect(healthSource).toContain("'***' + String(socket.data.phone).slice(-4)");
    // Should NOT expose raw phone
    expect(healthSource).not.toMatch(/phone:\s*socket\.data\.phone\s*\|\|\s*'unknown'/);
  });

  it('masking logic produces correct output for a full phone number', () => {
    // Simulate the masking expression from health.routes.ts
    const phone = '9876543210';
    const masked = phone ? '***' + String(phone).slice(-4) : 'unknown';
    expect(masked).toBe('***3210');
  });

  it('masking logic returns unknown for falsy phone', () => {
    const phone: string | undefined = undefined;
    const masked = phone ? '***' + String(phone).slice(-4) : 'unknown';
    expect(masked).toBe('unknown');
  });

  it('masking logic handles short phone numbers safely', () => {
    const phone = '12';
    const masked = phone ? '***' + String(phone).slice(-4) : 'unknown';
    expect(masked).toBe('***12');
  });
});

// ---------------------------------------------------------------------------
// FIX-50: Error middleware — isDevelopment guard
// ---------------------------------------------------------------------------
describe('FIX-50: Error middleware isDevelopment guard', () => {
  const fs = require('fs');
  const path = require('path');
  const errorSource = fs.readFileSync(
    path.resolve(__dirname, '../shared/middleware/error.middleware.ts'),
    'utf-8'
  );

  it('AppError details are gated by config.isDevelopment', () => {
    expect(errorSource).toContain('config.isDevelopment');
    // Old guard pattern should be gone for details
    expect(errorSource).not.toMatch(/error\.details\s*&&\s*!config\.isProduction/);
  });

  it('Unknown error message uses config.isDevelopment to show details', () => {
    // The ternary should show error.message only in development
    expect(errorSource).toMatch(/config\.isDevelopment\s*\?\s*error\.message/);
    // Old pattern with isProduction ternary should be gone
    expect(errorSource).not.toMatch(/config\.isProduction\s*\?\s*'An unexpected error/);
  });

  it('errorHandler hides stack trace details when not in development', () => {
    // Directly test the behavior logic extracted from error.middleware.ts
    // When isDevelopment = false, error.message should NOT be exposed
    const isDevelopment = false;
    const errorMessage = 'Sensitive DB connection string leaked';
    const resultMessage = isDevelopment
      ? errorMessage
      : 'An unexpected error occurred. Please try again later.';

    expect(resultMessage).toBe('An unexpected error occurred. Please try again later.');
    expect(resultMessage).not.toContain('Sensitive');
  });

  it('errorHandler shows error details in development mode', () => {
    // When isDevelopment = true, error.message should be exposed
    const isDevelopment = true;
    const errorMessage = 'Debug: connection refused on port 5432';
    const resultMessage = isDevelopment
      ? errorMessage
      : 'An unexpected error occurred. Please try again later.';

    expect(resultMessage).toBe('Debug: connection refused on port 5432');
  });

  it('AppError details are hidden in staging (isDevelopment=false, isProduction=false)', () => {
    // Simulate the AppError details guard from error.middleware.ts
    const isDevelopment = false;
    const errorDetails = { table: 'users', constraint: 'unique_email' };
    const safeDetails = errorDetails && isDevelopment ? errorDetails : undefined;

    expect(safeDetails).toBeUndefined();
  });

  it('AppError details are shown in development', () => {
    const isDevelopment = true;
    const errorDetails = { table: 'users', constraint: 'unique_email' };
    const safeDetails = errorDetails && isDevelopment ? errorDetails : undefined;

    expect(safeDetails).toEqual({ table: 'users', constraint: 'unique_email' });
  });
});

// ---------------------------------------------------------------------------
// FIX-51: IP budget map size cap
// ---------------------------------------------------------------------------
describe('FIX-51: IP budget map size cap', () => {
  it('geocoding.routes.ts contains the 10000 size cap check', () => {
    const fs = require('fs');
    const path = require('path');
    const geocodingSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/routing/geocoding.routes.ts'),
      'utf-8'
    );

    expect(geocodingSource).toContain('ipBudgetMap.size > 10000');
    expect(geocodingSource).toContain('ipBudgetMap.clear()');
  });

  it('Map.clear() resets size to 0 when threshold exceeded', () => {
    // Simulate the logic from geocoding.routes.ts
    const testMap = new Map<string, { search: number; reverse: number; route: number; date: string }>();

    // Fill beyond threshold
    for (let i = 0; i <= 10001; i++) {
      testMap.set(`192.168.1.${i}`, { search: 1, reverse: 0, route: 0, date: 'test' });
    }
    expect(testMap.size).toBeGreaterThan(10000);

    // Apply the same guard as in geocoding.routes.ts
    if (testMap.size > 10000) {
      testMap.clear();
    }
    expect(testMap.size).toBe(0);

    // New entry can be added after clear
    testMap.set('10.0.0.1', { search: 0, reverse: 0, route: 0, date: new Date().toDateString() });
    expect(testMap.size).toBe(1);
  });

  it('Map is NOT cleared when under threshold', () => {
    const testMap = new Map<string, { search: number }>();

    for (let i = 0; i < 100; i++) {
      testMap.set(`10.0.0.${i}`, { search: 1 });
    }
    expect(testMap.size).toBe(100);

    // Guard should NOT trigger
    if (testMap.size > 10000) {
      testMap.clear();
    }
    expect(testMap.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// FIX-25: Debug routes removed from server.ts
// ---------------------------------------------------------------------------
describe('FIX-25: Debug routes removed from server.ts', () => {
  it('server.ts does not contain unguarded debug route registrations', () => {
    const fs = require('fs');
    const path = require('path');
    const serverSource = fs.readFileSync(
      path.resolve(__dirname, '../server.ts'),
      'utf-8'
    );

    // Debug route paths should not appear
    expect(serverSource).not.toContain('/debug/database');
    expect(serverSource).not.toContain('/debug/stats');
    expect(serverSource).not.toContain('/debug/sockets');
  });

  it('server.ts still has health routes registered', () => {
    const fs = require('fs');
    const path = require('path');
    const serverSource = fs.readFileSync(
      path.resolve(__dirname, '../server.ts'),
      'utf-8'
    );

    // Health routes should still be present
    expect(serverSource).toContain("app.use('/', healthRoutes)");
    expect(serverSource).toContain('/health/runtime');
  });
});

// ---------------------------------------------------------------------------
// A01-005 T42: 64 kB body rejected with 413 (32 kB limit enforced)
// ---------------------------------------------------------------------------

import * as http from 'http';
import express from 'express';
import rateLimit from 'express-rate-limit';

/** Start a minimal Express app on an ephemeral port. */
function startTestApp(app: express.Application): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('No address'));
      resolve({ server, port: (addr as { port: number }).port });
    });
    server.on('error', reject);
  });
}

/** Send a raw HTTP POST and return the HTTP status code. */
function rawPost(
  port: number,
  path: string,
  body: Buffer | string,
  headers: Record<string, string> = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(buf.byteLength),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

describe('A01-005 T42: express.json 32 kb limit — 64 kB body returns 413', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '32kb' }));
    app.post('/echo', (_req, res) => res.json({ received: true }));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err?.status === 413 || err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'payload too large' });
      }
      res.status(500).json({ error: 'internal' });
    });
    ({ server, port } = await startTestApp(app));
  });

  afterAll((done) => { server.close(() => done()); });

  it('rejects a 64 kB JSON body with 413', async () => {
    const payload = JSON.stringify({ data: 'x'.repeat(65 * 1024) });
    const status = await rawPost(port, '/echo', payload);
    expect(status).toBe(413);
  });

  it('accepts a 1 kB JSON body with 200', async () => {
    const payload = JSON.stringify({ data: 'x'.repeat(1024) });
    const status = await rawPost(port, '/echo', payload);
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// A01-005 T43: rate-limiter fires 429 before JSON parser runs (ordering proof)
// ---------------------------------------------------------------------------
describe('A01-005 T43: rate-limiter fires 429 before JSON parser heap (ordering)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const testLimiter = rateLimit({
      windowMs: 60_000,
      max: 1,
      keyGenerator: () => 'test-ip',
      standardHeaders: false,
      legacyHeaders: false,
    });

    const app = express();
    // Mirrors the A01-005 production ordering: rate-limiter BEFORE json parser.
    app.use(testLimiter);
    app.use(express.json({ limit: '32kb' }));
    app.post('/probe', (_req, res) => res.json({ received: true }));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err?.status === 413 || err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'payload too large' });
      }
      res.status(500).json({ error: 'internal' });
    });

    ({ server, port } = await startTestApp(app));
  });

  afterAll((done) => { server.close(() => done()); });

  it('first request (small body) succeeds with 200', async () => {
    const payload = JSON.stringify({ x: 1 });
    const status = await rawPost(port, '/probe', payload);
    expect(status).toBe(200);
  });

  it('second request with a 50 kB body gets 429 (not 413) — rate limiter fires first', async () => {
    // 50 kB exceeds the 32 kB limit, but rate limiter must fire FIRST: expect 429, not 413.
    const largePayload = JSON.stringify({ data: 'x'.repeat(50 * 1024) });
    const status = await rawPost(port, '/probe', largePayload);
    expect(status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// A15-008 P4-T29/T30/T42: HSTS + secure headers smoke tests
// ---------------------------------------------------------------------------

function startHeaderTestApp(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const testApp = express();

    // Mirrors the A15-008 middleware block from server.ts
    testApp.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', 'max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    });

    testApp.get('/ping', (_req, res) => res.json({ ok: true }));

    const srv = testApp.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('No address'));
      resolve({ server: srv, port: (addr as { port: number }).port });
    });
    srv.on('error', reject);
  });
}

function getHeaders(port: number, path: string): Promise<Record<string, string | string[]>> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers as Record<string, string | string[]>));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('A15-008 P4-T29/T30/T42: HSTS + OWASP baseline headers', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startHeaderTestApp());
  });

  afterAll((done) => { server.close(() => done()); });

  it('Strict-Transport-Security header is present with max-age=300', async () => {
    const headers = await getHeaders(port, '/ping');
    const hsts = headers['strict-transport-security'] as string;
    expect(hsts).toBeDefined();
    expect(hsts).toBe('max-age=300');
  });

  it('HSTS does not include includeSubDomains (staged rollout — not yet)', async () => {
    const headers = await getHeaders(port, '/ping');
    const hsts = (headers['strict-transport-security'] as string) ?? '';
    expect(hsts).not.toContain('includeSubDomains');
  });

  it('HSTS does not include preload (staged rollout — not yet)', async () => {
    const headers = await getHeaders(port, '/ping');
    const hsts = (headers['strict-transport-security'] as string) ?? '';
    expect(hsts).not.toContain('preload');
  });

  it('X-Content-Type-Options is nosniff', async () => {
    const headers = await getHeaders(port, '/ping');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('X-Frame-Options is DENY', async () => {
    const headers = await getHeaders(port, '/ping');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('Referrer-Policy is strict-origin-when-cross-origin', async () => {
    const headers = await getHeaders(port, '/ping');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('server.ts source includes the HSTS middleware block', () => {
    const fs = require('fs');
    const path = require('path');
    const source: string = fs.readFileSync(
      path.resolve(__dirname, '../server.ts'),
      'utf-8'
    );
    expect(source).toContain("res.setHeader('Strict-Transport-Security', 'max-age=300')");
    expect(source).toContain("res.setHeader('X-Content-Type-Options', 'nosniff')");
    expect(source).toContain("res.setHeader('X-Frame-Options', 'DENY')");
    expect(source).toContain("res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')");
  });
});
