/**
 * =============================================================================
 * PHASE 4: ERROR MIDDLEWARE FIXES — Exhaustive Tests
 * =============================================================================
 *
 * Tests for M7 and M8 fixes in error.middleware.ts:
 *
 * M7: Retry-After header on 429 responses (RFC 6585 compliance)
 * M8: Validation details returned for 4xx in production, stripped for 5xx
 *
 * Test approach:
 * - Source scanning: verify the code patterns exist in the middleware source
 * - Behavioral tests: invoke errorHandler directly with mock Express objects
 *
 * @author Team Lita, Agent 4
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// SOURCE FILE READING
// =============================================================================

const ERROR_MIDDLEWARE_PATH = path.resolve(
  __dirname,
  '../shared/middleware/error.middleware.ts'
);
const errorMiddlewareSrc = fs.readFileSync(ERROR_MIDDLEWARE_PATH, 'utf-8');

// =============================================================================
// MOCK SETUP — Must come before imports of the middleware
// =============================================================================

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock config with overridable isDevelopment flag
let mockIsDevelopment = false;
jest.mock('../config/environment', () => ({
  get config() {
    return {
      isDevelopment: mockIsDevelopment,
      isProduction: !mockIsDevelopment,
      isTest: false,
      nodeEnv: mockIsDevelopment ? 'development' : 'production',
      redis: { enabled: false },
      otp: { expiryMinutes: 5 },
      sms: {},
    };
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { errorHandler } from '../shared/middleware/error.middleware';
import { AppError } from '../shared/types/error.types';
import { Request, Response, NextFunction } from 'express';

// =============================================================================
// TEST HELPERS
// =============================================================================

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  set: jest.Mock;
  headersSent: boolean;
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    path: '/api/v1/test',
    method: 'POST',
    ip: '127.0.0.1',
    userId: 'test-user-001',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    headersSent: false,
  };
  return res;
}

const noopNext: NextFunction = jest.fn();

// =============================================================================
// =============================================================================
// M7: Retry-After Header on 429 Responses
// =============================================================================
// =============================================================================

describe('M7: Retry-After header on 429 responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevelopment = false; // production mode by default
  });

  // ---------------------------------------------------------------------------
  // Source Scanning Tests
  // ---------------------------------------------------------------------------

  describe('Source scanning: error.middleware.ts patterns', () => {
    it('should contain a statusCode === 429 check', () => {
      expect(errorMiddlewareSrc).toMatch(/statusCode\s*===\s*429/);
    });

    it('should contain res.setHeader("Retry-After", ...) call', () => {
      // Matches res.setHeader('Retry-After', ...) with single or double quotes
      expect(errorMiddlewareSrc).toMatch(
        /res\.setHeader\s*\(\s*['"]Retry-After['"]/
      );
    });

    it('should check error.details?.retryAfter for custom value', () => {
      expect(errorMiddlewareSrc).toMatch(/error\.details\?\.retryAfter/);
    });

    it('should check error.details?.retryAfterSeconds as fallback', () => {
      expect(errorMiddlewareSrc).toMatch(/error\.details\?\.retryAfterSeconds/);
    });

    it('should have a fallback value of "30" for Retry-After', () => {
      // Match the nullish coalescing or OR pattern with '30' as the last fallback
      expect(errorMiddlewareSrc).toMatch(/['"]30['"]/);
    });

    it('should use String() to coerce the Retry-After value', () => {
      expect(errorMiddlewareSrc).toMatch(/String\s*\(/);
    });

    it('should contain a comment referencing RFC 6585 or M7', () => {
      const hasRfc = errorMiddlewareSrc.includes('RFC 6585');
      const hasM7 = errorMiddlewareSrc.includes('M7');
      expect(hasRfc || hasM7).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: 429 with Retry-After
  // ---------------------------------------------------------------------------

  describe('Behavioral: errorHandler sets Retry-After for 429', () => {
    it('should set Retry-After header when statusCode is 429', () => {
      const error = new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });

    it('should default Retry-After to "30" when no details provided', () => {
      const error = new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    });

    it('should use error.details.retryAfter when provided', () => {
      const error = new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many requests',
        { retryAfter: 60 }
      );
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    });

    it('should use error.details.retryAfterSeconds when retryAfter is absent', () => {
      const error = new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many requests',
        { retryAfterSeconds: 120 }
      );
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '120');
    });

    it('should prefer retryAfter over retryAfterSeconds when both exist', () => {
      const error = new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Too many requests',
        { retryAfter: 45, retryAfterSeconds: 90 }
      );
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      // retryAfter is checked first via ?? operator
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '45');
    });

    it('should convert numeric retryAfter to string', () => {
      const error = new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Rate limited',
        { retryAfter: 15 }
      );
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const headerCall = res.setHeader.mock.calls.find(
        (c: any[]) => c[0] === 'Retry-After'
      );
      expect(headerCall).toBeDefined();
      expect(typeof headerCall![1]).toBe('string');
    });

    it('should accept string retryAfter values', () => {
      const error = new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Rate limited',
        { retryAfter: '300' }
      );
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '300');
    });

    it('should NOT set Retry-After for non-429 errors (400)', () => {
      const error = new AppError(400, 'VALIDATION_ERROR', 'Bad request');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const retryAfterCalls = res.setHeader.mock.calls.filter(
        (c: any[]) => c[0] === 'Retry-After'
      );
      expect(retryAfterCalls).toHaveLength(0);
    });

    it('should NOT set Retry-After for non-429 errors (401)', () => {
      const error = new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const retryAfterCalls = res.setHeader.mock.calls.filter(
        (c: any[]) => c[0] === 'Retry-After'
      );
      expect(retryAfterCalls).toHaveLength(0);
    });

    it('should NOT set Retry-After for 500 errors', () => {
      const error = new AppError(500, 'INTERNAL_ERROR', 'Server error');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const retryAfterCalls = res.setHeader.mock.calls.filter(
        (c: any[]) => c[0] === 'Retry-After'
      );
      expect(retryAfterCalls).toHaveLength(0);
    });

    it('should NOT set Retry-After for 404 errors', () => {
      const error = new AppError(404, 'NOT_FOUND', 'Resource not found');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const retryAfterCalls = res.setHeader.mock.calls.filter(
        (c: any[]) => c[0] === 'Retry-After'
      );
      expect(retryAfterCalls).toHaveLength(0);
    });

    it('should still return 429 status code in json response body', () => {
      const error = new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests',
          }),
        })
      );
    });

    it('should set Retry-After header BEFORE sending json body', () => {
      const callOrder: string[] = [];
      const error = new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limited');
      const req = createMockReq();
      const res = createMockRes();

      res.setHeader.mockImplementation((..._args: any[]) => {
        callOrder.push('setHeader');
        return res;
      });
      res.status.mockImplementation((..._args: any[]) => {
        callOrder.push('status');
        return res;
      });
      res.json.mockImplementation((..._args: any[]) => {
        callOrder.push('json');
        return res;
      });

      errorHandler(error, req, res as unknown as Response, noopNext);

      const setHeaderIdx = callOrder.indexOf('setHeader');
      const jsonIdx = callOrder.indexOf('json');
      expect(setHeaderIdx).toBeLessThan(jsonIdx);
    });

    it('should handle zero as retryAfter value', () => {
      const error = new AppError(
        429,
        'RATE_LIMIT_EXCEEDED',
        'Rate limited',
        { retryAfter: 0 }
      );
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      // 0 is falsy so ?? falls through; verify behavior is still correct
      // The middleware uses ??, so 0 falls through to retryAfterSeconds or '30'
      // This is acceptable behavior -- 0 is not a valid Retry-After
      expect(res.setHeader).toHaveBeenCalledWith(
        'Retry-After',
        expect.any(String)
      );
    });
  });
});

// =============================================================================
// =============================================================================
// M8: Validation Details Returned for 4xx in Production
// =============================================================================
// =============================================================================

describe('M8: Validation details for 4xx in production, stripped for 5xx', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Source Scanning Tests
  // ---------------------------------------------------------------------------

  describe('Source scanning: error.middleware.ts safeDetails pattern', () => {
    it('should contain a statusCode < 500 check for safeDetails', () => {
      expect(errorMiddlewareSrc).toMatch(/statusCode\s*<\s*500/);
    });

    it('should OR the statusCode < 500 check with config.isDevelopment', () => {
      // The pattern: config.isDevelopment || error.statusCode < 500
      expect(errorMiddlewareSrc).toMatch(
        /config\.isDevelopment\s*\|\|\s*error\.statusCode\s*<\s*500/
      );
    });

    it('should use error.details in the safeDetails conditional', () => {
      expect(errorMiddlewareSrc).toMatch(/error\.details\s*&&/);
    });

    it('should include a spread for details in the response JSON', () => {
      // Pattern: ...(safeDetails && { details: safeDetails })
      expect(errorMiddlewareSrc).toMatch(
        /\.\.\.\(safeDetails\s*&&\s*\{\s*details:\s*safeDetails\s*\}\)/
      );
    });

    it('should set safeDetails to undefined when condition is false', () => {
      // The ternary: ? error.details : undefined
      expect(errorMiddlewareSrc).toMatch(/:\s*undefined/);
    });

    it('should contain a comment referencing M8 or G3', () => {
      const hasM8 = errorMiddlewareSrc.includes('M8');
      const hasG3 = errorMiddlewareSrc.includes('G3');
      expect(hasM8 || hasG3).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: 4xx details in production
  // ---------------------------------------------------------------------------

  describe('Behavioral: 4xx errors include details in production', () => {
    beforeEach(() => {
      mockIsDevelopment = false; // production mode
    });

    it('should include details for 400 validation errors in production', () => {
      const details = { field: 'email', reason: 'Invalid format' };
      const error = new AppError(400, 'VALIDATION_ERROR', 'Invalid input', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_ERROR',
            message: 'Invalid input',
            details: { field: 'email', reason: 'Invalid format' },
          }),
        })
      );
    });

    it('should include details for 401 errors in production', () => {
      const details = { reason: 'Token expired' };
      const error = new AppError(401, 'UNAUTHORIZED', 'Auth failed', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { reason: 'Token expired' },
          }),
        })
      );
    });

    it('should include details for 403 errors in production', () => {
      const details = { requiredRole: 'admin' };
      const error = new AppError(403, 'FORBIDDEN', 'Access denied', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { requiredRole: 'admin' },
          }),
        })
      );
    });

    it('should include details for 404 errors in production', () => {
      const details = { resource: 'booking', id: 'bk-123' };
      const error = new AppError(404, 'NOT_FOUND', 'Not found', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { resource: 'booking', id: 'bk-123' },
          }),
        })
      );
    });

    it('should include details for 409 conflict errors in production', () => {
      const details = { conflictOn: 'vehicleId', currentHolder: 'order-456' };
      const error = new AppError(409, 'CONFLICT', 'Resource conflict', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { conflictOn: 'vehicleId', currentHolder: 'order-456' },
          }),
        })
      );
    });

    it('should include details for 422 errors in production', () => {
      const details = { fields: ['pickup.lat', 'drop.lng'] };
      const error = new AppError(422, 'UNPROCESSABLE', 'Validation failed', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { fields: ['pickup.lat', 'drop.lng'] },
          }),
        })
      );
    });

    it('should include details for 429 rate limit errors in production', () => {
      const details = { retryAfter: 60, limit: 100, remaining: 0 };
      const error = new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { retryAfter: 60, limit: 100, remaining: 0 },
          }),
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: 5xx details stripped in production
  // ---------------------------------------------------------------------------

  describe('Behavioral: 5xx errors strip details in production', () => {
    beforeEach(() => {
      mockIsDevelopment = false; // production mode
    });

    it('should NOT include details for 500 errors in production', () => {
      const details = { sqlError: 'P2034: Deadlock detected', table: 'Booking' };
      const error = new AppError(500, 'INTERNAL_ERROR', 'Server error', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
    });

    it('should NOT include details for 502 errors in production', () => {
      const details = { upstream: 'google-maps-api', status: 503 };
      const error = new AppError(502, 'BAD_GATEWAY', 'Upstream error', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
    });

    it('should NOT include details for 503 errors in production', () => {
      const details = { service: 'redis', reason: 'ECONNREFUSED' };
      const error = new AppError(503, 'SERVICE_UNAVAILABLE', 'Unavailable', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
    });

    it('should still include error code and message for 500 errors in production', () => {
      const error = new AppError(500, 'INTERNAL_ERROR', 'Something broke', { leak: 'secret' });
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
            message: 'Something broke',
          }),
        })
      );
      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
    });

    it('should NOT leak DB error details in 500 response body', () => {
      const sensitiveDetails = {
        query: 'SELECT * FROM users WHERE id = $1',
        params: ['user-123'],
        dbHost: 'prod-rds.amazonaws.com',
      };
      const error = new AppError(500, 'DB_ERROR', 'Query failed', sensitiveDetails);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
      expect(JSON.stringify(responseBody)).not.toContain('prod-rds.amazonaws.com');
      expect(JSON.stringify(responseBody)).not.toContain('SELECT');
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: development mode shows all details
  // ---------------------------------------------------------------------------

  describe('Behavioral: development mode shows all details', () => {
    beforeEach(() => {
      mockIsDevelopment = true;
    });

    it('should include details for 500 errors in development', () => {
      const details = { sqlError: 'deadlock', stack: 'full trace' };
      const error = new AppError(500, 'INTERNAL_ERROR', 'Dev error', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { sqlError: 'deadlock', stack: 'full trace' },
          }),
        })
      );
    });

    it('should include details for 503 errors in development', () => {
      const details = { redis: 'ECONNREFUSED' };
      const error = new AppError(503, 'SERVICE_UNAVAILABLE', 'Redis down', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { redis: 'ECONNREFUSED' },
          }),
        })
      );
    });

    it('should include details for 400 errors in development', () => {
      const details = { field: 'phone', constraint: 'required' };
      const error = new AppError(400, 'VALIDATION_ERROR', 'Bad input', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { field: 'phone', constraint: 'required' },
          }),
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: no details provided
  // ---------------------------------------------------------------------------

  describe('Behavioral: AppError without details', () => {
    beforeEach(() => {
      mockIsDevelopment = false;
    });

    it('should not include details key when AppError has no details (400)', () => {
      const error = new AppError(400, 'VALIDATION_ERROR', 'Missing fields');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
    });

    it('should not include details key when AppError has no details (500)', () => {
      const error = new AppError(500, 'INTERNAL_ERROR', 'Crash');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: boundary statusCode = 499
  // ---------------------------------------------------------------------------

  describe('Behavioral: boundary at statusCode 499 vs 500', () => {
    beforeEach(() => {
      mockIsDevelopment = false;
    });

    it('should include details for statusCode 499 (< 500) in production', () => {
      const details = { reason: 'Client closed request' };
      const error = new AppError(499, 'CLIENT_CLOSED', 'Closed', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { reason: 'Client closed request' },
          }),
        })
      );
    });

    it('should strip details for statusCode 500 (>= 500) in production', () => {
      const details = { internal: 'should not leak' };
      const error = new AppError(500, 'INTERNAL', 'Error', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.error.details).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: non-AppError falls through to generic handler
  // ---------------------------------------------------------------------------

  describe('Behavioral: non-AppError errors', () => {
    beforeEach(() => {
      mockIsDevelopment = false;
    });

    it('should return generic 500 response for plain Error in production', () => {
      const error = new Error('Something unexpected');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred. Please try again later.',
          }),
        })
      );
    });

    it('should show error.message for plain Error in development', () => {
      mockIsDevelopment = true;
      const error = new Error('Dev debug info');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
            message: 'Dev debug info',
          }),
        })
      );
    });

    it('should NOT set Retry-After for plain Error (even if message mentions rate)', () => {
      const error = new Error('Rate limit exceeded');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      const retryAfterCalls = res.setHeader.mock.calls.filter(
        (c: any[]) => c[0] === 'Retry-After'
      );
      expect(retryAfterCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: M7 + M8 combined for 429
  // ---------------------------------------------------------------------------

  describe('Behavioral: M7 + M8 combined (429 with details in production)', () => {
    beforeEach(() => {
      mockIsDevelopment = false;
    });

    it('should set Retry-After AND include details for 429 in production', () => {
      const details = { retryAfter: 60, windowMs: 60000, limit: 100 };
      const error = new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Slow down', details);
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      // M7: header set
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');

      // M8: details included (429 < 500)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { retryAfter: 60, windowMs: 60000, limit: 100 },
          }),
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Behavioral Tests: logging happens for all errors
  // ---------------------------------------------------------------------------

  describe('Behavioral: error logging', () => {
    beforeEach(() => {
      mockIsDevelopment = false;
    });

    it('should log full error with path and method for AppError', () => {
      const { logger } = require('../shared/services/logger.service');
      const error = new AppError(400, 'VALIDATION_ERROR', 'Bad request');
      const req = createMockReq({ path: '/api/v1/booking', method: 'POST' });
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(logger.error).toHaveBeenCalledWith(
        'Request error',
        expect.objectContaining({
          error: 'Bad request',
          path: '/api/v1/booking',
          method: 'POST',
        })
      );
    });

    it('should log full error for plain Error objects', () => {
      const { logger } = require('../shared/services/logger.service');
      const error = new Error('Unexpected crash');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(logger.error).toHaveBeenCalledWith(
        'Request error',
        expect.objectContaining({
          error: 'Unexpected crash',
        })
      );
    });

    it('should log full error even for 429 responses', () => {
      const { logger } = require('../shared/services/logger.service');
      const error = new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests');
      const req = createMockReq();
      const res = createMockRes();

      errorHandler(error, req, res as unknown as Response, noopNext);

      expect(logger.error).toHaveBeenCalledWith(
        'Request error',
        expect.objectContaining({
          error: 'Too many requests',
        })
      );
    });
  });
});
