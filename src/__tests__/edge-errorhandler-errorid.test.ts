/**
 * =============================================================================
 * F-A-19 — errorHandler attaches errorId UUID to every error response
 * =============================================================================
 *
 * Both AppError (operational) and unknown error (5xx) responses MUST carry an
 * `error.errorId` field whose value matches the UUID v1-5 fingerprint regex.
 * The errorId is also recorded in the server-side log so SREs can grep across
 * customer reports and CloudWatch in O(1).
 *
 * No feature flag — observability is additive and never user-visible-broken.
 * =============================================================================
 */

import { errorHandler } from '../shared/middleware/error.middleware';
import { AppError } from '../shared/types/error.types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeRes(): { status: jest.Mock; setHeader: jest.Mock; json: jest.Mock; body?: any; statusCode?: number } {
  const res: any = {};
  res.statusCode = undefined;
  res.body = undefined;
  res.setHeader = jest.fn();
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res;
}

function makeReq(overrides: Partial<{ path: string; method: string; ip: string; headers: Record<string, string>; userId: string }> = {}): any {
  return {
    path: overrides.path ?? '/api/v1/orders',
    method: overrides.method ?? 'POST',
    ip: overrides.ip ?? '127.0.0.1',
    headers: overrides.headers ?? {},
    userId: overrides.userId ?? 'user-1'
  };
}

describe('F-A-19 — errorHandler errorId fingerprint', () => {
  it('attaches errorId UUID on AppError (4xx) response body', () => {
    const res = makeRes();
    const err = new AppError(409, 'CONFLICT', 'duplicate');
    errorHandler(err, makeReq(), res as any, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body?.error?.errorId).toMatch(UUID_REGEX);
  });

  it('attaches errorId UUID on AppError (5xx) response body', () => {
    const res = makeRes();
    const err = new AppError(503, 'UPSTREAM_DOWN', 'redis offline');
    errorHandler(err, makeReq(), res as any, jest.fn());
    expect(res.statusCode).toBe(503);
    expect(res.body?.error?.errorId).toMatch(UUID_REGEX);
  });

  it('attaches errorId UUID on unknown Error (500) response body', () => {
    const res = makeRes();
    errorHandler(new Error('boom'), makeReq(), res as any, jest.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body?.error?.errorId).toMatch(UUID_REGEX);
  });

  it('errorId is unique per invocation', () => {
    const r1 = makeRes();
    const r2 = makeRes();
    errorHandler(new Error('a'), makeReq(), r1 as any, jest.fn());
    errorHandler(new Error('b'), makeReq(), r2 as any, jest.fn());
    expect(r1.body.error.errorId).not.toBe(r2.body.error.errorId);
  });
});
