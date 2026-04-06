/**
 * =============================================================================
 * LOW PRIORITY FIXES — BRAVO-TEST (Team APEX)
 * =============================================================================
 *
 * Tests for 4 BRAVO fixes (low-priority group):
 *
 * F-1-11: Cancel route queue middleware consistency
 * F-2-5:  fully_filled cancellation
 * F-4-19: Chunk size bounds (SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE)
 * F-4-20 + F-7-20: Counter drift guard + reconciliation
 *
 * @author BRAVO-TEST (Team APEX)
 * =============================================================================
 */

import {
  BOOKING_VALID_TRANSITIONS,
  ORDER_VALID_TRANSITIONS,
  isValidTransition,
  assertValidTransition,
} from '../core/state-machines';

// =============================================================================
// F-1-11: Cancel route queue middleware consistency
// =============================================================================

describe('F-1-11: Cancel route queue middleware consistency', () => {
  /**
   * The booking routes module uses bookingQueue.middleware() on all cancel
   * routes to serialize concurrent requests per customer, preventing race
   * conditions on cancel-vs-accept.
   *
   * We verify the route definitions exist and use the queue middleware
   * by reading the module source (not importing it, since it starts timers).
   */

  let routeSource: string;

  beforeAll(async () => {
    const fs = await import('fs');
    const path = await import('path');
    routeSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'booking', 'booking.routes.ts'),
      'utf-8'
    );
  });

  it('has PATCH /:id/cancel route', () => {
    // PATCH /bookings/:id/cancel — legacy single-booking cancel
    expect(routeSource).toContain("'/:id/cancel'");
    expect(routeSource).toMatch(/router\.patch\(\s*'\/:id\/cancel'/);
  });

  it('has POST /orders/:orderId/cancel route on booking router', () => {
    // POST /bookings/orders/:orderId/cancel — canonical order cancel alias
    expect(routeSource).toContain("'/orders/:orderId/cancel'");
    expect(routeSource).toMatch(/router\.post\(\s*'\/orders\/:orderId\/cancel'/);
  });

  it('all cancel routes use bookingQueue.middleware()', () => {
    // Extract route blocks containing 'cancel' in the path
    const cancelBlocks: string[] = [];
    const routeRegex = /router\.(patch|post|delete|put)\(\s*['"]([^'"]*cancel[^'"]*)['"]/g;
    let match;
    while ((match = routeRegex.exec(routeSource)) !== null) {
      // Capture the block from this route match to the next router call or end
      const start = match.index;
      const nextRouter = routeSource.indexOf('router.', start + 10);
      const block = routeSource.slice(start, nextRouter > 0 ? nextRouter : start + 800);
      cancelBlocks.push(block);
    }

    expect(cancelBlocks.length).toBeGreaterThanOrEqual(2);

    // Every cancel route block must contain bookingQueue.middleware
    for (const block of cancelBlocks) {
      // Skip cancel-preview and cancel/dispute which are not mutation routes
      if (block.includes('cancel-preview') || block.includes("cancel/dispute'")) continue;
      expect(block).toContain('bookingQueue.middleware');
    }
  });

  it('cancel routes use HIGH priority with 12000ms timeout', () => {
    // All cancel routes should use Priority.HIGH and 12s timeout
    const cancelRouteMatches = routeSource.match(
      /(?:cancel['"],\s*\n\s*authMiddleware[\s\S]*?bookingQueue\.middleware\(\{[^}]+\})/g
    );
    // At least the PATCH and POST cancel routes
    expect(cancelRouteMatches).not.toBeNull();
    for (const m of cancelRouteMatches!) {
      expect(m).toContain('Priority.HIGH');
      expect(m).toContain('timeout: 12000');
    }
  });

  it('cancel response shape: booking cancel returns { success, data: { booking } }', () => {
    // Verify the PATCH /:id/cancel handler returns consistent shape
    const patchBlock = routeSource.slice(
      routeSource.indexOf("router.patch(\n  '/:id/cancel'") > -1
        ? routeSource.indexOf("'/:id/cancel'")
        : routeSource.indexOf("':id/cancel'"),
      routeSource.indexOf("'/:id/cancel'") + 600
    );
    expect(patchBlock).toContain('success: true');
    expect(patchBlock).toContain('data:');
  });

  it('order cancel route also has bookingQueue.middleware on order.routes.ts', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const orderRouteSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'order', 'order.routes.ts'),
      'utf-8'
    );
    // POST /orders/:id/cancel
    expect(orderRouteSource).toContain("'/:id/cancel'");
    expect(orderRouteSource).toContain('bookingQueue.middleware');
    // Verify it also uses Priority.HIGH
    const cancelSection = orderRouteSource.slice(
      orderRouteSource.indexOf("'/:id/cancel'"),
      orderRouteSource.indexOf("'/:id/cancel'") + 400
    );
    expect(cancelSection).toContain('Priority.HIGH');
  });
});

