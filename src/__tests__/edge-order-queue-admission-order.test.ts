/**
 * =============================================================================
 * F-A-07 — Edge chain reorder: auth → roleGuard → Zod → rate-limit → queue-slot
 * =============================================================================
 *
 * Today the POST /api/v1/orders chain is:
 *   authMiddleware → roleGuard → bookingQueue.middleware(timeout:15s) → handler
 * with Zod validation and rate-limit running INSIDE the handler, AFTER the
 * queue slot has been consumed. A flood of malformed requests therefore
 * permanently saturates `bookingQueue.activeCount` (max 50) for ~15 seconds
 * each, even though every one will reject in the validation step. Real
 * bookings get queued behind garbage.
 *
 * The fix:
 *   authMiddleware → roleGuard → validateCreateOrderBody → orderRateLimitMiddleware → bookingQueue.middleware → handler
 * so that admission is gated by cheap, deterministic checks first.
 *
 * Gated by FF_ORDER_QUEUE_POST_VALIDATION (release, default OFF) so legacy
 * order is preserved during rollout.
 * =============================================================================
 */

import { isEnabled, FLAGS } from '../shared/config/feature-flags';

describe('F-A-07 — ORDER_QUEUE_POST_VALIDATION flag wiring', () => {
  it('FLAGS.ORDER_QUEUE_POST_VALIDATION is registered as a release flag', () => {
    expect((FLAGS as any).ORDER_QUEUE_POST_VALIDATION).toBeDefined();
    expect((FLAGS as any).ORDER_QUEUE_POST_VALIDATION.env).toBe('FF_ORDER_QUEUE_POST_VALIDATION');
    expect((FLAGS as any).ORDER_QUEUE_POST_VALIDATION.category).toBe('release');
  });

  it('ORDER_QUEUE_POST_VALIDATION defaults OFF when env unset', () => {
    const original = process.env.FF_ORDER_QUEUE_POST_VALIDATION;
    delete process.env.FF_ORDER_QUEUE_POST_VALIDATION;
    try {
      expect(isEnabled((FLAGS as any).ORDER_QUEUE_POST_VALIDATION)).toBe(false);
    } finally {
      if (original !== undefined) process.env.FF_ORDER_QUEUE_POST_VALIDATION = original;
    }
  });
});

describe('F-A-07 — order.routes.ts wires named middlewares in admission order', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '../modules/order/order.routes.ts'),
    'utf8'
  );

  it('exposes a validateCreateOrderBody middleware (extracted from inline Zod)', () => {
    expect(source).toMatch(/validateCreateOrderBody/);
  });

  it('exposes an orderRateLimitMiddleware (extracted from inline checkRateLimit)', () => {
    expect(source).toMatch(/orderRateLimitMiddleware/);
  });

  it('references FF_ORDER_QUEUE_POST_VALIDATION for the chain selector', () => {
    expect(source).toMatch(/FF_ORDER_QUEUE_POST_VALIDATION|ORDER_QUEUE_POST_VALIDATION/);
  });
});

describe('F-A-07 — admission order on POST / route', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '../modules/order/order.routes.ts'),
    'utf8'
  );

  it("post-validation chain places validate+rate-limit BEFORE bookingQueue.middleware", () => {
    // Find the POST '/' route block and assert middleware order in the new path.
    const postBlock = source.match(/router\.post\(\s*['"]\/['"][^]*?\)\s*;/);
    expect(postBlock).not.toBeNull();
    const block = postBlock![0];
    const idxAuth = block.indexOf('authMiddleware');
    const idxRole = block.indexOf("roleGuard(['customer'])");
    const idxValidate = block.indexOf('validateCreateOrderBody');
    const idxRate = block.indexOf('orderRateLimitMiddleware');
    const idxQueue = block.indexOf('bookingQueue.middleware');
    expect(idxAuth).toBeGreaterThanOrEqual(0);
    expect(idxRole).toBeGreaterThan(idxAuth);
    expect(idxValidate).toBeGreaterThan(idxRole);
    expect(idxRate).toBeGreaterThan(idxValidate);
    expect(idxQueue).toBeGreaterThan(idxRate);
  });
});
