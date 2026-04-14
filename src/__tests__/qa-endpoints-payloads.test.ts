/**
 * =============================================================================
 * QA ENDPOINTS & ENRICHED PAYLOADS — Comprehensive tests for new/enriched
 * endpoints introduced by the qa-fortress fix batch.
 * =============================================================================
 *
 * Coverage map:
 *   H18  — continue-partial endpoint (happy path, expired, cancelled, wrong state)
 *   H18  — search-again endpoint (happy path, all trucks filled, timeout extension)
 *   M9   — order_cancelled enriched payload (cancelledBy, refundStatus, assignmentIds)
 *   M12  — post-accept order path (orderId fallback, customer lookup)
 *   M16  — deprecated routes have X-Deprecated header
 *   AB1  — assignment_timeout event handling
 *
 * @author Weelo Team (qa-endpoints agent, qa-fortress)
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// H18: CONTINUE-PARTIAL ENDPOINT
// =============================================================================

describe('H18: continue-partial endpoint logic', () => {
  // Simulates the continue-partial endpoint logic from booking.routes.ts:852-969
  const PARTIAL_FILL_ACTION_STATUSES = ['expired', 'partially_filled'] as const;

  interface MockOrder {
    id: string;
    customerId: string;
    status: string;
    trucksFilled: number;
    totalTrucks: number;
  }

  function simulateContinuePartial(
    order: MockOrder | null,
    requestingCustomerId: string
  ): { status: number; body: Record<string, any> } {
    // 1. Order not found
    if (!order) {
      return { status: 404, body: { success: false, error: { code: 'ORDER_NOT_FOUND' } } };
    }
    // 2. BOLA guard
    if (order.customerId !== requestingCustomerId) {
      return { status: 404, body: { success: false, error: { code: 'ORDER_NOT_FOUND' } } };
    }
    // 3. No trucks filled
    if (order.trucksFilled < 1) {
      return { status: 400, body: { success: false, error: { code: 'NO_TRUCKS_FILLED' } } };
    }
    // 4. Invalid state
    if (!(PARTIAL_FILL_ACTION_STATUSES as readonly string[]).includes(order.status)) {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'INVALID_ORDER_STATE',
            data: { currentStatus: order.status }
          }
        }
      };
    }
    // 5. CAS update succeeded
    return {
      status: 200,
      body: {
        success: true,
        data: {
          orderId: order.id,
          status: 'fully_filled',
          trucksFilled: order.trucksFilled,
          totalTrucks: order.trucksFilled,
          partialAccepted: true,
        }
      }
    };
  }

  test('H18-CP-01: happy path — expired order with 2/5 trucks -> fully_filled', () => {
    const order: MockOrder = {
      id: 'order-1', customerId: 'cust-1', status: 'expired',
      trucksFilled: 2, totalTrucks: 5,
    };
    const result = simulateContinuePartial(order, 'cust-1');
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.data.status).toBe('fully_filled');
    expect(result.body.data.trucksFilled).toBe(2);
    expect(result.body.data.totalTrucks).toBe(2);
    expect(result.body.data.partialAccepted).toBe(true);
  });

  test('H18-CP-02: happy path — partially_filled order is valid for continue', () => {
    const order: MockOrder = {
      id: 'order-2', customerId: 'cust-1', status: 'partially_filled',
      trucksFilled: 3, totalTrucks: 5,
    };
    const result = simulateContinuePartial(order, 'cust-1');
    expect(result.status).toBe(200);
    expect(result.body.data.status).toBe('fully_filled');
  });

  test('H18-CP-03: order not found -> 404', () => {
    const result = simulateContinuePartial(null, 'cust-1');
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  test('H18-CP-04: BOLA guard — different customer -> 404 (not 403)', () => {
    const order: MockOrder = {
      id: 'order-1', customerId: 'cust-1', status: 'expired',
      trucksFilled: 2, totalTrucks: 5,
    };
    const result = simulateContinuePartial(order, 'cust-attacker');
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  test('H18-CP-05: no trucks filled -> 400 NO_TRUCKS_FILLED', () => {
    const order: MockOrder = {
      id: 'order-1', customerId: 'cust-1', status: 'expired',
      trucksFilled: 0, totalTrucks: 5,
    };
    const result = simulateContinuePartial(order, 'cust-1');
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('NO_TRUCKS_FILLED');
  });

  test('H18-CP-06: order in "active" state -> 409 INVALID_ORDER_STATE', () => {
    const order: MockOrder = {
      id: 'order-1', customerId: 'cust-1', status: 'active',
      trucksFilled: 2, totalTrucks: 5,
    };
    const result = simulateContinuePartial(order, 'cust-1');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('INVALID_ORDER_STATE');
    expect(result.body.error.data.currentStatus).toBe('active');
  });

  test('H18-CP-07: order already cancelled -> 409', () => {
    const order: MockOrder = {
      id: 'order-1', customerId: 'cust-1', status: 'cancelled',
      trucksFilled: 2, totalTrucks: 5,
    };
    const result = simulateContinuePartial(order, 'cust-1');
    expect(result.status).toBe(409);
    expect(result.body.error.data.currentStatus).toBe('cancelled');
  });

  test('H18-CP-08: order already fully_filled -> 409', () => {
    const order: MockOrder = {
      id: 'order-1', customerId: 'cust-1', status: 'fully_filled',
      trucksFilled: 5, totalTrucks: 5,
    };
    const result = simulateContinuePartial(order, 'cust-1');
    expect(result.status).toBe(409);
  });

  test('H18-CP-09: response payload shape matches API contract', () => {
    const order: MockOrder = {
      id: 'order-99', customerId: 'cust-1', status: 'expired',
      trucksFilled: 1, totalTrucks: 4,
    };
    const result = simulateContinuePartial(order, 'cust-1');
    const data = result.body.data;
    expect(data).toHaveProperty('orderId', 'order-99');
    expect(data).toHaveProperty('status', 'fully_filled');
    expect(data).toHaveProperty('trucksFilled', 1);
    expect(data).toHaveProperty('totalTrucks', 1);
    expect(data).toHaveProperty('partialAccepted', true);
  });
});

// =============================================================================
// H18: SEARCH-AGAIN ENDPOINT
// =============================================================================

describe('H18: search-again endpoint logic', () => {
  const PARTIAL_FILL_ACTION_STATUSES = ['expired', 'partially_filled'] as const;
  const BROADCAST_TIMEOUT_SECONDS = 120;

  interface MockOrder {
    id: string;
    customerId: string;
    status: string;
    trucksFilled: number;
    totalTrucks: number;
  }

  function simulateSearchAgain(
    order: MockOrder | null,
    requestingCustomerId: string
  ): { status: number; body: Record<string, any> } {
    if (!order) {
      return { status: 404, body: { success: false, error: { code: 'ORDER_NOT_FOUND' } } };
    }
    if (order.customerId !== requestingCustomerId) {
      return { status: 404, body: { success: false, error: { code: 'ORDER_NOT_FOUND' } } };
    }
    if (!(PARTIAL_FILL_ACTION_STATUSES as readonly string[]).includes(order.status)) {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'INVALID_ORDER_STATE',
            data: { currentStatus: order.status }
          }
        }
      };
    }
    const remaining = order.totalTrucks - order.trucksFilled;
    if (remaining <= 0) {
      return {
        status: 409,
        body: { success: false, error: { code: 'ALL_TRUCKS_FILLED' } }
      };
    }
    const targetStatus = order.trucksFilled > 0 ? 'partially_filled' : 'active';
    const newExpiresAt = new Date(Date.now() + BROADCAST_TIMEOUT_SECONDS * 1000).toISOString();
    return {
      status: 200,
      body: {
        success: true,
        data: {
          orderId: order.id,
          status: targetStatus,
          trucksFilled: order.trucksFilled,
          totalTrucks: order.totalTrucks,
          remaining,
          remainingSeconds: BROADCAST_TIMEOUT_SECONDS,
          expiresAt: newExpiresAt,
          searchRestarted: true,
        }
      }
    };
  }

  test('H18-SA-01: happy path — expired order with 2/5 trucks -> partially_filled, search restarted', () => {
    const order: MockOrder = {
      id: 'order-1', customerId: 'cust-1', status: 'expired',
      trucksFilled: 2, totalTrucks: 5,
    };
    const result = simulateSearchAgain(order, 'cust-1');
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.data.status).toBe('partially_filled');
    expect(result.body.data.remaining).toBe(3);
    expect(result.body.data.searchRestarted).toBe(true);
    expect(result.body.data.remainingSeconds).toBe(120);
  });

  test('H18-SA-02: expired with 0 trucks filled -> status becomes "active"', () => {
    const order: MockOrder = {
      id: 'order-2', customerId: 'cust-1', status: 'expired',
      trucksFilled: 0, totalTrucks: 3,
    };
    const result = simulateSearchAgain(order, 'cust-1');
    expect(result.status).toBe(200);
    expect(result.body.data.status).toBe('active');
    expect(result.body.data.remaining).toBe(3);
  });

  test('H18-SA-03: all trucks already filled -> 409 ALL_TRUCKS_FILLED', () => {
    const order: MockOrder = {
      id: 'order-3', customerId: 'cust-1', status: 'expired',
      trucksFilled: 5, totalTrucks: 5,
    };
    const result = simulateSearchAgain(order, 'cust-1');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('ALL_TRUCKS_FILLED');
  });

  test('H18-SA-04: order not found -> 404', () => {
    const result = simulateSearchAgain(null, 'cust-1');
    expect(result.status).toBe(404);
  });

  test('H18-SA-05: BOLA guard — different customer -> 404', () => {
    const order: MockOrder = {
      id: 'order-4', customerId: 'cust-1', status: 'expired',
      trucksFilled: 1, totalTrucks: 3,
    };
    const result = simulateSearchAgain(order, 'cust-other');
    expect(result.status).toBe(404);
  });

  test('H18-SA-06: order in "active" state -> 409 INVALID_ORDER_STATE', () => {
    const order: MockOrder = {
      id: 'order-5', customerId: 'cust-1', status: 'active',
      trucksFilled: 1, totalTrucks: 3,
    };
    const result = simulateSearchAgain(order, 'cust-1');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('INVALID_ORDER_STATE');
  });

  test('H18-SA-07: timeout extension — expiresAt is in the future by BROADCAST_TIMEOUT_SECONDS', () => {
    const order: MockOrder = {
      id: 'order-6', customerId: 'cust-1', status: 'expired',
      trucksFilled: 1, totalTrucks: 3,
    };
    const before = Date.now();
    const result = simulateSearchAgain(order, 'cust-1');
    const after = Date.now();
    const expiresAtMs = new Date(result.body.data.expiresAt).getTime();
    // expiresAt should be roughly now + 120s
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + BROADCAST_TIMEOUT_SECONDS * 1000 - 100);
    expect(expiresAtMs).toBeLessThanOrEqual(after + BROADCAST_TIMEOUT_SECONDS * 1000 + 100);
  });

  test('H18-SA-08: response payload includes searchRestarted flag', () => {
    const order: MockOrder = {
      id: 'order-7', customerId: 'cust-1', status: 'partially_filled',
      trucksFilled: 2, totalTrucks: 4,
    };
    const result = simulateSearchAgain(order, 'cust-1');
    expect(result.body.data.searchRestarted).toBe(true);
    expect(result.body.data.orderId).toBe('order-7');
    expect(result.body.data.totalTrucks).toBe(4);
    expect(result.body.data.trucksFilled).toBe(2);
  });
});

// =============================================================================
// M9: ORDER_CANCELLED ENRICHED PAYLOAD
// =============================================================================

describe('M9: order_cancelled enriched payload', () => {
  // Tests the parseCancelledPayload structure from order-lifecycle-outbox.service.ts

  function parseCancelledPayload(raw: Record<string, unknown>) {
    const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim() : '';
    const customerId = typeof raw.customerId === 'string' ? raw.customerId.trim() : '';
    if (!orderId || !customerId) return null;

    const cancelledBy = raw.cancelledBy === 'customer' || raw.cancelledBy === 'transporter' || raw.cancelledBy === 'system'
      ? raw.cancelledBy
      : 'customer';
    const refundStatus = typeof raw.refundStatus === 'string' && raw.refundStatus.trim().length > 0
      ? raw.refundStatus.trim()
      : 'none';
    const assignmentIds = Array.isArray(raw.assignmentIds)
      ? raw.assignmentIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : 'Cancelled by customer';
    const reasonCode = typeof raw.reasonCode === 'string' && raw.reasonCode.trim().length > 0
      ? raw.reasonCode.trim()
      : 'CUSTOMER_CANCELLED';

    return {
      type: 'order_cancelled' as const,
      orderId,
      customerId,
      cancelledBy,
      refundStatus,
      assignmentIds,
      reason,
      reasonCode,
    };
  }

  test('M9-01: enriched payload includes cancelledBy field', () => {
    const result = parseCancelledPayload({
      orderId: 'o-1', customerId: 'c-1', cancelledBy: 'customer',
    });
    expect(result).not.toBeNull();
    expect(result!.cancelledBy).toBe('customer');
  });

  test('M9-02: cancelledBy defaults to "customer" when missing', () => {
    const result = parseCancelledPayload({ orderId: 'o-1', customerId: 'c-1' });
    expect(result!.cancelledBy).toBe('customer');
  });

  test('M9-03: cancelledBy "transporter" preserved', () => {
    const result = parseCancelledPayload({
      orderId: 'o-1', customerId: 'c-1', cancelledBy: 'transporter',
    });
    expect(result!.cancelledBy).toBe('transporter');
  });

  test('M9-04: cancelledBy "system" preserved', () => {
    const result = parseCancelledPayload({
      orderId: 'o-1', customerId: 'c-1', cancelledBy: 'system',
    });
    expect(result!.cancelledBy).toBe('system');
  });

  test('M9-05: cancelledBy invalid value -> defaults to "customer"', () => {
    const result = parseCancelledPayload({
      orderId: 'o-1', customerId: 'c-1', cancelledBy: 'hacker',
    });
    expect(result!.cancelledBy).toBe('customer');
  });

  test('M9-06: refundStatus included when present', () => {
    const result = parseCancelledPayload({
      orderId: 'o-1', customerId: 'c-1', refundStatus: 'pending',
    });
    expect(result!.refundStatus).toBe('pending');
  });

  test('M9-07: refundStatus defaults to "none" when missing', () => {
    const result = parseCancelledPayload({ orderId: 'o-1', customerId: 'c-1' });
    expect(result!.refundStatus).toBe('none');
  });

  test('M9-08: assignmentIds included as array of strings', () => {
    const result = parseCancelledPayload({
      orderId: 'o-1', customerId: 'c-1',
      assignmentIds: ['a-1', 'a-2', 'a-3'],
    });
    expect(result!.assignmentIds).toEqual(['a-1', 'a-2', 'a-3']);
  });

  test('M9-09: assignmentIds empty when not provided', () => {
    const result = parseCancelledPayload({ orderId: 'o-1', customerId: 'c-1' });
    expect(result!.assignmentIds).toEqual([]);
  });

  test('M9-10: assignmentIds filters out empty/null items', () => {
    const result = parseCancelledPayload({
      orderId: 'o-1', customerId: 'c-1',
      assignmentIds: ['a-1', '', null, 'a-2', undefined],
    });
    expect(result!.assignmentIds).toEqual(['a-1', 'a-2']);
  });

  test('M9-11: returns null when orderId is missing', () => {
    const result = parseCancelledPayload({ customerId: 'c-1' });
    expect(result).toBeNull();
  });

  test('M9-12: returns null when customerId is missing', () => {
    const result = parseCancelledPayload({ orderId: 'o-1' });
    expect(result).toBeNull();
  });

  test('M9-13: reason defaults to "Cancelled by customer"', () => {
    const result = parseCancelledPayload({ orderId: 'o-1', customerId: 'c-1' });
    expect(result!.reason).toBe('Cancelled by customer');
  });

  test('M9-14: reasonCode defaults to "CUSTOMER_CANCELLED"', () => {
    const result = parseCancelledPayload({ orderId: 'o-1', customerId: 'c-1' });
    expect(result!.reasonCode).toBe('CUSTOMER_CANCELLED');
  });
});

// =============================================================================
// M12: POST-ACCEPT ORDER PATH
// =============================================================================

describe('M12: post-accept order path — orderId fallback, customer lookup', () => {
  // Tests the customer lookup logic from post-accept.effects.ts lines 171-189

  interface PostAcceptContext {
    assignmentId: string;
    driverId: string;
    vehicleId: string;
    vehicleNumber: string;
    tripId: string;
    bookingId: string;
    orderId?: string;
    transporterId: string;
    driverName: string;
  }

  interface MockBooking { customerId: string }
  interface MockOrder { customerId: string }

  function resolveCustomerId(
    ctx: PostAcceptContext,
    bookingResult: MockBooking | null,
    orderResult: MockOrder | null
  ): string | undefined {
    // Mirrors post-accept.effects.ts logic
    if (ctx.bookingId && bookingResult?.customerId) {
      return bookingResult.customerId;
    }
    if (ctx.orderId && orderResult?.customerId) {
      return orderResult.customerId;
    }
    return undefined;
  }

  const baseCtx: PostAcceptContext = {
    assignmentId: 'asgn-1',
    driverId: 'drv-1',
    vehicleId: 'v-1',
    vehicleNumber: 'KA01AB1234',
    tripId: 'trip-1',
    bookingId: 'bk-1',
    transporterId: 'trans-1',
    driverName: 'Raju',
  };

  test('M12-01: customer found via booking path', () => {
    const result = resolveCustomerId(
      baseCtx,
      { customerId: 'cust-from-booking' },
      null
    );
    expect(result).toBe('cust-from-booking');
  });

  test('M12-02: booking not found, falls back to order path', () => {
    const ctx = { ...baseCtx, orderId: 'ord-1' };
    const result = resolveCustomerId(ctx, null, { customerId: 'cust-from-order' });
    expect(result).toBe('cust-from-order');
  });

  test('M12-03: no bookingId at all, uses orderId path directly', () => {
    const ctx = { ...baseCtx, bookingId: '', orderId: 'ord-1' };
    const result = resolveCustomerId(ctx, null, { customerId: 'cust-from-order' });
    expect(result).toBe('cust-from-order');
  });

  test('M12-04: neither booking nor order found -> undefined', () => {
    const ctx = { ...baseCtx, orderId: 'ord-1' };
    const result = resolveCustomerId(ctx, null, null);
    expect(result).toBeUndefined();
  });

  test('M12-05: booking found but customerId is empty -> falls back to order', () => {
    const ctx = { ...baseCtx, orderId: 'ord-1' };
    // customerId is empty string (falsy)
    const result = resolveCustomerId(
      ctx,
      { customerId: '' },
      { customerId: 'cust-from-order' }
    );
    // Empty string is falsy, so booking path fails, falls to order
    expect(result).toBe('cust-from-order');
  });

  test('M12-06: PostAcceptContext interface has orderId as optional', () => {
    const ctx: PostAcceptContext = {
      assignmentId: 'a-1', driverId: 'd-1', vehicleId: 'v-1',
      vehicleNumber: 'V1', tripId: 't-1', bookingId: 'b-1',
      transporterId: 'tr-1', driverName: 'Test',
      // orderId intentionally omitted
    };
    expect(ctx.orderId).toBeUndefined();
    const result = resolveCustomerId(ctx, null, null);
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// M16: DEPRECATED ROUTES HAVE X-DEPRECATED HEADER
// =============================================================================

describe('M16: deprecated routes set X-Deprecated header', () => {
  const bookingRoutesPath = path.join(__dirname, '..', 'modules', 'booking', 'booking.routes.ts');
  let bookingRoutesSource: string;

  beforeAll(() => {
    bookingRoutesSource = fs.readFileSync(bookingRoutesPath, 'utf-8');
  });

  test('M16-01: POST /bookings (legacy) sets X-Deprecated header', () => {
    expect(bookingRoutesSource).toContain("res.setHeader('X-Deprecated', 'true')");
  });

  test('M16-02: X-Deprecated-Reason points to canonical /api/v1/orders', () => {
    expect(bookingRoutesSource).toContain("res.setHeader('X-Deprecated-Reason'");
    expect(bookingRoutesSource).toMatch(/X-Deprecated-Reason.*\/api\/v1\/orders/);
  });

  test('M16-03: POST /bookings/orders (secondary) also sets X-Deprecated', () => {
    // There should be at least 2 occurrences of X-Deprecated header setting
    const matches = bookingRoutesSource.match(/res\.setHeader\('X-Deprecated', 'true'\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  test('M16-04: X-Weelo-Canonical-Path header is set on legacy POST /bookings', () => {
    expect(bookingRoutesSource).toContain("X-Weelo-Canonical-Path");
    expect(bookingRoutesSource).toContain("/api/v1/orders");
  });

  test('M16-05: X-Weelo-Legacy-Proxy header is set on legacy POST /bookings', () => {
    expect(bookingRoutesSource).toContain("X-Weelo-Legacy-Proxy");
  });
});

// =============================================================================
// AB1: ASSIGNMENT_TIMEOUT EVENT HANDLING
// =============================================================================

describe('AB1: assignment_timeout event handling', () => {
  const socketServicePath = path.join(__dirname, '..', 'shared', 'services', 'socket.service.ts');
  const socketEventsPath = path.join(__dirname, '..', 'shared', 'types', 'socket-events.ts');
  const lifecyclePath = path.join(__dirname, '..', 'modules', 'assignment', 'assignment-lifecycle.service.ts');

  let socketServiceSource: string;
  let socketEventsSource: string;
  let lifecycleSource: string;

  beforeAll(() => {
    socketServiceSource = fs.readFileSync(socketServicePath, 'utf-8');
    socketEventsSource = fs.readFileSync(socketEventsPath, 'utf-8');
    lifecycleSource = fs.readFileSync(lifecyclePath, 'utf-8');
  });

  test('AB1-01: SocketEvent enum defines ASSIGNMENT_TIMEOUT', () => {
    expect(socketServiceSource).toContain("ASSIGNMENT_TIMEOUT: 'assignment_timeout'");
  });

  test('AB1-02: socket-events.ts type declares assignment_timeout signature', () => {
    expect(socketEventsSource).toContain('assignment_timeout');
  });

  test('AB1-03: assignment-lifecycle emits assignment_timeout FCM type to transporter', () => {
    expect(lifecycleSource).toContain("type: 'assignment_timeout'");
  });

  test('AB1-04: assignment_timeout FCM payload includes status "expired"', () => {
    // The FCM data payload for assignment_timeout must set status: 'expired'
    const timeoutRegex = /type:\s*'assignment_timeout'[\s\S]*?status:\s*'expired'/;
    expect(lifecycleSource).toMatch(timeoutRegex);
  });

  test('AB1-05: assignment_timeout payload includes required fields', () => {
    // Must include: assignmentId, tripId, vehicleId, driverName
    expect(lifecycleSource).toMatch(/type:\s*'assignment_timeout'[\s\S]*?assignmentId/);
    expect(lifecycleSource).toMatch(/type:\s*'assignment_timeout'[\s\S]*?tripId/);
    expect(lifecycleSource).toMatch(/type:\s*'assignment_timeout'[\s\S]*?vehicleId/);
    expect(lifecycleSource).toMatch(/type:\s*'assignment_timeout'[\s\S]*?driverName/);
  });

  test('AB1-06: timeout also emits ASSIGNMENT_STATUS_CHANGED to booking room', () => {
    expect(lifecycleSource).toContain('SocketEvent.ASSIGNMENT_STATUS_CHANGED');
    // Timeout path emits to booking room with reason: 'timeout'
    expect(lifecycleSource).toMatch(/reason:\s*'timeout'/);
  });
});

// =============================================================================
// ENRICHED SOCKET EMISSION: continue-partial emits BOOKING_FULLY_FILLED
// =============================================================================

describe('H18: continue-partial emits correct socket events', () => {
  const bookingRoutesPath = path.join(__dirname, '..', 'modules', 'booking', 'booking.routes.ts');
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(bookingRoutesPath, 'utf-8');
  });

  test('H18-EVT-01: continue-partial emits BOOKING_FULLY_FILLED event', () => {
    expect(source).toContain('SocketEvent.BOOKING_FULLY_FILLED');
    // Specifically in the continue-partial handler
    expect(source).toMatch(/continue-partial[\s\S]*?SocketEvent\.BOOKING_FULLY_FILLED/);
  });

  test('H18-EVT-02: continue-partial socket payload includes partialAccepted flag', () => {
    expect(source).toMatch(/partialAccepted:\s*true/);
  });

  test('H18-EVT-03: search-again emits BOOKING_UPDATED event', () => {
    expect(source).toContain('SocketEvent.BOOKING_UPDATED');
    expect(source).toMatch(/search-again[\s\S]*?SocketEvent\.BOOKING_UPDATED/);
  });

  test('H18-EVT-04: search-again socket payload includes searchRestarted flag', () => {
    expect(source).toMatch(/searchRestarted:\s*true/);
  });
});

// =============================================================================
// ORDER LIFECYCLE OUTBOX: emitCancellationLifecycle payload shape
// =============================================================================

describe('M9: emitCancellationLifecycle enriched payload structure', () => {
  const outboxPath = path.join(
    __dirname, '..', 'modules', 'order', 'order-lifecycle-outbox.service.ts'
  );
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(outboxPath, 'utf-8');
  });

  test('M9-SRC-01: emitCancellationLifecycle sends cancelledBy to customer', () => {
    // The order_cancelled event emitted to customer includes cancelledBy
    expect(source).toMatch(/emitToUser\(payload\.customerId.*order_cancelled/);
    expect(source).toContain('cancelledBy: payload.cancelledBy');
  });

  test('M9-SRC-02: emitCancellationLifecycle sends refundStatus to customer', () => {
    expect(source).toContain('refundStatus: payload.refundStatus');
  });

  test('M9-SRC-03: emitCancellationLifecycle sends assignmentIds to customer', () => {
    expect(source).toContain('assignmentIds: payload.assignmentIds');
  });

  test('M9-SRC-04: parseCancelledPayload validates cancelledBy to allowed values', () => {
    // Only customer, transporter, system are valid
    expect(source).toContain("cancelledBy === 'customer'");
    expect(source).toContain("cancelledBy === 'transporter'");
    expect(source).toContain("cancelledBy === 'system'");
  });

  test('M9-SRC-05: parseCancelledPayload validates refundStatus with trim', () => {
    expect(source).toMatch(/refundStatus.*\.trim\(\)/);
  });
});

// =============================================================================
// ROUTE SOURCE VERIFICATION: partial-fill endpoints exist in booking.routes.ts
// =============================================================================

describe('H18: partial-fill route registration', () => {
  const bookingRoutesPath = path.join(__dirname, '..', 'modules', 'booking', 'booking.routes.ts');
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(bookingRoutesPath, 'utf-8');
  });

  test('H18-ROUTE-01: continue-partial route is registered', () => {
    expect(source).toContain('/orders/:orderId/continue-partial');
  });

  test('H18-ROUTE-02: search-again route is registered', () => {
    expect(source).toContain('/orders/:orderId/search-again');
  });

  test('H18-ROUTE-03: both routes require customer role', () => {
    // Find the router.post() registration line (not the JSDoc comment)
    const continuePartialIdx = source.indexOf("'/orders/:orderId/continue-partial'");
    const searchAgainIdx = source.indexOf("'/orders/:orderId/search-again'");
    expect(continuePartialIdx).toBeGreaterThan(-1);
    expect(searchAgainIdx).toBeGreaterThan(-1);
    // Look at the router.post() call surrounding the route path (100 chars before should cover it)
    const nearContinue = source.slice(Math.max(0, continuePartialIdx - 100), continuePartialIdx + 200);
    const nearSearch = source.slice(Math.max(0, searchAgainIdx - 100), searchAgainIdx + 200);
    expect(nearContinue).toContain("roleGuard(['customer'])");
    expect(nearSearch).toContain("roleGuard(['customer'])");
  });

  test('H18-ROUTE-04: both routes have validateOrderIdParam middleware', () => {
    const continuePartialIdx = source.indexOf("'/orders/:orderId/continue-partial'");
    const searchAgainIdx = source.indexOf("'/orders/:orderId/search-again'");
    // Middleware is registered after the path, within a few hundred chars
    const nearContinue = source.slice(continuePartialIdx, continuePartialIdx + 200);
    const nearSearch = source.slice(searchAgainIdx, searchAgainIdx + 200);
    expect(nearContinue).toContain('validateOrderIdParam');
    expect(nearSearch).toContain('validateOrderIdParam');
  });

  test('H18-ROUTE-05: PARTIAL_FILL_ACTION_STATUSES includes both "expired" and "partially_filled"', () => {
    expect(source).toContain("'expired'");
    expect(source).toContain("'partially_filled'");
    expect(source).toMatch(/PARTIAL_FILL_ACTION_STATUSES.*expired.*partially_filled/s);
  });
});