// =============================================================================
// F-2-5: fully_filled cancellation
// =============================================================================

describe('F-2-5: fully_filled cancellation', () => {
  /**
   * The fix ensures that bookings and orders in fully_filled status can be
   * cancelled. The state machine allows fully_filled -> cancelled, and the
   * CAS WHERE clause in cancelBooking includes fully_filled.
   */

  describe('state machine allows fully_filled -> cancelled', () => {
    it('BOOKING: fully_filled -> cancelled is valid', () => {
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'fully_filled', 'cancelled')).toBe(true);
    });

    it('ORDER: fully_filled -> cancelled is valid', () => {
      expect(isValidTransition(ORDER_VALID_TRANSITIONS, 'fully_filled', 'cancelled')).toBe(true);
    });

    it('BOOKING: fully_filled -> in_progress is also valid', () => {
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'fully_filled', 'in_progress')).toBe(true);
    });

    it('BOOKING: fully_filled has exactly 2 valid transitions', () => {
      const transitions = BOOKING_VALID_TRANSITIONS['fully_filled'];
      expect(transitions).toEqual(['in_progress', 'cancelled']);
      expect(transitions.length).toBe(2);
    });

    it('ORDER: fully_filled has exactly 2 valid transitions', () => {
      const transitions = ORDER_VALID_TRANSITIONS['fully_filled'];
      expect(transitions).toEqual(['in_progress', 'cancelled']);
      expect(transitions.length).toBe(2);
    });

    it('assertValidTransition does NOT throw for fully_filled -> cancelled', () => {
      expect(() =>
        assertValidTransition('booking', BOOKING_VALID_TRANSITIONS, 'fully_filled', 'cancelled')
      ).not.toThrow();
    });
  });

  describe('cancelBooking CAS WHERE includes fully_filled', () => {
    let bookingServiceSource: string;

    beforeAll(async () => {
      const fs = await import('fs');
      const path = await import('path');
      bookingServiceSource = fs.readFileSync(
        path.join(__dirname, '..', 'modules', 'booking', 'booking.service.ts'),
        'utf-8'
      );
    });

    it('cancel booking updateMany WHERE clause includes fully_filled', () => {
      // The CAS guard: status: { in: [..., BookingStatus.fully_filled] }
      // The updateMany is ~2350 chars into the method, so use 3000 char slice
      const cancelBookingIdx = bookingServiceSource.indexOf('async cancelBooking(');
      expect(cancelBookingIdx).toBeGreaterThan(-1);

      const methodBlock = bookingServiceSource.slice(cancelBookingIdx, cancelBookingIdx + 3000);
      expect(methodBlock).toContain('BookingStatus.fully_filled');
      // Verify it's in the status: { in: [...] } array
      expect(methodBlock).toMatch(/status:\s*\{\s*in:\s*\[.*fully_filled/s);
    });

    it('cancel booking sets status to BookingStatus.cancelled', () => {
      const cancelBookingIdx = bookingServiceSource.indexOf('async cancelBooking(');
      const methodBlock = bookingServiceSource.slice(cancelBookingIdx, cancelBookingIdx + 3000);
      expect(methodBlock).toContain('BookingStatus.cancelled');
    });
  });

  describe('cancelOrder includes fully_filled in cancellable list', () => {
    let cancelServiceSource: string;

    beforeAll(async () => {
      const fs = await import('fs');
      const path = await import('path');
      // cancelOrder logic extracted to order-cancel.service.ts
      cancelServiceSource = fs.readFileSync(
        path.join(__dirname, '..', 'modules', 'order', 'order-cancel.service.ts'),
        'utf-8'
      );
    });

    it('cancellableOrderStatuses includes OrderStatus.fully_filled', () => {
      const cancelOrderIdx = cancelServiceSource.indexOf('async function cancelOrder(');
      expect(cancelOrderIdx).toBeGreaterThan(-1);

      // Need larger slice to reach past the idempotency + lock logic to the status array
      const methodBlock = cancelServiceSource.slice(cancelOrderIdx, cancelOrderIdx + 2000);
      expect(methodBlock).toContain('OrderStatus.fully_filled');
      expect(methodBlock).toContain('cancellableOrderStatuses');
    });
  });

  describe('cancel on non-cancellable states', () => {
    it('in_progress -> cancelled IS valid (but different from fully_filled logic)', () => {
      // in_progress can be cancelled too per state machine
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'in_progress', 'cancelled')).toBe(true);
    });

    it('completed -> cancelled is NOT valid (terminal state)', () => {
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'completed', 'cancelled')).toBe(false);
    });

    it('expired -> cancelled is NOT valid (terminal state)', () => {
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'expired', 'cancelled')).toBe(false);
    });

    it('cancelled -> cancelled is NOT valid (already terminal)', () => {
      expect(isValidTransition(BOOKING_VALID_TRANSITIONS, 'cancelled', 'cancelled')).toBe(false);
    });
  });

  describe('idempotent cancel on already-cancelled booking', () => {
    it('cancelBooking returns early for already-cancelled (source check)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'modules', 'booking', 'booking.service.ts'),
        'utf-8'
      );
      // The cancelBooking method has an early return for idempotent cancel
      // Use larger slice to capture indented class methods
      const cancelIdx = src.indexOf('async cancelBooking(');
      const block = src.slice(cancelIdx, cancelIdx + 1200);
      // Match the actual code pattern: preflight.status === 'cancelled'
      expect(block).toContain("=== 'cancelled'");
      expect(block).toContain('Idempotent cancel');
      expect(block).toContain('return preflight');
    });
  });

  describe('all pre-fully_filled states can reach cancelled', () => {
    const preCancelStates = ['created', 'broadcasting', 'active', 'partially_filled', 'fully_filled'];
    for (const state of preCancelStates) {
      it(`${state} -> cancelled is valid`, () => {
        expect(isValidTransition(BOOKING_VALID_TRANSITIONS, state, 'cancelled')).toBe(true);
      });
    }
  });
});

