/**
 * =============================================================================
 * PHASE 4 — Auth & Middleware Fixes: Comprehensive Test Suite
 * =============================================================================
 *
 * Tests for 4 fixes:
 *   M1: Redis cooldown fail-open (auth.service.ts)
 *   M4: JTI blacklist catch logging (auth.middleware.ts)
 *   M3: CORS X-Device-Id + X-Idempotency-Key (server.ts)
 *   H1: In-TX duplicate 409 (order.service.ts)
 *
 * =============================================================================
 */

export {};

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helper: read a source file relative to __dirname
// ---------------------------------------------------------------------------
function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8');
}

// ==========================================================================
// M1: REDIS COOLDOWN FAIL-OPEN (auth.service.ts) — 9 tests
// ==========================================================================
describe('M1: Redis cooldown fail-open', () => {
  let source: string;

  beforeAll(() => {
    source = readSource('../modules/auth/auth.service.ts');
  });

  it('M1.1 should wrap cooldown check in try/catch', () => {
    // The sendOtp method should have a try/catch around the exists(cooldownKey) call
    const sendOtpIdx = source.indexOf('async sendOtp(');
    expect(sendOtpIdx).toBeGreaterThan(-1);
    const sendOtpBody = source.substring(sendOtpIdx, sendOtpIdx + 600);

    // Verify the try keyword appears before exists(cooldownKey)
    const tryIdx = sendOtpBody.indexOf('try {');
    const existsIdx = sendOtpBody.indexOf('exists(cooldownKey)');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(existsIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeLessThan(existsIdx);
  });

  it('M1.2 should have catch block around cooldown check', () => {
    const sendOtpIdx = source.indexOf('async sendOtp(');
    const sendOtpBody = source.substring(sendOtpIdx, sendOtpIdx + 600);

    // catch block should exist after the try block containing exists(cooldownKey)
    const existsIdx = sendOtpBody.indexOf('exists(cooldownKey)');
    const catchAfterExists = sendOtpBody.indexOf('catch', existsIdx);
    expect(catchAfterExists).toBeGreaterThan(-1);
  });

  it('M1.3 should log WARN on cooldown check failure', () => {
    expect(source).toContain('[OTP] Cooldown check failed-open');
  });

  it('M1.4 WARN log uses logger.warn (not logger.error)', () => {
    // The fail-open pattern should use logger.warn, not logger.error
    const failOpenIdx = source.indexOf('[OTP] Cooldown check failed-open');
    expect(failOpenIdx).toBeGreaterThan(-1);
    // Look backwards from the message to find logger.warn
    const contextBefore = source.substring(Math.max(0, failOpenIdx - 80), failOpenIdx);
    expect(contextBefore).toContain('logger.warn');
  });

  it('M1.5 should default cooldownActive to false', () => {
    expect(source).toContain('let cooldownActive = false');
  });

  it('M1.6 cooldownActive is set to false BEFORE the try block', () => {
    const sendOtpIdx = source.indexOf('async sendOtp(');
    const sendOtpBody = source.substring(sendOtpIdx, sendOtpIdx + 600);

    const defaultIdx = sendOtpBody.indexOf('let cooldownActive = false');
    const tryIdx = sendOtpBody.indexOf('try {');
    expect(defaultIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeLessThan(tryIdx);
  });

  it('M1.7 cooldownActive is assigned from redisService.exists inside try', () => {
    const sendOtpIdx = source.indexOf('async sendOtp(');
    const sendOtpBody = source.substring(sendOtpIdx, sendOtpIdx + 600);

    // Inside the try block: cooldownActive = await redisService.exists(cooldownKey)
    expect(sendOtpBody).toMatch(/cooldownActive\s*=\s*await\s+redisService\.exists\(cooldownKey\)/);
  });

  it('M1.8 if cooldownActive is true, throws 429 OTP_COOLDOWN', () => {
    expect(source).toMatch(/AppError\(429.*OTP_COOLDOWN/);
  });

  it('M1.9 fail-open comment explains rationale', () => {
    // There should be a comment near the catch explaining the fail-open strategy
    const catchIdx = source.indexOf('[OTP] Cooldown check failed-open');
    const contextBefore = source.substring(Math.max(0, catchIdx - 200), catchIdx);
    // Verify the comment mentions fail-open rationale
    expect(contextBefore.toLowerCase()).toContain('fail-open');
  });
});

// ==========================================================================
// M4: JTI BLACKLIST CATCH LOGGING (auth.middleware.ts) — 10 tests
// ==========================================================================
describe('M4: JTI blacklist catch logging', () => {
  let source: string;

  beforeAll(() => {
    source = readSource('../shared/middleware/auth.middleware.ts');
  });

  it('M4.1 authMiddleware has try/catch around JTI blacklist check', () => {
    const authMiddlewareIdx = source.indexOf('async function authMiddleware');
    expect(authMiddlewareIdx).toBeGreaterThan(-1);
    const authBody = source.substring(authMiddlewareIdx, authMiddlewareIdx + 2000);

    // Find the blacklist check
    const blacklistCheckIdx = authBody.indexOf('`blacklist:${decoded.jti}`');
    expect(blacklistCheckIdx).toBeGreaterThan(-1);

    // There should be a try block before the blacklist check
    const tryBeforeBlacklist = authBody.lastIndexOf('try {', blacklistCheckIdx);
    expect(tryBeforeBlacklist).toBeGreaterThan(-1);

    // And a catch block after
    const catchAfterBlacklist = authBody.indexOf('catch', blacklistCheckIdx);
    expect(catchAfterBlacklist).toBeGreaterThan(-1);
  });

  it('M4.2 catch block logs a WARN with logger.warn', () => {
    // In authMiddleware, the catch for JTI blacklist should use logger.warn
    // The catch block now includes AUTH_REDIS_FAIL_POLICY check before logger.warn,
    // so we need a larger window to capture the full block
    const authMiddlewareIdx = source.indexOf('async function authMiddleware');
    const authBody = source.substring(authMiddlewareIdx, authMiddlewareIdx + 2000);

    const blacklistIdx = authBody.indexOf('`blacklist:${decoded.jti}`');
    const catchIdx = authBody.indexOf('catch', blacklistIdx);
    // Catch block now has AUTH_REDIS_FAIL_POLICY 'closed' check (logger.error) before logger.warn
    const catchBody = authBody.substring(catchIdx, catchIdx + 800);
    expect(catchBody).toContain('logger.warn');
  });

  it('M4.3 WARN log message identifies JTI blacklist context', () => {
    expect(source).toContain('[Auth] JTI blacklist check failed-open');
  });

  it('M4.4 WARN log includes jti field', () => {
    const warnIdx = source.indexOf('[Auth] JTI blacklist check failed-open');
    expect(warnIdx).toBeGreaterThan(-1);
    const contextAfter = source.substring(warnIdx, warnIdx + 200);
    expect(contextAfter).toContain('jti:');
  });

  it('M4.5 WARN log includes userId field', () => {
    const warnIdx = source.indexOf('[Auth] JTI blacklist check failed-open');
    expect(warnIdx).toBeGreaterThan(-1);
    const contextAfter = source.substring(warnIdx, warnIdx + 200);
    expect(contextAfter).toContain('userId:');
  });

  it('M4.6 WARN log includes path field', () => {
    const warnIdx = source.indexOf('[Auth] JTI blacklist check failed-open');
    expect(warnIdx).toBeGreaterThan(-1);
    const contextAfter = source.substring(warnIdx, warnIdx + 200);
    expect(contextAfter).toContain('path:');
  });

  it('M4.7 JTI blacklist check uses redisService.exists', () => {
    const authMiddlewareIdx = source.indexOf('async function authMiddleware');
    const authBody = source.substring(authMiddlewareIdx, authMiddlewareIdx + 2000);
    expect(authBody).toContain('redisService.exists(`blacklist:${decoded.jti}`)');
  });

  it('M4.8 blacklisted JTI returns TOKEN_REVOKED error', () => {
    const authMiddlewareIdx = source.indexOf('async function authMiddleware');
    const authBody = source.substring(authMiddlewareIdx, authMiddlewareIdx + 2000);
    expect(authBody).toContain("'TOKEN_REVOKED'");
  });

  it('M4.9 JTI blacklist check is guarded by decoded.jti existence', () => {
    const authMiddlewareIdx = source.indexOf('async function authMiddleware');
    const authBody = source.substring(authMiddlewareIdx, authMiddlewareIdx + 2000);

    // Pattern: if (decoded.jti) { try { ... blacklist check ... } }
    const jtiGuardIdx = authBody.indexOf('if (decoded.jti)');
    const blacklistIdx = authBody.indexOf('`blacklist:${decoded.jti}`');
    expect(jtiGuardIdx).toBeGreaterThan(-1);
    expect(blacklistIdx).toBeGreaterThan(-1);
    expect(jtiGuardIdx).toBeLessThan(blacklistIdx);
  });

  it('M4.10 on Redis failure in authMiddleware, request proceeds (fail-open)', () => {
    // After the catch block in authMiddleware's JTI check, execution should continue.
    // The catch block now has a fail-policy check: if AUTH_REDIS_FAIL_POLICY === 'closed',
    // it returns 503; otherwise it logs a warn and continues (fail-open default).
    const authMiddlewareIdx = source.indexOf('async function authMiddleware');
    const authBody = source.substring(authMiddlewareIdx, authMiddlewareIdx + 2000);

    const blacklistIdx = authBody.indexOf('`blacklist:${decoded.jti}`');
    const catchIdx = authBody.indexOf('catch', blacklistIdx);
    // Get the catch block body with enough room for the full block
    // Catch block now has AUTH_REDIS_FAIL_POLICY 'closed' check (logger.error) before logger.warn
    const catchBody = authBody.substring(catchIdx, catchIdx + 800);
    // The catch block should contain logger.warn for the fail-open path
    expect(catchBody).toContain('logger.warn');
    // The catch block may contain 'return next(...)' for the closed policy path,
    // but the fail-open path continues without throwing
    expect(catchBody).not.toMatch(/\bthrow\s+new\b/);
  });
});

// ==========================================================================
// M3: CORS X-Device-Id + X-Idempotency-Key (server.ts) — 8 tests
// ==========================================================================
describe('M3: CORS X-Device-Id + X-Idempotency-Key headers', () => {
  let source: string;

  beforeAll(() => {
    source = readSource('../server.ts');
  });

  it('M3.1 allowedHeaders array includes X-Device-Id', () => {
    expect(source).toContain("'X-Device-Id'");
  });

  it('M3.2 allowedHeaders array includes X-Idempotency-Key', () => {
    expect(source).toContain("'X-Idempotency-Key'");
  });

  it('M3.3 CORS configuration uses allowedHeaders (not exposedHeaders)', () => {
    // Verify the headers are inside allowedHeaders block, not exposedHeaders
    const corsIdx = source.indexOf('app.use(cors(');
    expect(corsIdx).toBeGreaterThan(-1);
    const corsBlock = source.substring(corsIdx, corsIdx + 500);
    expect(corsBlock).toContain('allowedHeaders');
  });

  it('M3.4 allowedHeaders also includes standard Content-Type', () => {
    const corsIdx = source.indexOf('allowedHeaders');
    const headersBlock = source.substring(corsIdx, corsIdx + 300);
    expect(headersBlock).toContain("'Content-Type'");
  });

  it('M3.5 allowedHeaders also includes Authorization', () => {
    const corsIdx = source.indexOf('allowedHeaders');
    const headersBlock = source.substring(corsIdx, corsIdx + 300);
    expect(headersBlock).toContain("'Authorization'");
  });

  it('M3.6 allowedHeaders includes X-Request-ID for tracing', () => {
    const corsIdx = source.indexOf('allowedHeaders');
    const headersBlock = source.substring(corsIdx, corsIdx + 300);
    expect(headersBlock).toContain("'X-Request-ID'");
  });

  it('M3.7 CORS credentials is set to true', () => {
    const corsIdx = source.indexOf('app.use(cors(');
    const corsBlock = source.substring(corsIdx, corsIdx + 500);
    expect(corsBlock).toContain('credentials: true');
  });

  it('M3.8 CORS maxAge enables preflight caching', () => {
    const corsIdx = source.indexOf('app.use(cors(');
    const corsBlock = source.substring(corsIdx, corsIdx + 500);
    // maxAge should be set to a positive number (86400 = 24h)
    expect(corsBlock).toMatch(/maxAge:\s*\d+/);
  });
});

// ==========================================================================
// H1: IN-TX DUPLICATE 409 (order.service.ts) — 14 tests
// ==========================================================================
describe('H1: In-TX duplicate 409 ACTIVE_ORDER_EXISTS', () => {
  let source: string;

  beforeAll(() => {
    source = readSource('../modules/order/order.service.ts');
  });

  // --- Pre-TX guard ---
  it('H1.1 pre-TX Redis guard checks customer:active-broadcast key', () => {
    expect(source).toContain('`customer:active-broadcast:${request.customerId}`');
  });

  it('H1.2 pre-TX Redis guard throws 409 ACTIVE_ORDER_EXISTS', () => {
    const activeKeyIdx = source.indexOf('customer:active-broadcast:');
    const contextAfter = source.substring(activeKeyIdx, activeKeyIdx + 500);
    expect(contextAfter).toContain("AppError(409, 'ACTIVE_ORDER_EXISTS'");
  });

  it('H1.3 pre-TX DB authoritative check queries booking table', () => {
    // The pre-TX check should query prismaClient.booking.findFirst
    const commentIdx = source.indexOf('DB authoritative check');
    expect(commentIdx).toBeGreaterThan(-1);
    const blockAfter = source.substring(commentIdx, commentIdx + 400);
    expect(blockAfter).toContain('booking.findFirst');
  });

  it('H1.4 pre-TX DB authoritative check queries order table', () => {
    const commentIdx = source.indexOf('DB authoritative check');
    expect(commentIdx).toBeGreaterThan(-1);
    const blockAfter = source.substring(commentIdx, commentIdx + 400);
    expect(blockAfter).toContain('order.findFirst');
  });

  it('H1.5 pre-TX DB check filters active statuses for booking', () => {
    const commentIdx = source.indexOf('DB authoritative check');
    const blockAfter = source.substring(commentIdx, commentIdx + 400);
    expect(blockAfter).toContain('BookingStatus.created');
    expect(blockAfter).toContain('BookingStatus.broadcasting');
  });

  it('H1.6 pre-TX DB check filters active statuses for order', () => {
    const commentIdx = source.indexOf('DB authoritative check');
    const blockAfter = source.substring(commentIdx, commentIdx + 500);
    expect(blockAfter).toContain('OrderStatus.created');
    expect(blockAfter).toContain('OrderStatus.broadcasting');
  });

  // --- In-TX guard (the actual H1 fix) ---
  it('H1.7 in-TX duplicate check exists inside withDbTimeout transaction', () => {
    // The in-TX check should be inside a withDbTimeout call
    const withDbTimeoutIdx = source.indexOf('withDbTimeout(async (tx)');
    expect(withDbTimeoutIdx).toBeGreaterThan(-1);
    const txBody = source.substring(withDbTimeoutIdx, withDbTimeoutIdx + 600);
    expect(txBody).toContain('dupBooking');
    expect(txBody).toContain('dupOrder');
  });

  it('H1.8 in-TX check queries tx.booking.findFirst (not prismaClient)', () => {
    const withDbTimeoutIdx = source.indexOf('withDbTimeout(async (tx)');
    const txBody = source.substring(withDbTimeoutIdx, withDbTimeoutIdx + 600);
    expect(txBody).toContain('tx.booking.findFirst');
  });

  it('H1.9 in-TX check queries tx.order.findFirst (not prismaClient)', () => {
    const withDbTimeoutIdx = source.indexOf('withDbTimeout(async (tx)');
    const txBody = source.substring(withDbTimeoutIdx, withDbTimeoutIdx + 600);
    expect(txBody).toContain('tx.order.findFirst');
  });

  it('H1.10 in-TX duplicate check throws 409 ACTIVE_ORDER_EXISTS', () => {
    const withDbTimeoutIdx = source.indexOf('withDbTimeout(async (tx)');
    const txBody = source.substring(withDbTimeoutIdx, withDbTimeoutIdx + 600);
    expect(txBody).toContain("AppError(409, 'ACTIVE_ORDER_EXISTS'");
  });

  it('H1.11 in-TX duplicate check message differs from pre-TX (indicates in-progress)', () => {
    // The in-TX message should say "Request already in progress" to differentiate
    const withDbTimeoutIdx = source.indexOf('withDbTimeout(async (tx)');
    const txBody = source.substring(withDbTimeoutIdx, withDbTimeoutIdx + 1000);
    // Match the in-TX AppError that uses ACTIVE_ORDER_EXISTS
    const errorLine = txBody.match(/AppError\(409,\s*'ACTIVE_ORDER_EXISTS',\s*'([^']+)'\)/);
    expect(errorLine).toBeTruthy();
    expect(errorLine![1]).toContain('already in progress');
  });

  it('H1.12 in-TX check uses same status filters as pre-TX check', () => {
    const withDbTimeoutIdx = source.indexOf('withDbTimeout(async (tx)');
    const txBody = source.substring(withDbTimeoutIdx, withDbTimeoutIdx + 600);
    // Should check OrderStatus.created, broadcasting, active, partially_filled
    expect(txBody).toContain('OrderStatus.created');
    expect(txBody).toContain('OrderStatus.broadcasting');
    expect(txBody).toContain('OrderStatus.active');
    expect(txBody).toContain('OrderStatus.partially_filled');
  });

  it('H1.13 in-TX check happens BEFORE order.create (prevents race condition)', () => {
    const withDbTimeoutIdx = source.indexOf('withDbTimeout(async (tx)');
    const txBody = source.substring(withDbTimeoutIdx, withDbTimeoutIdx + 800);
    const dupCheckIdx = txBody.indexOf('dupBooking || dupOrder');
    const createIdx = txBody.indexOf('tx.order.create');
    expect(dupCheckIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(dupCheckIdx).toBeLessThan(createIdx);
  });

  it('H1.14 transaction uses withDbTimeout for statement_timeout enforcement', () => {
    // The transaction wrapper should be withDbTimeout (not raw prismaClient.$transaction)
    // ensuring pool exhaustion protection
    const txCallIdx = source.indexOf('withDbTimeout(async (tx)');
    expect(txCallIdx).toBeGreaterThan(-1);

    // Verify it is at the order creation flow level by checking the comment block above
    const contextBefore = source.substring(Math.max(0, txCallIdx - 400), txCallIdx);
    // The block should contain the comment about statement_timeout enforcement
    expect(contextBefore).toContain('statement_timeout');
  });
});

// ==========================================================================
// CROSS-FIX CONSISTENCY CHECKS — 6 tests
// ==========================================================================
describe('Cross-fix consistency checks', () => {
  it('XFIX.1 auth.middleware.ts imports redisService', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');
    expect(source).toMatch(/import.*redisService.*from/);
  });

  it('XFIX.2 auth.middleware.ts imports logger', () => {
    const source = readSource('../shared/middleware/auth.middleware.ts');
    expect(source).toMatch(/import.*logger.*from/);
  });

  it('XFIX.3 auth.service.ts imports redisService', () => {
    const source = readSource('../modules/auth/auth.service.ts');
    expect(source).toMatch(/import.*redisService.*from/);
  });

  it('XFIX.4 auth.service.ts imports logger', () => {
    const source = readSource('../modules/auth/auth.service.ts');
    expect(source).toMatch(/import.*logger.*from/);
  });

  it('XFIX.5 order.service.ts imports AppError', () => {
    const source = readSource('../modules/order/order.service.ts');
    expect(source).toMatch(/import.*AppError.*from/);
  });

  it('XFIX.6 order.service.ts imports withDbTimeout from prisma.service', () => {
    const source = readSource('../modules/order/order.service.ts');
    expect(source).toContain('withDbTimeout');
    expect(source).toMatch(/import.*withDbTimeout.*from/);
  });
});
