/**
 * =============================================================================
 * F-A-10 — Auth middleware / suspension service KEY PARITY tests
 * =============================================================================
 *
 * Issue:
 *   Before this fix, `auth.middleware.ts` inlined Redis reads against the key
 *   literal `customer:suspended:{userId}`, while `adminSuspensionService`
 *   wrote suspensions to `suspension:{userId}`. Two literals, two key spaces,
 *   ZERO intersection — so every admin-created suspension silently failed to
 *   block driver / transporter / admin / (even customer) requests.
 *
 * Contract asserted here:
 *   1. Writing via `adminSuspensionService.suspendUser(userId, ...)` AND
 *      reading via the middleware hit THE SAME Redis key — namely the one
 *      produced by the canonical `suspensionKey(userId)` helper.
 *   2. When a user is suspended, `authMiddleware` responds with 403
 *      `ACCOUNT_SUSPENDED` regardless of role (customer / driver /
 *      transporter / admin).
 *   3. When no suspension exists, the middleware calls `next()` with no
 *      error.
 *   4. `optionalAuthMiddleware` treats a suspended user as unauthenticated
 *      (no req.user attached) but does not throw.
 *
 * The orphan `suspension-check.middleware.ts` file has been deleted by the
 * same commit — a guard here would be redundant.
 * =============================================================================
 */

export {};

// ---------------------------------------------------------------------------
// Mocks — MUST come before importing the code under test
// ---------------------------------------------------------------------------

jest.mock('../shared/services/logger.service', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/monitoring/metrics.service', () => ({
  metrics: {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
    observeHistogram: jest.fn(),
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    jwt: { secret: 'test-suspension-parity-secret', expiresIn: '1h' },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// ---------------------------------------------------------------------------
// In-memory Redis mock — shared between service write and middleware read
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

const redisMock = {
  get: jest.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, _ttlSec?: number): Promise<void> => {
    store.set(key, value);
  }),
  del: jest.fn(async (key: string): Promise<void> => {
    store.delete(key);
  }),
  exists: jest.fn(async (key: string): Promise<boolean> => store.has(key)),
  lPush: jest.fn(async (_key: string, _value: string): Promise<void> => {
    /* noop — not exercised in parity assertions */
  }),
  lTrim: jest.fn(async (_key: string, _start: number, _stop: number): Promise<void> => {
    /* noop */
  }),
  lRange: jest.fn(async (_key: string, _start: number, _stop: number): Promise<string[]> => []),
  eval: jest.fn(async (_script: string, keys: string[], _args: string[]): Promise<number[]> =>
    keys.map((k) => (store.has(k) ? 1 : 0))),
};

jest.mock('../shared/services/redis.service', () => ({
  redisService: redisMock,
}));