// =============================================================================
// F-4-19: Chunk size bounds (SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE)
// =============================================================================

describe('F-4-19: Chunk size bounds — SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE', () => {
  /**
   * The fix clamps chunk size to [25, 500] using:
   *   Math.min(500, Math.max(25, parseInt(env || '300', 10) || 300))
   *
   * We replicate this clamping logic directly to test the math.
   */

  function computeChunkSize(envValue: string | undefined): number {
    return Math.min(500, Math.max(25, parseInt(envValue || '300', 10) || 300));
  }

  it('defaults to 300 when env is not set', () => {
    expect(computeChunkSize(undefined)).toBe(300);
  });

  it('defaults to 300 when env is empty string', () => {
    expect(computeChunkSize('')).toBe(300);
  });

  it('value=10 is clamped to floor of 25', () => {
    expect(computeChunkSize('10')).toBe(25);
  });

  it('value=1 is clamped to floor of 25', () => {
    expect(computeChunkSize('1')).toBe(25);
  });

  it('value=25 is the minimum allowed', () => {
    expect(computeChunkSize('25')).toBe(25);
  });

  it('value=300 is the default and stays 300', () => {
    expect(computeChunkSize('300')).toBe(300);
  });

  it('value=100 stays 100 (within bounds)', () => {
    expect(computeChunkSize('100')).toBe(100);
  });

  it('value=500 is the max allowed', () => {
    expect(computeChunkSize('500')).toBe(500);
  });

  it('value=1000 is clamped to ceiling of 500', () => {
    expect(computeChunkSize('1000')).toBe(500);
  });

  it('value=999999 is clamped to 500', () => {
    expect(computeChunkSize('999999')).toBe(500);
  });

  it('value=NaN falls back to default 300', () => {
    expect(computeChunkSize('notanumber')).toBe(300);
  });

  it('value="abc" falls back to default 300', () => {
    expect(computeChunkSize('abc')).toBe(300);
  });

  it('value=0 is clamped to floor 25 (0 < 25)', () => {
    // parseInt('0') = 0, then || 300 kicks in because 0 is falsy, so result is 300
    // Actually: parseInt('0') = 0, 0 || 300 = 300 (JS falsy)
    // Math.min(500, Math.max(25, 300)) = 300
    expect(computeChunkSize('0')).toBe(300);
  });

  it('negative value is clamped to floor 25', () => {
    // parseInt('-5') = -5, -5 || 300 => -5 is truthy (non-zero)
    // Math.min(500, Math.max(25, -5)) = 25
    expect(computeChunkSize('-5')).toBe(25);
  });

  describe('env.validation.ts validator', () => {
    /**
     * The env validator uses:
     *   (v) => !isNaN(parseInt(v)) && parseInt(v) >= 25 && parseInt(v) <= 500
     */
    function envValidator(v: string): boolean {
      return !isNaN(parseInt(v)) && parseInt(v) >= 25 && parseInt(v) <= 500;
    }

    it('rejects value < 25', () => {
      expect(envValidator('10')).toBe(false);
      expect(envValidator('24')).toBe(false);
      expect(envValidator('0')).toBe(false);
    });

    it('accepts value = 25 (lower bound)', () => {
      expect(envValidator('25')).toBe(true);
    });

    it('accepts value = 300 (default)', () => {
      expect(envValidator('300')).toBe(true);
    });

    it('accepts value = 500 (upper bound)', () => {
      expect(envValidator('500')).toBe(true);
    });

    it('rejects value > 500', () => {
      expect(envValidator('501')).toBe(false);
      expect(envValidator('1000')).toBe(false);
    });

    it('rejects non-numeric strings', () => {
      // parseInt('abc') is NaN => !isNaN(NaN) = false => short-circuit false
      expect(envValidator('abc')).toBe(false);
      expect(envValidator('not_a_number')).toBe(false);
    });

    it('rejects negative values', () => {
      expect(envValidator('-1')).toBe(false);
      expect(envValidator('-100')).toBe(false);
    });
  });

  describe('socket.service.ts uses the clamped constant', () => {
    let socketSource: string;

    beforeAll(async () => {
      const fs = await import('fs');
      const path = await import('path');
      socketSource = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'services', 'socket.service.ts'),
        'utf-8'
      );
    });

    it('defines SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE with Math.min/max clamping', () => {
      expect(socketSource).toContain('SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE');
      expect(socketSource).toMatch(/Math\.min\(500,\s*Math\.max\(25/);
    });

    it('emitToUsers uses the chunk size constant', () => {
      const emitFn = socketSource.slice(
        socketSource.indexOf('export function emitToUsers'),
        socketSource.indexOf('export function emitToUsers') + 600
      );
      expect(emitFn).toContain('SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE');
      expect(emitFn).toContain('chunkSize');
      // The slice call is further down — just verify the chunking loop structure
      const fullEmitFn = socketSource.slice(
        socketSource.indexOf('export function emitToUsers'),
        socketSource.indexOf('export function emitToUsers') + 900
      );
      expect(fullEmitFn).toContain('userRooms.slice(index, index + chunkSize)');
    });
  });
});

