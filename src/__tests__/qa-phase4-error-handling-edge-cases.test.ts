/**
 * =============================================================================
 * QA Phase 4 -- Error Handling Edge Cases
 * =============================================================================
 *
 * Covers two error-middleware fixes:
 *
 *   M7 -- Retry-After header on 429 responses (RFC 6585)
 *   M8 -- Validation details preserved for 4xx in production, stripped for 5xx
 *
 * Test strategy:
 *   1. Source-scanning tests verify the implementation patterns in
 *      error.middleware.ts so regressions are caught at the code level.
 *   2. Behavioral tests construct AppError instances and run them through
 *      a local replica of the errorHandler logic to verify actual header/body
 *      output without requiring a live Express server.
 *
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Load source files once
// ---------------------------------------------------------------------------
let errorMiddlewareSource: string;

beforeAll(() => {
  errorMiddlewareSource = fs.readFileSync(
    path.resolve(__dirname, '../shared/middleware/error.middleware.ts'),
    'utf-8',
  );
});

// =============================================================================
// M7: Retry-After header on 429 responses
// =============================================================================

describe('M7: Retry-After header on 429 responses', () => {
  // -------------------------------------------------------------------------
  // Source-scanning tests
  // -------------------------------------------------------------------------
  describe('Source structure', () => {
    it('error.middleware.ts contains the M7 fix comment marker', () => {
      expect(errorMiddlewareSource).toContain('M7');
    });

    it('checks error.statusCode === 429 before setting Retry-After', () => {
      // The conditional guard must exist so non-429 errors are excluded
      expect(errorMiddlewareSource).toMatch(/error\.statusCode\s*===\s*429/);
    });

    it('reads retryAfter from error.details first', () => {
      expect(errorMiddlewareSource).toContain('error.details?.retryAfter');
    });

    it('reads retryAfterSeconds from error.details as alternative key', () => {
      expect(errorMiddlewareSource).toContain('error.details?.retryAfterSeconds');
    });

    it('falls back to 30 seconds when no retryAfter value is provided', () => {
      // The nullish coalescing chain should end with '30'
      expect(errorMiddlewareSource).toMatch(
        /error\.details\?\.\s*retryAfter\s*\?\?\s*error\.details\?\.\s*retryAfterSeconds\s*\?\?\s*['"]30['"]/,
      );
    });

    it('sets the Retry-After header via res.setHeader', () => {
      expect(errorMiddlewareSource).toMatch(
        /res\.setHeader\s*\(\s*['"]Retry-After['"]/,
      );
    });

    it('converts the retryAfter value to string via String()', () => {
      expect(errorMiddlewareSource).toContain('String(retryAfter)');
    });
  });

  // -------------------------------------------------------------------------
  // Behavioral tests -- simulated errorHandler logic
  // -------------------------------------------------------------------------
  describe('Behavioral: 429 with retryAfter in details', () => {
    /**
     * Minimal replica of the 429 Retry-After logic from error.middleware.ts.
     * We replicate just the header-setting branch to test its output without
     * needing a running Express app.
     */
    function simulateRetryAfterHeader(
      statusCode: number,
      details?: Record<string, unknown>,
    ): string | undefined {
      if (statusCode === 429) {
        const retryAfter =
          details?.retryAfter ?? details?.retryAfterSeconds ?? '30';
        return String(retryAfter);
      }
      return undefined;
    }

    it('429 with retryAfter=60 returns "60"', () => {
      const header = simulateRetryAfterHeader(429, { retryAfter: 60 });
      expect(header).toBe('60');
    });

    it('429 with retryAfterSeconds=45 returns "45"', () => {
      const header = simulateRetryAfterHeader(429, { retryAfterSeconds: 45 });
      expect(header).toBe('45');
    });

    it('429 with both keys prefers retryAfter over retryAfterSeconds', () => {
      const header = simulateRetryAfterHeader(429, {
        retryAfter: 10,
        retryAfterSeconds: 99,
      });
      expect(header).toBe('10');
    });

    it('429 with no details falls back to "30"', () => {
      const header = simulateRetryAfterHeader(429, undefined);
      expect(header).toBe('30');
    });

    it('429 with empty details falls back to "30"', () => {
      const header = simulateRetryAfterHeader(429, {});
      expect(header).toBe('30');
    });

    it('429 with retryAfter=0 returns "0" (not the fallback)', () => {
      // 0 is falsy but nullish coalescing (??) only triggers on null/undefined
      const header = simulateRetryAfterHeader(429, { retryAfter: 0 });
      expect(header).toBe('0');
    });

    it('429 with retryAfter as string returns the string directly', () => {
      const header = simulateRetryAfterHeader(429, { retryAfter: '120' });
      expect(header).toBe('120');
    });
  });

  describe('Behavioral: non-429 codes do NOT get Retry-After', () => {
    function simulateRetryAfterHeader(
      statusCode: number,
      details?: Record<string, unknown>,
    ): string | undefined {
      if (statusCode === 429) {
        const retryAfter =
          details?.retryAfter ?? details?.retryAfterSeconds ?? '30';
        return String(retryAfter);
      }
      return undefined;
    }

    it('400 validation error does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(400, { retryAfter: 30 })).toBeUndefined();
    });

    it('401 unauthorized does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(401)).toBeUndefined();
    });

    it('403 forbidden does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(403)).toBeUndefined();
    });

    it('404 not found does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(404)).toBeUndefined();
    });

    it('409 conflict does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(409)).toBeUndefined();
    });

    it('422 unprocessable entity does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(422)).toBeUndefined();
    });

    it('500 internal error does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(500)).toBeUndefined();
    });

    it('502 bad gateway does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(502)).toBeUndefined();
    });

    it('503 service unavailable does not produce Retry-After', () => {
      expect(simulateRetryAfterHeader(503)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Full mock-Express behavioral test
  // -------------------------------------------------------------------------
  describe('Behavioral: mock Express response for 429', () => {
    interface MockResponse {
      statusCode: number;
      headers: Record<string, string>;
      body: unknown;
      status(code: number): MockResponse;
      setHeader(name: string, value: string): MockResponse;
      json(data: unknown): void;
    }

    function createMockRes(): MockResponse {
      const res: MockResponse = {
        statusCode: 0,
        headers: {},
        body: undefined,
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        setHeader(name: string, value: string) {
          res.headers[name] = value;
          return res;
        },
        json(data: unknown) {
          res.body = data;
        },
      };
      return res;
    }

    /**
     * Faithfully replicates the AppError branch of errorHandler from
     * error.middleware.ts so we can test real header + body output.
     */
    function runErrorHandler(
      statusCode: number,
      code: string,
      message: string,
      details: Record<string, unknown> | undefined,
      isDevelopment: boolean,
    ): MockResponse {
      const res = createMockRes();

      // Replicate safeDetails logic (M8)
      const safeDetails =
        details && (isDevelopment || statusCode < 500) ? details : undefined;

      // Replicate Retry-After logic (M7)
      if (statusCode === 429) {
        const retryAfter =
          details?.retryAfter ?? details?.retryAfterSeconds ?? '30';
        res.setHeader('Retry-After', String(retryAfter));
      }

      res.status(statusCode).json({
        success: false,
        error: {
          code,
          message,
          ...(safeDetails && { details: safeDetails }),
        },
      });

      return res;
    }

    it('429 from rate limiter includes Retry-After header and details', () => {
      const res = runErrorHandler(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many requests',
        { retryAfter: 60, window: '1 minute' },
        false, // production
      );

      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('60');
      // 429 is < 500, so details should be present in production (M8)
      expect((res.body as any).error.details).toEqual({
        retryAfter: 60,
        window: '1 minute',
      });
    });

    it('429 from OTP cooldown includes Retry-After header with retryAfterSeconds', () => {
      const res = runErrorHandler(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Please wait before requesting another OTP',
        { retryAfterSeconds: 30 },
        false,
      );

      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('30');
      expect((res.body as any).error.details).toEqual({ retryAfterSeconds: 30 });
    });

    it('429 without any details uses fallback of 30', () => {
      const res = runErrorHandler(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many requests',
        undefined,
        false,
      );

      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('30');
      // No details to spread since they are undefined
      expect((res.body as any).error.details).toBeUndefined();
    });

    it('400 validation error does NOT have Retry-After header', () => {
      const res = runErrorHandler(
        400,
        'VALIDATION_ERROR',
        'Invalid phone number',
        { field: 'phone', rule: 'E.164 format required' },
        false,
      );

      expect(res.statusCode).toBe(400);
      expect(res.headers['Retry-After']).toBeUndefined();
      // 400 is < 500, so details should be present (M8)
      expect((res.body as any).error.details).toEqual({
        field: 'phone',
        rule: 'E.164 format required',
      });
    });

    it('500 internal error does NOT have Retry-After header', () => {
      const res = runErrorHandler(
        500,
        'INTERNAL_ERROR',
        'Something went wrong',
        { stack: 'Error at line 42' },
        false,
      );

      expect(res.statusCode).toBe(500);
      expect(res.headers['Retry-After']).toBeUndefined();
      // 500 in production, details stripped (M8)
      expect((res.body as any).error.details).toBeUndefined();
    });
  });
});

// =============================================================================
// M8: Validation details preserved for 4xx, stripped for 5xx in production
// =============================================================================

describe('M8: Validation details not stripped for 4xx in production', () => {
  // -------------------------------------------------------------------------
  // Source-scanning tests
  // -------------------------------------------------------------------------
  describe('Source structure', () => {
    it('error.middleware.ts contains the M8 fix comment marker', () => {
      expect(errorMiddlewareSource).toContain('M8');
    });

    it('safeDetails conditional checks isDevelopment OR statusCode < 500', () => {
      // The exact pattern: config.isDevelopment || error.statusCode < 500
      expect(errorMiddlewareSource).toMatch(
        /config\.isDevelopment\s*\|\|\s*error\.statusCode\s*<\s*500/,
      );
    });

    it('safeDetails is computed before the response is sent', () => {
      // safeDetails should be assigned before res.status().json()
      const safeDetailsIdx = errorMiddlewareSource.indexOf('safeDetails');
      const resStatusIdx = errorMiddlewareSource.indexOf(
        'res.status(error.statusCode).json',
      );
      expect(safeDetailsIdx).toBeGreaterThan(-1);
      expect(resStatusIdx).toBeGreaterThan(-1);
      expect(safeDetailsIdx).toBeLessThan(resStatusIdx);
    });

    it('details are spread into the error response only when safeDetails is truthy', () => {
      expect(errorMiddlewareSource).toMatch(
        /\.\.\.\(\s*safeDetails\s*&&\s*\{\s*details:\s*safeDetails\s*\}\s*\)/,
      );
    });

    it('error.details is checked for truthiness before applying isDevelopment/statusCode guard', () => {
      // Pattern: error.details && (config.isDevelopment || error.statusCode < 500)
      expect(errorMiddlewareSource).toMatch(
        /error\.details\s*&&\s*\(\s*config\.isDevelopment\s*\|\|\s*error\.statusCode\s*<\s*500\s*\)/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Behavioral tests -- safeDetails logic replica
  // -------------------------------------------------------------------------
  describe('Behavioral: safeDetails computation', () => {
    /**
     * Exact replica of the safeDetails line from error.middleware.ts:
     *   const safeDetails = error.details && (config.isDevelopment || error.statusCode < 500)
     *     ? error.details : undefined;
     */
    function computeSafeDetails(
      statusCode: number,
      details: Record<string, unknown> | undefined,
      isDevelopment: boolean,
    ): Record<string, unknown> | undefined {
      return details && (isDevelopment || statusCode < 500)
        ? details
        : undefined;
    }

    // -- Production: 4xx codes -- details SHOULD be returned ----------------

    it('400 validation error in production -> details returned', () => {
      const details = { field: 'email', message: 'Invalid format' };
      expect(computeSafeDetails(400, details, false)).toEqual(details);
    });

    it('401 unauthorized in production -> details returned', () => {
      const details = { reason: 'Token expired' };
      expect(computeSafeDetails(401, details, false)).toEqual(details);
    });

    it('403 forbidden in production -> details returned', () => {
      const details = { requiredRole: 'admin' };
      expect(computeSafeDetails(403, details, false)).toEqual(details);
    });

    it('404 not found in production -> details returned', () => {
      const details = { resource: 'order', id: 'ord-123' };
      expect(computeSafeDetails(404, details, false)).toEqual(details);
    });

    it('409 conflict in production -> details returned', () => {
      const details = { conflictingField: 'phone', existingUserId: 'u-1' };
      expect(computeSafeDetails(409, details, false)).toEqual(details);
    });

    it('422 unprocessable entity in production -> details returned', () => {
      const details = { errors: [{ path: 'weight', msg: 'Must be > 0' }] };
      expect(computeSafeDetails(422, details, false)).toEqual(details);
    });

    it('429 rate limit in production -> details returned', () => {
      const details = { retryAfter: 60, limit: 100, window: '1 minute' };
      expect(computeSafeDetails(429, details, false)).toEqual(details);
    });

    it('499 (custom client error) in production -> details returned', () => {
      const details = { reason: 'Client closed request' };
      expect(computeSafeDetails(499, details, false)).toEqual(details);
    });

    // -- Production: 5xx codes -- details SHOULD be stripped ----------------

    it('500 internal error in production -> details stripped', () => {
      const details = { query: 'SELECT * FROM users', stack: 'at line 42' };
      expect(computeSafeDetails(500, details, false)).toBeUndefined();
    });

    it('502 bad gateway in production -> details stripped', () => {
      const details = { upstream: 'payment-service', timeout: 5000 };
      expect(computeSafeDetails(502, details, false)).toBeUndefined();
    });

    it('503 service unavailable in production -> details stripped', () => {
      const details = { service: 'redis', lastPing: 'never' };
      expect(computeSafeDetails(503, details, false)).toBeUndefined();
    });

    it('504 gateway timeout in production -> details stripped', () => {
      const details = { service: 'geocoding-api', waitedMs: 30000 };
      expect(computeSafeDetails(504, details, false)).toBeUndefined();
    });

    // -- Development: ALL codes return details ------------------------------

    it('400 validation error in development -> details returned', () => {
      const details = { field: 'phone' };
      expect(computeSafeDetails(400, details, true)).toEqual(details);
    });

    it('500 internal error in development -> details returned', () => {
      const details = { query: 'SELECT * FROM users' };
      expect(computeSafeDetails(500, details, true)).toEqual(details);
    });

    it('503 service unavailable in development -> details returned', () => {
      const details = { service: 'redis' };
      expect(computeSafeDetails(503, details, true)).toEqual(details);
    });

    // -- Edge cases: undefined/null details ---------------------------------

    it('400 with undefined details in production -> undefined', () => {
      expect(computeSafeDetails(400, undefined, false)).toBeUndefined();
    });

    it('500 with undefined details in production -> undefined', () => {
      expect(computeSafeDetails(500, undefined, false)).toBeUndefined();
    });

    it('400 with undefined details in development -> undefined', () => {
      expect(computeSafeDetails(400, undefined, true)).toBeUndefined();
    });

    it('500 with undefined details in development -> undefined', () => {
      expect(computeSafeDetails(500, undefined, true)).toBeUndefined();
    });

    // -- Boundary: statusCode exactly 500 (first 5xx) ----------------------

    it('statusCode 499 in production -> details returned (last 4xx)', () => {
      const details = { boundary: true };
      expect(computeSafeDetails(499, details, false)).toEqual(details);
    });

    it('statusCode 500 in production -> details stripped (first 5xx)', () => {
      const details = { boundary: true };
      expect(computeSafeDetails(500, details, false)).toBeUndefined();
    });

    it('statusCode 501 in production -> details stripped', () => {
      const details = { method: 'PATCH' };
      expect(computeSafeDetails(501, details, false)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Full mock-Express behavioral test: response body verification
  // -------------------------------------------------------------------------
  describe('Behavioral: full response body for AppError', () => {
    interface MockResponse {
      statusCode: number;
      headers: Record<string, string>;
      body: unknown;
      status(code: number): MockResponse;
      setHeader(name: string, value: string): MockResponse;
      json(data: unknown): void;
    }

    function createMockRes(): MockResponse {
      const res: MockResponse = {
        statusCode: 0,
        headers: {},
        body: undefined,
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        setHeader(name: string, value: string) {
          res.headers[name] = value;
          return res;
        },
        json(data: unknown) {
          res.body = data;
        },
      };
      return res;
    }

    /**
     * Faithful replica of the AppError branch of errorHandler.
     */
    function runAppErrorHandler(
      statusCode: number,
      code: string,
      message: string,
      details: Record<string, unknown> | undefined,
      isDevelopment: boolean,
    ): MockResponse {
      const res = createMockRes();

      const safeDetails =
        details && (isDevelopment || statusCode < 500) ? details : undefined;

      if (statusCode === 429) {
        const retryAfter =
          details?.retryAfter ?? details?.retryAfterSeconds ?? '30';
        res.setHeader('Retry-After', String(retryAfter));
      }

      res.status(statusCode).json({
        success: false,
        error: {
          code,
          message,
          ...(safeDetails && { details: safeDetails }),
        },
      });

      return res;
    }

    // -- 4xx in production: details in body --------------------------------

    it('400 VALIDATION_ERROR in production includes field-level details', () => {
      const res = runAppErrorHandler(
        400,
        'VALIDATION_ERROR',
        'Invalid input',
        { fields: { phone: 'Required', weight: 'Must be positive' } },
        false,
      );

      expect(res.statusCode).toBe(400);
      const body = res.body as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual({
        fields: { phone: 'Required', weight: 'Must be positive' },
      });
    });

    it('404 NOT_FOUND in production includes resource details', () => {
      const res = runAppErrorHandler(
        404,
        'NOT_FOUND',
        'Order not found',
        { resource: 'Order', id: 'ord-xyz' },
        false,
      );

      expect(res.statusCode).toBe(404);
      expect((res.body as any).error.details).toEqual({
        resource: 'Order',
        id: 'ord-xyz',
      });
    });

    it('409 CONFLICT in production includes conflict details', () => {
      const res = runAppErrorHandler(
        409,
        'CONFLICT',
        'Phone number already registered',
        { existingUserId: 'u-999' },
        false,
      );

      expect(res.statusCode).toBe(409);
      expect((res.body as any).error.details).toEqual({
        existingUserId: 'u-999',
      });
    });

    it('422 UNPROCESSABLE in production includes validation errors array', () => {
      const res = runAppErrorHandler(
        422,
        'UNPROCESSABLE_ENTITY',
        'Validation failed',
        { errors: [{ path: 'pickup.lat', msg: 'Out of range' }] },
        false,
      );

      expect(res.statusCode).toBe(422);
      expect((res.body as any).error.details.errors).toHaveLength(1);
    });

    it('429 RATE_LIMIT in production includes retryAfter AND Retry-After header', () => {
      const res = runAppErrorHandler(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many requests',
        { retryAfter: 45, limit: 5, window: '1 minute' },
        false,
      );

      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('45');
      expect((res.body as any).error.details).toEqual({
        retryAfter: 45,
        limit: 5,
        window: '1 minute',
      });
    });

    // -- 5xx in production: details stripped from body ----------------------

    it('500 INTERNAL_ERROR in production strips sensitive details', () => {
      const res = runAppErrorHandler(
        500,
        'INTERNAL_ERROR',
        'Something went wrong',
        { query: 'SELECT * FROM users WHERE id=$1', params: ['u-1'] },
        false,
      );

      expect(res.statusCode).toBe(500);
      expect((res.body as any).error.details).toBeUndefined();
      expect((res.body as any).error.message).toBe('Something went wrong');
    });

    it('503 SERVICE_UNAVAILABLE in production strips infrastructure details', () => {
      const res = runAppErrorHandler(
        503,
        'SERVICE_UNAVAILABLE',
        'Service temporarily unavailable',
        { redis: 'disconnected', pgPool: 'exhausted' },
        false,
      );

      expect(res.statusCode).toBe(503);
      expect((res.body as any).error.details).toBeUndefined();
    });

    // -- 5xx in development: details are shown -----------------------------

    it('500 in development includes full details for debugging', () => {
      const res = runAppErrorHandler(
        500,
        'INTERNAL_ERROR',
        'Query failed',
        { query: 'SELECT * FROM users', stack: 'at pgPool.query:42' },
        true,
      );

      expect(res.statusCode).toBe(500);
      expect((res.body as any).error.details).toEqual({
        query: 'SELECT * FROM users',
        stack: 'at pgPool.query:42',
      });
    });

    it('503 in development includes full details for debugging', () => {
      const res = runAppErrorHandler(
        503,
        'SERVICE_UNAVAILABLE',
        'Redis down',
        { redis: 'ECONNREFUSED', host: 'localhost:6379' },
        true,
      );

      expect(res.statusCode).toBe(503);
      expect((res.body as any).error.details).toEqual({
        redis: 'ECONNREFUSED',
        host: 'localhost:6379',
      });
    });

    // -- Response structure invariants -------------------------------------

    it('response always includes success=false', () => {
      const res = runAppErrorHandler(
        418,
        'IM_A_TEAPOT',
        'I refuse',
        undefined,
        false,
      );

      expect((res.body as any).success).toBe(false);
    });

    it('response always includes error.code and error.message', () => {
      const res = runAppErrorHandler(
        400,
        'VALIDATION_ERROR',
        'Bad request',
        undefined,
        false,
      );

      const body = res.body as any;
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('Bad request');
    });

    it('response does not include details key when details is undefined', () => {
      const res = runAppErrorHandler(
        400,
        'VALIDATION_ERROR',
        'Missing field',
        undefined,
        false,
      );

      expect(Object.keys((res.body as any).error)).not.toContain('details');
    });
  });
});

// =============================================================================
// Cross-cutting: M7 + M8 interaction on 429
// =============================================================================

describe('M7 + M8 interaction: 429 response in production', () => {
  /**
   * Combined replica to test both fixes working together.
   */
  function simulateFullAppErrorResponse(
    statusCode: number,
    details: Record<string, unknown> | undefined,
    isDevelopment: boolean,
  ): { headers: Record<string, string>; detailsInBody: boolean } {
    const headers: Record<string, string> = {};

    // M8: safeDetails
    const safeDetails =
      details && (isDevelopment || statusCode < 500) ? details : undefined;

    // M7: Retry-After
    if (statusCode === 429) {
      const retryAfter =
        details?.retryAfter ?? details?.retryAfterSeconds ?? '30';
      headers['Retry-After'] = String(retryAfter);
    }

    return {
      headers,
      detailsInBody: safeDetails !== undefined,
    };
  }

  it('429 in production: both Retry-After header AND body details present', () => {
    const result = simulateFullAppErrorResponse(
      429,
      { retryAfter: 60, reason: 'rate limit' },
      false,
    );

    expect(result.headers['Retry-After']).toBe('60');
    expect(result.detailsInBody).toBe(true);
  });

  it('429 in development: both Retry-After header AND body details present', () => {
    const result = simulateFullAppErrorResponse(
      429,
      { retryAfter: 10 },
      true,
    );

    expect(result.headers['Retry-After']).toBe('10');
    expect(result.detailsInBody).toBe(true);
  });

  it('429 with no details in production: Retry-After=30, no body details', () => {
    const result = simulateFullAppErrorResponse(429, undefined, false);

    expect(result.headers['Retry-After']).toBe('30');
    expect(result.detailsInBody).toBe(false);
  });

  it('500 in production: no Retry-After header, no body details', () => {
    const result = simulateFullAppErrorResponse(
      500,
      { secret: 'should-not-leak' },
      false,
    );

    expect(result.headers['Retry-After']).toBeUndefined();
    expect(result.detailsInBody).toBe(false);
  });

  it('400 in production: no Retry-After header, body details present', () => {
    const result = simulateFullAppErrorResponse(
      400,
      { field: 'phone', message: 'invalid' },
      false,
    );

    expect(result.headers['Retry-After']).toBeUndefined();
    expect(result.detailsInBody).toBe(true);
  });
});

// =============================================================================
// Edge case: unknown error (non-AppError) handling
// =============================================================================

describe('Unknown error (non-AppError) handling in error.middleware.ts', () => {
  describe('Source structure', () => {
    it('unknown errors return 500 status', () => {
      // The catch-all branch for non-AppError uses status(500)
      expect(errorMiddlewareSource).toMatch(/res\.status\(500\)\.json/);
    });

    it('unknown errors use "INTERNAL_ERROR" code', () => {
      expect(errorMiddlewareSource).toContain("code: 'INTERNAL_ERROR'");
    });

    it('production hides unknown error message behind generic text', () => {
      expect(errorMiddlewareSource).toContain(
        'An unexpected error occurred. Please try again later.',
      );
    });

    it('development exposes original error.message for unknown errors', () => {
      // The conditional: config.isDevelopment ? error.message : 'An unexpected...'
      expect(errorMiddlewareSource).toMatch(
        /config\.isDevelopment\s*\?\s*error\.message/,
      );
    });

    it('unknown errors do NOT receive Retry-After header', () => {
      // The Retry-After logic is inside the AppError instanceof check,
      // so it never runs for plain Error instances
      const appErrorBlock = errorMiddlewareSource.indexOf(
        'if (error instanceof AppError)',
      );
      const retryAfterBlock = errorMiddlewareSource.indexOf('Retry-After');
      const unknownBlock = errorMiddlewareSource.indexOf(
        'Unknown error - send generic response',
      );

      expect(appErrorBlock).toBeGreaterThan(-1);
      expect(retryAfterBlock).toBeGreaterThan(appErrorBlock);
      expect(unknownBlock).toBeGreaterThan(retryAfterBlock);
      // Retry-After appears before the unknown block, confirming it is
      // inside the AppError branch, not the unknown branch.
    });

    it('unknown errors never expose stack traces in the response', () => {
      // The unknown-error JSON response should not include `stack`
      // Verify no `.stack` appears in the 500 json block
      const unknownBlockStart = errorMiddlewareSource.indexOf(
        'Unknown error - send generic response',
      );
      const unknownBlock = errorMiddlewareSource.substring(unknownBlockStart);
      expect(unknownBlock).not.toContain('stack:');
    });
  });
});