// prismaClient — only user.findUnique is exercised for the name cache branch;
// middleware proceeds even if it returns null.
jest.mock('../shared/database/prisma.service', () => ({
  prismaClient: {
    user: {
      findUnique: jest.fn(async () => null),
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/environment';
import { authMiddleware, optionalAuthMiddleware } from '../shared/middleware/auth.middleware';
import {
  adminSuspensionService,
  suspensionKey,
} from '../modules/admin/admin-suspension.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(userId: string, role: string): string {
  return jwt.sign({ userId, role, phone: '+911234567890' }, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
}

function makeReq(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    path: '/__test__',
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

function makeNextCapture(): {
  next: NextFunction;
  get: () => unknown[];
} {
  const calls: unknown[] = [];
  const next = ((err?: unknown): void => {
    calls.push(err);
  }) as unknown as NextFunction;
  return {
    next,
    get: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F-A-10 suspension key parity (middleware <-> service)', () => {
  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Helper contract
  // -------------------------------------------------------------------------

  describe('suspensionKey helper', () => {
    it('produces the canonical `suspension:{userId}` key shape', () => {
      expect(suspensionKey('user-123')).toBe('suspension:user-123');
    });

    it('does NOT use the legacy `customer:suspended:` prefix', () => {
      expect(suspensionKey('user-abc').startsWith('customer:suspended:')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Service write + middleware read share the same key
  // -------------------------------------------------------------------------

  it('suspendUser writes the canonical key that the middleware reads', async () => {
    const userId = 'parity-user-1';
    await adminSuspensionService.suspendUser(userId, 'test', 1, 'admin-1');

    expect(store.has(suspensionKey(userId))).toBe(true);
    // Legacy key MUST NOT be populated
    expect(store.has(`customer:suspended:${userId}`)).toBe(false);

    // Service-level check must succeed
    expect(await adminSuspensionService.isUserSuspended(userId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. All four roles get blocked when suspended
  // -------------------------------------------------------------------------

  const roles = ['customer', 'driver', 'transporter', 'admin'] as const;

  roles.forEach((role) => {
    it(`authMiddleware returns 403 ACCOUNT_SUSPENDED for a suspended ${role}`, async () => {
      const userId = `${role}-susp-uuid`;
      await adminSuspensionService.suspendUser(userId, 'policy', 1, 'admin-x');

      const token = makeToken(userId, role);
      const req = makeReq(token);
      const res = makeRes();
      const capture = makeNextCapture();

      await authMiddleware(req, res, capture.next);

      const calls = capture.get();
      expect(calls).toHaveLength(1);
      const err = calls[0];
      expect(err).toBeDefined();
      // Match AppError shape without tight-coupling to constructor
      const maybe = err as { statusCode?: number; code?: string; message?: string };
      expect(maybe.statusCode).toBe(403);
      expect(maybe.code).toBe('ACCOUNT_SUSPENDED');
    });

    it(`authMiddleware allows a non-suspended ${role} through`, async () => {
      const userId = `${role}-ok-uuid`;
      // NO suspension written
      const token = makeToken(userId, role);
      const req = makeReq(token);
      const res = makeRes();
      const capture = makeNextCapture();

      await authMiddleware(req, res, capture.next);

      const calls = capture.get();
      expect(calls).toHaveLength(1);
      // next() called with no argument = success
      expect(calls[0]).toBeUndefined();
      expect(req.user?.userId).toBe(userId);
      expect(req.user?.role).toBe(role);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Regression guard — legacy key DOES NOT trigger the block
  // -------------------------------------------------------------------------

  it('writing only the legacy `customer:suspended:{id}` key DOES NOT block (proves the new read is canonical)', async () => {
    const userId = 'legacy-only-uuid';
    // Simulate a stale legacy key — the bug we just fixed would have been
    // blocking on THIS key and ignoring the canonical one. Now the
    // canonical helper is the only path, so this stale key must be inert.
    store.set(`customer:suspended:${userId}`, '1');

    const token = makeToken(userId, 'driver');
    const req = makeReq(token);
    const res = makeRes();
    const capture = makeNextCapture();

    await authMiddleware(req, res, capture.next);

    expect(capture.get()[0]).toBeUndefined();
    expect(req.user?.userId).toBe(userId);
  });

  // -------------------------------------------------------------------------
  // 5. optionalAuthMiddleware: suspended = unauthenticated (no throw)
  // -------------------------------------------------------------------------

  it('optionalAuthMiddleware treats suspended user as unauthenticated and does NOT throw', async () => {
    const userId = 'optional-susp-uuid';
    await adminSuspensionService.suspendUser(userId, 'policy', 1, 'admin-x');

    const token = makeToken(userId, 'customer');
    const req = makeReq(token);
    const res = makeRes();
    const capture = makeNextCapture();

    await optionalAuthMiddleware(req, res, capture.next);

    expect(capture.get()).toHaveLength(1);
    expect(capture.get()[0]).toBeUndefined(); // no error
    expect(req.user).toBeUndefined(); // unauthenticated
  });

  it('optionalAuthMiddleware attaches req.user when user is NOT suspended', async () => {
    const userId = 'optional-ok-uuid';
    const token = makeToken(userId, 'customer');
    const req = makeReq(token);
    const res = makeRes();
    const capture = makeNextCapture();

    await optionalAuthMiddleware(req, res, capture.next);

    expect(capture.get()[0]).toBeUndefined();
    expect(req.user?.userId).toBe(userId);
  });

  // -------------------------------------------------------------------------
  // 6. Unsuspend removes the canonical key and unblocks
  // -------------------------------------------------------------------------

  it('unsuspendUser removes the canonical key and the middleware allows the user through again', async () => {
    const userId = 'unsuspend-uuid';
    await adminSuspensionService.suspendUser(userId, 'reason', 1, 'admin-1');
    await adminSuspensionService.unsuspendUser(userId, 'admin-1', 'done');

    expect(store.has(suspensionKey(userId))).toBe(false);

    const token = makeToken(userId, 'transporter');
    const req = makeReq(token);
    const res = makeRes();
    const capture = makeNextCapture();

    await authMiddleware(req, res, capture.next);

    expect(capture.get()[0]).toBeUndefined();
    expect(req.user?.userId).toBe(userId);
  });
});