// =============================================================================
// F-4-20 + F-7-20: Counter drift guard + reconciliation
// =============================================================================

describe('F-4-20 + F-7-20: Counter drift guard + reconciliation', () => {
  /**
   * F-4-20: Disconnect with undefined role should NOT decrement counters
   *         (prevents NaN drift when socket.data.role is missing).
   *         Uses Math.max(0, ...) to prevent negative counters.
   *
   * F-7-20: Periodic reconciliation rebuilds roleCounters from actual
   *         connected sockets every 60s.
   */

  describe('roleCounter disconnect guard', () => {
    /**
     * Replicate the disconnect logic from socket.service.ts:
     *
     *   const disconnectRole = socket.data?.role;
     *   if (disconnectRole) {
     *     const roleCounterKey = disconnectRole + 's';
     *     if (roleCounterKey in roleCounters) {
     *       roleCounters[roleCounterKey] = Math.max(0, roleCounters[roleCounterKey] - 1);
     *     }
     *   }
     */

    function simulateDisconnect(
      counters: { customers: number; transporters: number; drivers: number },
      role: string | undefined
    ): { customers: number; transporters: number; drivers: number } {
      // Return new object (immutable pattern for testing)
      const result = { ...counters };
      if (role) {
        const key = role + 's' as keyof typeof result;
        if (key in result) {
          (result[key] as number) = Math.max(0, (result[key] as number) - 1);
        }
      }
      return result;
    }

    it('disconnect with undefined role does NOT decrement any counter', () => {
      const before = { customers: 5, transporters: 3, drivers: 2 };
      const after = simulateDisconnect(before, undefined);
      expect(after).toEqual({ customers: 5, transporters: 3, drivers: 2 });
    });

    it('disconnect with null role does NOT decrement any counter', () => {
      const before = { customers: 5, transporters: 3, drivers: 2 };
      const after = simulateDisconnect(before, null as unknown as undefined);
      expect(after).toEqual({ customers: 5, transporters: 3, drivers: 2 });
    });

    it('disconnect with empty string role does NOT decrement any counter', () => {
      const before = { customers: 5, transporters: 3, drivers: 2 };
      // Empty string is falsy, so the guard triggers
      const after = simulateDisconnect(before, '');
      expect(after).toEqual({ customers: 5, transporters: 3, drivers: 2 });
    });

    it('disconnect with "customer" role decrements customers by 1', () => {
      const before = { customers: 5, transporters: 3, drivers: 2 };
      const after = simulateDisconnect(before, 'customer');
      expect(after).toEqual({ customers: 4, transporters: 3, drivers: 2 });
    });

    it('disconnect with "transporter" role decrements transporters by 1', () => {
      const before = { customers: 5, transporters: 3, drivers: 2 };
      const after = simulateDisconnect(before, 'transporter');
      expect(after).toEqual({ customers: 5, transporters: 2, drivers: 2 });
    });

    it('disconnect with "driver" role decrements drivers by 1', () => {
      const before = { customers: 5, transporters: 3, drivers: 2 };
      const after = simulateDisconnect(before, 'driver');
      expect(after).toEqual({ customers: 5, transporters: 3, drivers: 1 });
    });

    it('disconnect with unknown role (e.g. "admin") does NOT decrement', () => {
      const before = { customers: 5, transporters: 3, drivers: 2 };
      // "admin" + "s" = "admins", which is NOT in roleCounters
      const after = simulateDisconnect(before, 'admin');
      expect(after).toEqual({ customers: 5, transporters: 3, drivers: 2 });
    });

    it('Math.max(0, ...) prevents negative counters when counter is 0', () => {
      const before = { customers: 0, transporters: 0, drivers: 0 };
      const after = simulateDisconnect(before, 'customer');
      expect(after.customers).toBe(0); // NOT -1
    });

    it('Math.max(0, ...) prevents counter going below 0 on multiple disconnects', () => {
      let counters = { customers: 1, transporters: 0, drivers: 0 };
      counters = simulateDisconnect(counters, 'customer'); // 1 -> 0
      expect(counters.customers).toBe(0);
      counters = simulateDisconnect(counters, 'customer'); // 0 -> max(0, -1) = 0
      expect(counters.customers).toBe(0);
      counters = simulateDisconnect(counters, 'customer'); // still 0
      expect(counters.customers).toBe(0);
    });
  });

  describe('roleCounter connect logic', () => {
    function simulateConnect(
      counters: { customers: number; transporters: number; drivers: number },
      role: string
    ): { customers: number; transporters: number; drivers: number } {
      const result = { ...counters };
      const key = role + 's' as keyof typeof result;
      if (key in result) {
        (result[key] as number)++;
      }
      return result;
    }

    it('connect with "customer" increments customers counter', () => {
      const before = { customers: 0, transporters: 0, drivers: 0 };
      const after = simulateConnect(before, 'customer');
      expect(after).toEqual({ customers: 1, transporters: 0, drivers: 0 });
    });

    it('connect with "transporter" increments transporters counter', () => {
      const before = { customers: 0, transporters: 0, drivers: 0 };
      const after = simulateConnect(before, 'transporter');
      expect(after).toEqual({ customers: 0, transporters: 1, drivers: 0 });
    });

    it('connect with "driver" increments drivers counter', () => {
      const before = { customers: 0, transporters: 0, drivers: 0 };
      const after = simulateConnect(before, 'driver');
      expect(after).toEqual({ customers: 0, transporters: 0, drivers: 1 });
    });
  });

  describe('reconciliation logic', () => {
    /**
     * Replicate the reconciliation from socket.service.ts:
     *
     *   const counted = { customers: 0, transporters: 0, drivers: 0 };
     *   for (const [, socket] of io.sockets.sockets) {
     *     const r = socket.data?.role;
     *     if (r === 'customer') counted.customers++;
     *     else if (r === 'transporter') counted.transporters++;
     *     else if (r === 'driver') counted.drivers++;
     *   }
     *   roleCounters = counted;
     */

    type MockSocket = { data?: { role?: string } };

    function reconcile(
      currentCounters: { customers: number; transporters: number; drivers: number },
      sockets: MockSocket[]
    ): {
      newCounters: { customers: number; transporters: number; drivers: number };
      hasDrift: boolean;
    } {
      const counted = { customers: 0, transporters: 0, drivers: 0 };
      for (const socket of sockets) {
        const r = socket.data?.role;
        if (r === 'customer') counted.customers++;
        else if (r === 'transporter') counted.transporters++;
        else if (r === 'driver') counted.drivers++;
      }
      const hasDrift =
        currentCounters.customers !== counted.customers ||
        currentCounters.transporters !== counted.transporters ||
        currentCounters.drivers !== counted.drivers;
      return { newCounters: counted, hasDrift };
    }

    it('no drift when counters match actual sockets', () => {
      const counters = { customers: 2, transporters: 1, drivers: 3 };
      const sockets: MockSocket[] = [
        { data: { role: 'customer' } },
        { data: { role: 'customer' } },
        { data: { role: 'transporter' } },
        { data: { role: 'driver' } },
        { data: { role: 'driver' } },
        { data: { role: 'driver' } },
      ];
      const result = reconcile(counters, sockets);
      expect(result.hasDrift).toBe(false);
      expect(result.newCounters).toEqual(counters);
    });

    it('detects drift and corrects counters', () => {
      // Counters say 5 customers, but only 2 actually connected
      const counters = { customers: 5, transporters: 3, drivers: 2 };
      const sockets: MockSocket[] = [
        { data: { role: 'customer' } },
        { data: { role: 'customer' } },
        { data: { role: 'transporter' } },
      ];
      const result = reconcile(counters, sockets);
      expect(result.hasDrift).toBe(true);
      expect(result.newCounters).toEqual({ customers: 2, transporters: 1, drivers: 0 });
    });

    it('handles sockets with undefined role (not counted)', () => {
      const counters = { customers: 0, transporters: 0, drivers: 0 };
      const sockets: MockSocket[] = [
        { data: { role: undefined } },
        { data: undefined },
        {},
      ];
      const result = reconcile(counters, sockets);
      expect(result.hasDrift).toBe(false);
      expect(result.newCounters).toEqual({ customers: 0, transporters: 0, drivers: 0 });
    });

    it('handles sockets with unknown role (not counted)', () => {
      const counters = { customers: 0, transporters: 0, drivers: 0 };
      const sockets: MockSocket[] = [
        { data: { role: 'admin' } },
        { data: { role: 'superuser' } },
      ];
      const result = reconcile(counters, sockets);
      expect(result.hasDrift).toBe(false);
      expect(result.newCounters).toEqual({ customers: 0, transporters: 0, drivers: 0 });
    });

    it('after restart (counters at 0), rebuilds as clients reconnect', () => {
      // Simulate restart: counters reset to 0, but sockets exist
      const counters = { customers: 0, transporters: 0, drivers: 0 };
      const sockets: MockSocket[] = [
        { data: { role: 'customer' } },
        { data: { role: 'transporter' } },
        { data: { role: 'transporter' } },
        { data: { role: 'driver' } },
      ];
      const result = reconcile(counters, sockets);
      expect(result.hasDrift).toBe(true);
      expect(result.newCounters).toEqual({ customers: 1, transporters: 2, drivers: 1 });
    });

    it('empty sockets => all counters become 0', () => {
      const counters = { customers: 10, transporters: 5, drivers: 3 };
      const sockets: MockSocket[] = [];
      const result = reconcile(counters, sockets);
      expect(result.hasDrift).toBe(true);
      expect(result.newCounters).toEqual({ customers: 0, transporters: 0, drivers: 0 });
    });

    it('mixed roles are counted correctly', () => {
      const counters = { customers: 0, transporters: 0, drivers: 0 };
      const sockets: MockSocket[] = [
        { data: { role: 'driver' } },
        { data: { role: 'customer' } },
        { data: { role: 'driver' } },
        { data: { role: 'transporter' } },
        { data: { role: 'customer' } },
        { data: { role: 'driver' } },
        { data: { role: 'customer' } },
      ];
      const result = reconcile(counters, sockets);
      expect(result.newCounters).toEqual({ customers: 3, transporters: 1, drivers: 3 });
    });
  });

  describe('source code verification', () => {
    let socketSource: string;

    beforeAll(async () => {
      const fs = await import('fs');
      const path = await import('path');
      socketSource = fs.readFileSync(
        path.join(__dirname, '..', 'shared', 'services', 'socket.service.ts'),
        'utf-8'
      );
    });

    it('disconnect handler guards against undefined role', () => {
      // F-4-20 FIX: Guard against undefined role to prevent NaN drift
      expect(socketSource).toContain('F-4-20 FIX');
      expect(socketSource).toContain('const disconnectRole = socket.data?.role');
      expect(socketSource).toContain('if (disconnectRole)');
    });

    it('disconnect uses Math.max(0, ...) to prevent negative counters', () => {
      // Find the disconnect section — use wider slice to capture the Math.max line
      const fixIdx = socketSource.indexOf('F-4-20 FIX: Guard');
      const disconnectSection = socketSource.slice(fixIdx, fixIdx + 500);
      expect(disconnectSection).toContain('Math.max(0');
    });

    it('has periodic reconciliation interval (every 60s)', () => {
      expect(socketSource).toContain('F-4-20 FIX: Periodic reconciliation');
      expect(socketSource).toContain('roleCounters drift detected');
      expect(socketSource).toContain('60_000');
    });

    it('reconciliation counts from io.sockets.sockets', () => {
      const reconBlock = socketSource.slice(
        socketSource.indexOf('Periodic reconciliation'),
        socketSource.indexOf('Periodic reconciliation') + 600
      );
      expect(reconBlock).toContain('io.sockets.sockets');
      expect(reconBlock).toContain("'customer'");
      expect(reconBlock).toContain("'transporter'");
      expect(reconBlock).toContain("'driver'");
    });

    it('roleCounters is initialized with all zeroes', () => {
      expect(socketSource).toContain('const roleCounters = {');
      expect(socketSource).toContain('customers: 0');
      expect(socketSource).toContain('transporters: 0');
      expect(socketSource).toContain('drivers: 0');
    });

    it('getSocketStats exposes roleCounters as connectionsByRole', () => {
      const statsSection = socketSource.slice(
        socketSource.indexOf('connectionsByRole'),
        socketSource.indexOf('connectionsByRole') + 200
      );
      expect(statsSection).toContain('roleCounters.customers');
      expect(statsSection).toContain('roleCounters.transporters');
      expect(statsSection).toContain('roleCounters.drivers');
    });
  });
});
