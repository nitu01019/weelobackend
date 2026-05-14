/**
 * =============================================================================
 * PHASE 5 — FIX #7: Retry-After 503 on backpressure (BackpressureError)
 * =============================================================================
 *
 * Coverage:
 *   - 429 path (transporter-rate-limit L114 block-active): Retry-After matches
 *     body details.retryAfter
 *   - 503 BackpressureError: Retry-After:5 + generic public message + depth/cap
 *     NEVER in body (CWE-209) + logger.error received internalMeta
 *   - 503 transporter-rate-limit Redis-down (L160): Retry-After:30 + envelope
 *     preserved per FF_503_ENVELOPE_NORMALIZE=false default
 *   - Geocoding permanent-misconfig (L238): 503 + NO Retry-After (RFC 7231 §6.6.4)
 *   - ErrorCode collision: SYS_9013 unique in core/constants
 *   - Queue-depth-cap integration: enqueue past FF_QUEUE_DEPTH_CAP → 503 +
 *     Retry-After:5 + code SYS_9013 + BACKPRESSURE symbolic mapping
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// MOCKS — Must come before middleware imports
// =============================================================================

const loggerErrorSpy = jest.fn();
const loggerWarnSpy = jest.fn();
const loggerInfoSpy = jest.fn();
const loggerDebugSpy = jest.fn();

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: loggerInfoSpy,
    warn: loggerWarnSpy,
    error: loggerErrorSpy,
    debug: loggerDebugSpy,
  },
}));

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
import { AppError, BackpressureError, ErrorCode } from '../shared/types/error.types';
import { ErrorCode as NumericErrorCode, HTTP_STATUS } from '../core/constants';
import { Request, Response, NextFunction } from 'express';

// =============================================================================
// HELPERS
// =============================================================================

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  set: jest.Mock;
  headersSent: boolean;
  _setHeaderCalls: Array<[string, string]>;
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
  const calls: Array<[string, string]> = [];
  const res: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn((name: string, value: string) => {
      calls.push([name, String(value)]);
      return res;
    }) as unknown as jest.Mock,
    set: jest.fn().mockReturnThis(),
    headersSent: false,
    _setHeaderCalls: calls,
  };
  return res;
}

function findHeader(res: MockResponse, name: string): string | undefined {
  const lower = name.toLowerCase();
  const match = res._setHeaderCalls.find(([h]) => h.toLowerCase() === lower);
  return match ? match[1] : undefined;
}

const noopNext: NextFunction = jest.fn();

// =============================================================================
// TEST 1: ErrorCode collision — SYS_9013 uniqueness
// =============================================================================

describe('Fix #7: SYS_9013 uniqueness in core/constants', () => {
  it('grep "SYS_9013" returns exactly 1 hit in core/constants', () => {
    const constantsPath = path.resolve(__dirname, '../core/constants/index.ts');
    const src = fs.readFileSync(constantsPath, 'utf-8');
    const matches = src.match(/'SYS_9013'/g) || [];
    expect(matches.length).toBe(1);
  });

  it('NumericErrorCode.BACKPRESSURE resolves to SYS_9013', () => {
    expect(NumericErrorCode.BACKPRESSURE).toBe('SYS_9013');
  });

  it('string-enum ErrorCode.BACKPRESSURE resolves to BACKPRESSURE', () => {
    expect(ErrorCode.BACKPRESSURE).toBe('BACKPRESSURE');
  });
});

// =============================================================================
// TEST 2: BackpressureError class — CWE-209 + Error.cause
// =============================================================================

describe('Fix #7: BackpressureError construction', () => {
  it('public message is generic — no internal data interpolation', () => {
    const err = new BackpressureError(
      'queue_depth_cap_exceeded',
      { retryAfter: 5 },
      { depth: 9999, cap: 5000 }
    );
    expect(err.message).toBe('Service temporarily unavailable. Please retry shortly.');
    expect(err.message).not.toContain('9999');
    expect(err.message).not.toContain('5000');
  });

  it('exposes statusCode=503 + code=SYS_9013 + details.retryAfter', () => {
    const err = new BackpressureError('reason', { retryAfter: 5 }, {});
    expect(err.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('SYS_9013');
    expect(err.details).toEqual({ retryAfter: 5 });
  });

  it('default retryAfter is 5 when omitted', () => {
    const err = new BackpressureError('reason');
    expect(err.details?.retryAfter).toBe(5);
  });

  it('internalReason + internalMeta stored on instance only', () => {
    const err = new BackpressureError(
      'queue_depth_cap_exceeded',
      { retryAfter: 5 },
      { depth: 9999, cap: 5000 }
    );
    expect(err.internalReason).toBe('queue_depth_cap_exceeded');
    expect(err.internalMeta).toEqual({ depth: 9999, cap: 5000 });
  });

  it('ES2022 Error.cause assigned when options.cause provided', () => {
    const root = new Error('root');
    const err = new BackpressureError('reason', { retryAfter: 5 }, {}, { cause: root });
    expect((err as Error & { cause?: unknown }).cause).toBe(root);
  });

  it('instanceof AppError chain holds', () => {
    const err = new BackpressureError('reason');
    expect(err).toBeInstanceOf(BackpressureError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

// =============================================================================
// TEST 3: errorHandler — 503 BackpressureError emits Retry-After + CWE-209 safe
// =============================================================================

describe('Fix #7: errorHandler — BackpressureError 503 path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevelopment = false; // production mode (strip 5xx details)
  });

  it('emits Retry-After header matching internal retryAfter seconds (5)', () => {
    const err = new BackpressureError(
      'queue_depth_cap_exceeded',
      { retryAfter: 5 },
      { depth: 9999, cap: 5000 }
    );
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);
    expect(findHeader(res, 'Retry-After')).toBe('5');
  });

  it('public body uses generic message — never contains depth/cap (CWE-209)', () => {
    const err = new BackpressureError(
      'queue_depth_cap_exceeded',
      { retryAfter: 5 },
      { depth: 9999, cap: 5000 }
    );
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);

    const jsonArg = res.json.mock.calls[0][0];
    const serialized = JSON.stringify(jsonArg);
    expect(serialized.indexOf('9999')).toBe(-1);
    expect(serialized.indexOf('5000')).toBe(-1);
    expect(serialized.indexOf('queue_depth_cap_exceeded')).toBe(-1);
    expect(jsonArg.error.message).toBe('Service temporarily unavailable. Please retry shortly.');
    expect(jsonArg.error.code).toBe('SYS_9013');
  });

  it('response body details are stripped for 5xx in production', () => {
    const err = new BackpressureError(
      'queue_depth_cap_exceeded',
      { retryAfter: 5 },
      { depth: 9999, cap: 5000 }
    );
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);

    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.error.details).toBeUndefined();
  });

  it('logger.error received internalReason + internalMeta (server-side log only)', () => {
    const err = new BackpressureError(
      'queue_depth_cap_exceeded',
      { retryAfter: 5 },
      { depth: 9999, cap: 5000 }
    );
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);

    expect(loggerErrorSpy).toHaveBeenCalled();
    const logArg = loggerErrorSpy.mock.calls[0][1];
    expect(logArg).toMatchObject({
      internalReason: 'queue_depth_cap_exceeded',
      internalMeta: { depth: 9999, cap: 5000 },
    });
  });

  it('status code is 503', () => {
    const err = new BackpressureError('reason');
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

// =============================================================================
// TEST 4: errorHandler — Retry-After integer coercion (RFC 7231 §7.1.3)
// =============================================================================

describe('Fix #7: errorHandler — Retry-After integer coercion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevelopment = false;
  });

  it('floors float retryAfter to integer (5.7 → 5)', () => {
    const err = new AppError(503, 'TEST', 'public', { retryAfter: 5.7 });
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);
    expect(findHeader(res, 'Retry-After')).toBe('5');
  });

  it('clamps negative retryAfter to 0', () => {
    const err = new AppError(429, 'TEST', 'public', { retryAfter: -10 });
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);
    expect(findHeader(res, 'Retry-After')).toBe('0');
  });

  it('defaults to 30 when retryAfter is undefined', () => {
    const err = new AppError(429, 'TEST', 'public');
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);
    expect(findHeader(res, 'Retry-After')).toBe('30');
  });

  it('does NOT set Retry-After on non-429/503 statuses (e.g., 404)', () => {
    const err = new AppError(404, 'NOT_FOUND', 'public');
    const req = createMockReq();
    const res = createMockRes();
    errorHandler(err, req, res as unknown as Response, noopNext);
    expect(findHeader(res, 'Retry-After')).toBeUndefined();
  });
});

// =============================================================================
// TEST 5: Source-scan — transporter-rate-limit.middleware.ts wire patches
// =============================================================================

describe('Fix #7: transporter-rate-limit.middleware.ts source patterns', () => {
  const tplPath = path.resolve(
    __dirname,
    '../shared/middleware/transporter-rate-limit.middleware.ts'
  );
  const src = fs.readFileSync(tplPath, 'utf-8');

  it('429 block-active path sets Retry-After header before res.status(429)', () => {
    // res.setHeader('Retry-After', String(ttl)) must appear before the 429 emit
    expect(src).toMatch(/res\.setHeader\(\s*['"]Retry-After['"]\s*,\s*String\(ttl\)\s*\)/);
  });

  it('429 limit-exceeded path sets Retry-After with limit.blockDuration', () => {
    expect(src).toMatch(/res\.setHeader\(\s*['"]Retry-After['"]\s*,\s*String\(limit\.blockDuration\)/);
  });

  it('429 envelopes nest error with { code, message, details }', () => {
    expect(src).toMatch(/code:\s*['"]RATE_LIMIT_EXCEEDED['"]/);
    expect(src).toMatch(/details:\s*\{\s*retryAfter:/);
  });

  it('503 Redis-down path sets Retry-After: 30 unconditionally', () => {
    expect(src).toMatch(/res\.setHeader\(\s*['"]Retry-After['"]\s*,\s*['"]30['"]\s*\)/);
  });

  it('503 envelope normalization is gated behind FF_503_ENVELOPE_NORMALIZE', () => {
    expect(src).toMatch(/FF_503_ENVELOPE_NORMALIZE\s*===\s*['"]true['"]/);
  });

  it('default OFF preserves HEAD flat-string envelope { error: "Rate limiting unavailable" }', () => {
    // The default-OFF branch should still emit the legacy flat string envelope
    expect(src).toMatch(/error:\s*['"]Rate limiting unavailable['"]/);
  });
});

// =============================================================================
// TEST 6: Source-scan — geocoding.routes.ts permanent-misconfig (RFC 7231 §6.6.4)
// =============================================================================

describe('Fix #7: geocoding.routes.ts permanent-misconfig — NO Retry-After', () => {
  const geocodingPath = path.resolve(
    __dirname,
    '../modules/routing/geocoding.routes.ts'
  );
  const src = fs.readFileSync(geocodingPath, 'utf-8');

  it('comment explicitly states Retry-After is intentionally omitted', () => {
    // Doc-driven assertion — comment must explain WHY (RFC 7231 §6.6.4)
    expect(src).toMatch(/INTENTIONALLY OMIT Retry-After/i);
  });

  it('references RFC 7231 §6.6.4 in comment', () => {
    expect(src).toMatch(/RFC 7231/);
    expect(src).toMatch(/6\.6\.4/);
  });

  it('does NOT emit res.setHeader("Retry-After"...) anywhere in this file', () => {
    expect(src).not.toMatch(/res\.setHeader\(\s*['"]Retry-After['"]/);
  });

  it('envelope normalization gated behind FF_503_ENVELOPE_NORMALIZE', () => {
    expect(src).toMatch(/FF_503_ENVELOPE_NORMALIZE\s*===\s*['"]true['"]/);
  });

  it('default OFF preserves HEAD flat sibling-fields envelope', () => {
    expect(src).toMatch(/error:\s*['"]SERVICE_UNAVAILABLE['"]/);
    expect(src).toMatch(/'Geocoding service not configured\. Add GOOGLE_MAPS_API_KEY\.'/);
  });
});

// =============================================================================
// TEST 7: Source-scan — queue.service.ts emits BackpressureError (not naked Error)
// =============================================================================

describe('Fix #7: queue.service.ts emits BackpressureError on cap exceeded', () => {
  const queuePath = path.resolve(__dirname, '../shared/services/queue.service.ts');
  const src = fs.readFileSync(queuePath, 'utf-8');

  it('imports BackpressureError from error.types', () => {
    expect(src).toMatch(/import\s*\{\s*BackpressureError\s*\}\s*from\s*['"]\.\.\/types\/error\.types['"]/);
  });

  it('throws BackpressureError when broadcast queue depth >= FF_QUEUE_DEPTH_CAP', () => {
    expect(src).toMatch(/throw\s+new\s+BackpressureError\(\s*['"]queue_depth_cap_exceeded['"]/);
  });

  it('passes retryAfter: 5 in details', () => {
    expect(src).toMatch(/\{\s*retryAfter:\s*5\s*\}/);
  });

  it('passes depth + cap in internalMeta (4th arg)', () => {
    expect(src).toMatch(/depth:\s*this\.broadcastDepthSnapshot\.depth/);
    expect(src).toMatch(/cap:\s*FF_QUEUE_DEPTH_CAP/);
  });

  it('public message no longer interpolates depth/cap (naked Error gone)', () => {
    // The old naked-Error pattern `Broadcast queue depth ${...} exceeds cap ${...}`
    // must be replaced. Verify no `throw new Error(...exceeds cap...)` remains.
    expect(src).not.toMatch(/throw\s+new\s+Error\(\s*`Broadcast queue depth/);
  });
});

// =============================================================================
// TEST 8: Source-scan — error.middleware.ts helper + Set-of-statuses pattern
// =============================================================================

describe('Fix #7: error.middleware.ts — RETRY_AFTER_STATUSES + setRetryAfterIfApplicable', () => {
  const middlewarePath = path.resolve(
    __dirname,
    '../shared/middleware/error.middleware.ts'
  );
  const src = fs.readFileSync(middlewarePath, 'utf-8');

  it('declares RETRY_AFTER_STATUSES set with 429 + 503', () => {
    expect(src).toMatch(/RETRY_AFTER_STATUSES\s*=\s*new\s+Set<number>\(\[\s*429\s*,\s*503\s*\]\)/);
  });

  it('declares setRetryAfterIfApplicable helper', () => {
    expect(src).toMatch(/function\s+setRetryAfterIfApplicable\s*\(/);
  });

  it('uses Math.floor for RFC 7231 §7.1.3 integer coercion', () => {
    expect(src).toMatch(/Math\.floor/);
  });

  it('uses Math.max(0, ...) for non-negative clamp', () => {
    expect(src).toMatch(/Math\.max\(\s*0/);
  });

  it('imports BackpressureError', () => {
    expect(src).toMatch(/import\s*\{[^}]*BackpressureError[^}]*\}\s*from\s*['"]\.\.\/types\/error\.types['"]/);
  });

  it('logs internalReason + internalMeta when error is a BackpressureError', () => {
    expect(src).toMatch(/internalReason/);
    expect(src).toMatch(/internalMeta/);
  });
});

// =============================================================================
// TEST 9: 18-emitter audit — every 503 producer has { retryAfter } 4th-arg
// =============================================================================

describe('Fix #7: 18-emitter audit — AppError(503) sites carry { retryAfter }', () => {
  const sites: Array<{ file: string; phrase: RegExp; ra: number }> = [
    {
      file: 'src/modules/order/order-creation.service.ts',
      phrase: /AppError\(503,\s*'SYSTEM_BUSY',\s*'System is processing too many orders[^']*',\s*\{\s*retryAfter:\s*5\s*\}\)/,
      ra: 5,
    },
    {
      file: 'src/modules/order/order.service.ts',
      phrase: /AppError\(503,\s*'SYSTEM_BUSY',\s*'System is processing too many orders[^']*',\s*\{\s*retryAfter:\s*5\s*\}\)/,
      ra: 5,
    },
    {
      file: 'src/shared/middleware/auth.middleware.ts',
      phrase: /AppError\(503,\s*'SERVICE_UNAVAILABLE',\s*'Authentication service temporarily unavailable',\s*\{\s*retryAfter:\s*10\s*\}\)/,
      ra: 10,
    },
    {
      file: 'src/shared/database/prisma.service.ts',
      phrase: /'DB_TIMEOUT',[\s\S]*?retryAfter:\s*5/,
      ra: 5,
    },
    {
      file: 'src/shared/services/s3-upload.service.ts',
      phrase: /'S3_NOT_CONFIGURED',[\s\S]*?retryAfter:\s*5/,
      ra: 5,
    },
    {
      file: 'src/modules/booking/booking-create.service.ts',
      phrase: /AppError\(503,\s*'SYSTEM_BUSY',\s*'Too many bookings being processed\.',\s*\{\s*retryAfter:\s*5\s*\}\)/,
      ra: 5,
    },
    {
      file: 'src/modules/auth/sms.service.ts',
      phrase: /AppError\(503,\s*'SMS_DELIVERY_FAILED',\s*'Unable to send SMS[^']*',\s*\{\s*retryAfter:\s*10\s*\}\)/,
      ra: 10,
    },
    {
      file: 'src/modules/auth/auth.service.ts',
      phrase: /AppError\(503,\s*'SERVICE_UNAVAILABLE',\s*'OTP service temporarily unavailable[^']*',\s*\{\s*retryAfter:\s*10\s*\}\)/,
      ra: 10,
    },
    {
      file: 'src/modules/auth/auth.service.ts',
      phrase: /AppError\(503,\s*'DB_UNAVAILABLE',\s*'Unable to create user account[^']*',\s*\{\s*retryAfter:\s*5\s*\}\)/,
      ra: 5,
    },
    {
      file: 'src/modules/driver-auth/driver-auth.service.ts',
      phrase: /AppError\(503,\s*'SERVICE_UNAVAILABLE',\s*'OTP service temporarily unavailable[^']*',\s*\{\s*retryAfter:\s*10\s*\}\)/,
      ra: 10,
    },
    {
      file: 'src/modules/driver-auth/driver-auth.service.ts',
      phrase: /AppError\(503,\s*'SMS_SEND_FAILED',\s*'Could not deliver OTP[^']*',\s*\{\s*retryAfter:\s*10\s*\}\)/,
      ra: 10,
    },
  ];

  for (const site of sites) {
    it(`${site.file} — AppError(503,...) carries retryAfter:${site.ra}`, () => {
      const full = path.resolve(__dirname, '../..', site.file);
      const src = fs.readFileSync(full, 'utf-8');
      expect(src).toMatch(site.phrase);
    });
  }
});

// =============================================================================
// TEST 10: transporter.routes.ts — toggle 429 + heartbeat-sync 503 Retry-After
// =============================================================================

describe('Fix #7: transporter.routes.ts — Retry-After on 429 + 503', () => {
  const routesPath = path.resolve(
    __dirname,
    '../modules/transporter/transporter.routes.ts'
  );
  const src = fs.readFileSync(routesPath, 'utf-8');

  it('toggle-cooldown 429 sets Retry-After via Math.ceil(retryAfterMs / 1000)', () => {
    expect(src).toMatch(/res\.setHeader\(\s*['"]Retry-After['"]\s*,\s*String\(\s*Math\.ceil\(\s*retryAfterMs\s*\/\s*1000\s*\)\s*\)/);
  });

  it('heartbeat-sync 503 sets Retry-After:5 inline', () => {
    expect(src).toMatch(/res\.setHeader\(\s*['"]Retry-After['"]\s*,\s*['"]5['"]\s*\);\s*\n\s*res\.status\(503\)/);
  });
});

// =============================================================================
// TEST 11: BackpressureError → errorHandler integration (queue-depth-cap)
// =============================================================================

describe('Fix #7: BackpressureError → errorHandler integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevelopment = false;
  });

  it('full path: queue-depth-cap exceeded → 503 + Retry-After:5 + code SYS_9013 + BACKPRESSURE symbolic', () => {
    // Simulate queue.service.ts throw site: BackpressureError with depth+cap in internalMeta
    const err = new BackpressureError(
      'queue_depth_cap_exceeded',
      { retryAfter: 5 },
      { depth: 12000, cap: 10000 }
    );
    const req = createMockReq({ path: '/api/v1/broadcast' });
    const res = createMockRes();

    errorHandler(err, req, res as unknown as Response, noopNext);

    // Status
    expect(res.status).toHaveBeenCalledWith(503);
    // Retry-After header (integer seconds per RFC 7231 §7.1.3)
    expect(findHeader(res, 'Retry-After')).toBe('5');

    // Body: code is numeric SYS_9013, message is generic, no leakage
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.success).toBe(false);
    expect(jsonArg.error.code).toBe(NumericErrorCode.BACKPRESSURE);
    expect(jsonArg.error.code).toBe('SYS_9013');
    expect(jsonArg.error.message).toBe('Service temporarily unavailable. Please retry shortly.');

    // CWE-209: depth + cap NEVER in body
    const wire = JSON.stringify(jsonArg);
    expect(wire.indexOf('12000')).toBe(-1);
    expect(wire.indexOf('10000')).toBe(-1);
    expect(wire.indexOf('queue_depth_cap_exceeded')).toBe(-1);

    // Server-side log carries internal context
    const logCall = loggerErrorSpy.mock.calls[0][1];
    expect(logCall.internalReason).toBe('queue_depth_cap_exceeded');
    expect(logCall.internalMeta).toEqual({ depth: 12000, cap: 10000 });
  });

  it('symbolic ErrorCode.BACKPRESSURE maps to numeric SYS_9013', () => {
    // Cross-check: string-enum BACKPRESSURE pairs with numeric SYS_9013
    expect(ErrorCode.BACKPRESSURE).toBe('BACKPRESSURE');
    expect(NumericErrorCode.BACKPRESSURE).toBe('SYS_9013');
    // The class uses the numeric code in the wire body
    const err = new BackpressureError('reason');
    expect(err.code).toBe(NumericErrorCode.BACKPRESSURE);
  });
});
