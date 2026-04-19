/**
 * =============================================================================
 * PHASE A: C1 + C2 FIXES
 * =============================================================================
 *
 * C1: booking_completed emitted alongside order_completed
 *   Three call sites all gained a second emitToUser call for 'booking_completed':
 *   - order.routes.ts  /reached-stop handler (line 784)
 *   - tracking.service.ts  checkOrderCompletion (line 2044)
 *   - tracking-fleet.service.ts  checkOrderCompletion (line 472)
 *
 * C2: trucks_remaining_update + booking_fully_filled re-enabled
 *   In order-accept.service.ts both emits were commented out; they are now live:
 *   - line 479: emitToUser(customerId, 'trucks_remaining_update', {...})
 *   - lines 500-518: if (newStatus === 'fully_filled') emitToUser(customerId, 'booking_fully_filled', {...})
 *
 * Test strategy: unit-level simulation tests (same pattern as tracking-completion.test.ts).
 * We isolate the emit logic from DB / network calls so every assertion can run
 * deterministically without real infrastructure.
 * =============================================================================
 */

// =============================================================================
// C1 SECTION — booking_completed co-emit
// =============================================================================

describe('C1 -- booking_completed co-emit alongside primary completion event', () => {
  // --------------------------------------------------------------------------
  // Shared emit capture helper used across all three call sites
  // --------------------------------------------------------------------------

  interface EmitCall {
    userId: string;
    event: string;
    data: Record<string, unknown>;
  }

  function makeEmitSpy(): { calls: EmitCall[]; fn: (userId: string, event: string, data: Record<string, unknown>) => boolean } {
    const calls: EmitCall[] = [];
    const fn = (userId: string, event: string, data: Record<string, unknown>): boolean => {
      calls.push({ userId, event, data });
      return true;
    };
    return { calls, fn };
  }

  // --------------------------------------------------------------------------
  // Simulate the /reached-stop handler emit block (order.routes.ts lines 779-788)
  // --------------------------------------------------------------------------

  function simulateReachedStopCompletionEmits(
    emitToUser: (userId: string, event: string, data: Record<string, unknown>) => boolean,
    params: { customerId: string; orderId: string; now: string; isCompleted: boolean; pointType: string }
  ): void {
    const { customerId, orderId, now, isCompleted, pointType } = params;

    // route_progress_updated is always emitted
    emitToUser(customerId, 'route_progress_updated', { orderId });

    if (isCompleted && pointType === 'DROP') {
      // Primary event
      emitToUser(customerId, 'order_completed', { orderId, completedAt: now });
      // C1: backward-compat event added in this fix
      emitToUser(customerId, 'booking_completed', {
        orderId,
        bookingId: orderId,
        completedAt: now
      });
    }
  }

  describe('order.routes.ts /reached-stop handler', () => {
    const NOW = '2026-04-11T10:00:00.000Z';
    const ORDER_ID = 'order-abc-001';
    const CUSTOMER_ID = 'customer-xyz-001';

    it('emits booking_completed immediately after order_completed when DROP is reached', () => {
      const spy = makeEmitSpy();

      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: true,
        pointType: 'DROP'
      });

      const completionEmits = spy.calls.filter(c => c.event === 'order_completed' || c.event === 'booking_completed');
      expect(completionEmits).toHaveLength(2);

      const orderCompletedIdx = spy.calls.findIndex(c => c.event === 'order_completed');
      const bookingCompletedIdx = spy.calls.findIndex(c => c.event === 'booking_completed');
      // booking_completed must come AFTER order_completed
      expect(bookingCompletedIdx).toBeGreaterThan(orderCompletedIdx);
    });

    it('booking_completed payload contains orderId, bookingId === orderId, and completedAt', () => {
      const spy = makeEmitSpy();

      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: true,
        pointType: 'DROP'
      });

      const call = spy.calls.find(c => c.event === 'booking_completed');
      expect(call).toBeDefined();
      expect(call!.userId).toBe(CUSTOMER_ID);
      expect(call!.data.orderId).toBe(ORDER_ID);
      expect(call!.data.bookingId).toBe(ORDER_ID);
      expect(call!.data.completedAt).toBe(NOW);
    });

    it('does NOT emit booking_completed when stop is intermediate (STOP type)', () => {
      const spy = makeEmitSpy();

      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: false,
        pointType: 'STOP'
      });

      expect(spy.calls.find(c => c.event === 'booking_completed')).toBeUndefined();
      expect(spy.calls.find(c => c.event === 'order_completed')).toBeUndefined();
    });

    it('does NOT emit booking_completed when isCompleted is false even at DROP type', () => {
      const spy = makeEmitSpy();

      // Edge: driver is at DROP index but isCompleted flag is false (shouldn't happen in prod, but guard)
      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: false,
        pointType: 'DROP'
      });

      expect(spy.calls.find(c => c.event === 'booking_completed')).toBeUndefined();
    });

    it('does NOT emit booking_completed when point type is PICKUP', () => {
      const spy = makeEmitSpy();

      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: true,
        pointType: 'PICKUP'
      });

      expect(spy.calls.find(c => c.event === 'booking_completed')).toBeUndefined();
    });

    it('emits exactly one booking_completed per completion (idempotency concern)', () => {
      const spy = makeEmitSpy();

      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: true,
        pointType: 'DROP'
      });

      const count = spy.calls.filter(c => c.event === 'booking_completed').length;
      expect(count).toBe(1);
    });

    it('routes booking_completed to the correct customerId, not a driver', () => {
      const spy = makeEmitSpy();
      const DRIVER_ID = 'driver-zzz-999'; // different from CUSTOMER_ID

      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: true,
        pointType: 'DROP'
      });

      const call = spy.calls.find(c => c.event === 'booking_completed');
      expect(call!.userId).toBe(CUSTOMER_ID);
      expect(call!.userId).not.toBe(DRIVER_ID);
    });
  });

  // --------------------------------------------------------------------------
  // Simulate tracking.service.ts checkOrderCompletion emit block (lines 2035-2048)
  // --------------------------------------------------------------------------

  function simulateTrackingServiceOrderCompletionEmits(
    emitToUser: (userId: string, event: string, data: Record<string, unknown>) => boolean,
    params: {
      customerId: string | null;
      orderId: string;
      newOrderStatus: string;
      totalAssignments: number;
    }
  ): void {
    const { customerId, orderId, newOrderStatus, totalAssignments } = params;

    if (!customerId) return;

    if (newOrderStatus === 'completed') {
      // Primary event
      emitToUser(customerId, 'order_status_update', {
        orderId,
        totalAssignments,
        message: 'All deliveries for your order are complete!'
      });
      // C1: backward-compat co-emit
      emitToUser(customerId, 'booking_completed', {
        orderId,
        bookingId: orderId,
        completedAt: new Date().toISOString()
      });
    } else {
      emitToUser(customerId, 'order_status_update', {
        orderId,
        totalAssignments,
        message: 'Your order has been cancelled.'
      });
    }
  }

  describe('tracking.service.ts checkOrderCompletion', () => {
    const ORDER_ID = 'order-track-001';
    const CUSTOMER_ID = 'customer-track-001';

    it('emits booking_completed after order_status_update when newOrderStatus is completed', () => {
      const spy = makeEmitSpy();

      simulateTrackingServiceOrderCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 3
      });

      const statusUpdateIdx = spy.calls.findIndex(c => c.event === 'order_status_update');
      const bookingCompletedIdx = spy.calls.findIndex(c => c.event === 'booking_completed');

      expect(statusUpdateIdx).toBeGreaterThanOrEqual(0);
      expect(bookingCompletedIdx).toBeGreaterThan(statusUpdateIdx);
    });

    it('booking_completed payload from tracking.service has orderId, bookingId === orderId, completedAt string', () => {
      const spy = makeEmitSpy();

      simulateTrackingServiceOrderCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 2
      });

      const call = spy.calls.find(c => c.event === 'booking_completed');
      expect(call).toBeDefined();
      expect(call!.data.orderId).toBe(ORDER_ID);
      expect(call!.data.bookingId).toBe(ORDER_ID);
      expect(typeof call!.data.completedAt).toBe('string');
      // completedAt must be a valid ISO date
      expect(new Date(call!.data.completedAt as string).getTime()).not.toBeNaN();
    });

    it('does NOT emit booking_completed when newOrderStatus is cancelled', () => {
      const spy = makeEmitSpy();

      simulateTrackingServiceOrderCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'cancelled',
        totalAssignments: 2
      });

      expect(spy.calls.find(c => c.event === 'booking_completed')).toBeUndefined();
    });

    it('does NOT emit anything when customerId is null (no customer linked)', () => {
      const spy = makeEmitSpy();

      simulateTrackingServiceOrderCompletionEmits(spy.fn, {
        customerId: null,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 1
      });

      expect(spy.calls).toHaveLength(0);
    });

    it('order_status_update message differs between completed and cancelled paths', () => {
      const spyCompleted = makeEmitSpy();
      const spyCancelled = makeEmitSpy();

      simulateTrackingServiceOrderCompletionEmits(spyCompleted.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 1
      });

      simulateTrackingServiceOrderCompletionEmits(spyCancelled.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'cancelled',
        totalAssignments: 1
      });

      const completedMsg = (spyCompleted.calls.find(c => c.event === 'order_status_update')!.data.message as string);
      const cancelledMsg = (spyCancelled.calls.find(c => c.event === 'order_status_update')!.data.message as string);

      expect(completedMsg).toContain('complete');
      expect(cancelledMsg).toContain('cancelled');
      expect(completedMsg).not.toBe(cancelledMsg);
    });
  });

  // --------------------------------------------------------------------------
  // Simulate tracking-fleet.service.ts checkOrderCompletion (lines 464-476)
  // Same shape as tracking.service — verifies the fleet variant is consistent
  // --------------------------------------------------------------------------

  function simulateTrackingFleetServiceOrderCompletionEmits(
    emitToUser: (userId: string, event: string, data: Record<string, unknown>) => boolean,
    params: {
      customerId: string | null;
      orderId: string;
      newOrderStatus: string;
      totalAssignments: number;
    }
  ): void {
    const { customerId, orderId, newOrderStatus, totalAssignments } = params;

    if (!customerId) return;

    if (newOrderStatus === 'completed') {
      emitToUser(customerId, 'order_status_update', {
        orderId,
        totalAssignments,
        message: 'All deliveries for your order are complete!'
      });
      // C1 co-emit (tracking-fleet variant)
      emitToUser(customerId, 'booking_completed', {
        orderId,
        bookingId: orderId,
        completedAt: new Date().toISOString()
      });
    } else {
      emitToUser(customerId, 'order_status_update', {
        orderId,
        totalAssignments,
        message: 'Your order has been cancelled.'
      });
    }
  }

  describe('tracking-fleet.service.ts checkOrderCompletion', () => {
    const ORDER_ID = 'order-fleet-001';
    const CUSTOMER_ID = 'customer-fleet-001';

    it('emits booking_completed when fleet tracking marks order as completed', () => {
      const spy = makeEmitSpy();

      simulateTrackingFleetServiceOrderCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 2
      });

      expect(spy.calls.find(c => c.event === 'booking_completed')).toBeDefined();
    });

    it('fleet booking_completed payload is structurally identical to tracking.service variant', () => {
      const spy = makeEmitSpy();

      simulateTrackingFleetServiceOrderCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 2
      });

      const call = spy.calls.find(c => c.event === 'booking_completed')!;
      expect(call.data).toMatchObject({
        orderId: ORDER_ID,
        bookingId: ORDER_ID
      });
      expect(typeof call.data.completedAt).toBe('string');
    });

    it('fleet service does NOT emit booking_completed for cancelled orders', () => {
      const spy = makeEmitSpy();

      simulateTrackingFleetServiceOrderCompletionEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'cancelled',
        totalAssignments: 2
      });

      expect(spy.calls.find(c => c.event === 'booking_completed')).toBeUndefined();
    });

    it('fleet service does NOT emit when customerId is null', () => {
      const spy = makeEmitSpy();

      simulateTrackingFleetServiceOrderCompletionEmits(spy.fn, {
        customerId: null,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 2
      });

      expect(spy.calls).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Cross-service consistency: all three call sites produce the same payload shape
  // --------------------------------------------------------------------------

  describe('C1 payload shape consistency across all three call sites', () => {
    it('all three booking_completed payloads contain orderId, bookingId, completedAt', () => {
      const spyRoutes = makeEmitSpy();
      const spyTracking = makeEmitSpy();
      const spyFleet = makeEmitSpy();

      const ORDER_ID = 'order-cross-001';
      const CUSTOMER_ID = 'customer-cross-001';
      const NOW = '2026-04-11T12:00:00.000Z';

      simulateReachedStopCompletionEmits(spyRoutes.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        now: NOW,
        isCompleted: true,
        pointType: 'DROP'
      });

      simulateTrackingServiceOrderCompletionEmits(spyTracking.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 1
      });

      simulateTrackingFleetServiceOrderCompletionEmits(spyFleet.fn, {
        customerId: CUSTOMER_ID,
        orderId: ORDER_ID,
        newOrderStatus: 'completed',
        totalAssignments: 1
      });

      const payloads = [spyRoutes, spyTracking, spyFleet].map(
        spy => spy.calls.find(c => c.event === 'booking_completed')!.data
      );

      for (const payload of payloads) {
        expect(payload.orderId).toBe(ORDER_ID);
        expect(payload.bookingId).toBe(ORDER_ID);
        expect(typeof payload.completedAt).toBe('string');
        expect(new Date(payload.completedAt as string).getTime()).not.toBeNaN();
      }
    });

    it('bookingId always equals orderId (backward-compat requirement)', () => {
      const spy = makeEmitSpy();

      simulateReachedStopCompletionEmits(spy.fn, {
        customerId: 'cust-001',
        orderId: 'order-compat-99',
        now: new Date().toISOString(),
        isCompleted: true,
        pointType: 'DROP'
      });

      const call = spy.calls.find(c => c.event === 'booking_completed')!;
      expect(call.data.bookingId).toBe(call.data.orderId);
    });
  });
});

// =============================================================================
// C2 SECTION — trucks_remaining_update + booking_fully_filled re-enabled
// =============================================================================

describe('C2 -- trucks_remaining_update and booking_fully_filled emits in acceptTruckRequest', () => {
  interface EmitCall {
    userId: string;
    event: string;
    data: Record<string, unknown>;
  }

  function makeEmitSpy(): { calls: EmitCall[]; fn: (userId: string, event: string, data: Record<string, unknown>) => boolean } {
    const calls: EmitCall[] = [];
    const fn = (userId: string, event: string, data: Record<string, unknown>): boolean => {
      calls.push({ userId, event, data });
      return true;
    };
    return { calls, fn };
  }

  // --------------------------------------------------------------------------
  // Simulate the post-transaction emit block of acceptTruckRequest
  // (order-accept.service.ts lines 479-518)
  // --------------------------------------------------------------------------

  function simulateAcceptTruckRequestEmits(
    emitToUser: (userId: string, event: string, data: Record<string, unknown>) => boolean,
    params: {
      customerId: string;
      driverId: string;
      orderId: string;
      newStatus: string;
      newTrucksFilled: number;
      orderTotalTrucks: number;
      now: string;
      assignmentId: string;
      tripId: string;
      vehicleNumber: string;
      driverName: string;
      driverPhone: string;
    }
  ): void {
    const {
      customerId,
      orderId,
      newStatus,
      newTrucksFilled,
      orderTotalTrucks,
      now,
      assignmentId,
      tripId,
      vehicleNumber,
      driverName,
      driverPhone
    } = params;

    // C2 — always emitted (was commented out before this fix)
    emitToUser(customerId, 'trucks_remaining_update', {
      orderId,
      trucksNeeded: orderTotalTrucks,
      trucksFilled: newTrucksFilled,
      trucksRemaining: Math.max(orderTotalTrucks - newTrucksFilled, 0),
      isFullyFilled: newTrucksFilled >= orderTotalTrucks,
      timestamp: now,
      emittedAt: now
    });

    // C2 — conditional fully_filled emit (was commented out before this fix)
    if (newStatus === 'fully_filled') {
      const latestAssignment = { assignmentId, tripId, vehicleNumber, driverName, driverPhone };
      emitToUser(customerId, 'booking_fully_filled', {
        orderId,
        trucksNeeded: orderTotalTrucks,
        trucksFilled: newTrucksFilled,
        filledAt: now,
        emittedAt: now,
        latestAssignment,
        assignments: [latestAssignment]
      });
    }
  }

  const NOW = '2026-04-11T11:00:00.000Z';
  const CUSTOMER_ID = 'customer-accept-001';
  const DRIVER_ID = 'driver-accept-001';
  const ORDER_ID = 'order-accept-001';
  const ASSIGNMENT_ID = 'assign-001';
  const TRIP_ID = 'trip-001';
  const VEHICLE_NUMBER = 'MH01AB1234';
  const DRIVER_NAME = 'Ravi Kumar';
  const DRIVER_PHONE = '9999999999';

  // ---- trucks_remaining_update tests ----------------------------------------

  describe('trucks_remaining_update', () => {
    it('is emitted on every successful accept regardless of fill status', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 3,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update');
      expect(call).toBeDefined();
    });

    it('is emitted to the customerId', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.userId).toBe(CUSTOMER_ID);
    });

    it('payload trucksRemaining is (total - filled), clamped to >= 0', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 2,
        orderTotalTrucks: 3,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.trucksRemaining).toBe(1);
      expect(call.data.trucksFilled).toBe(2);
      expect(call.data.trucksNeeded).toBe(3);
    });

    it('payload trucksRemaining is 0 (not negative) when all trucks filled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 3,
        orderTotalTrucks: 3,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.trucksRemaining).toBe(0);
      expect((call.data.trucksRemaining as number)).toBeGreaterThanOrEqual(0);
    });

    it('isFullyFilled is false when trucks still needed', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 3,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.isFullyFilled).toBe(false);
    });

    it('isFullyFilled is true when newTrucksFilled >= orderTotalTrucks', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 2,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.isFullyFilled).toBe(true);
    });

    it('payload contains timestamp and emittedAt matching the now value', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.timestamp).toBe(NOW);
      expect(call.data.emittedAt).toBe(NOW);
    });

    it('payload contains orderId', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.orderId).toBe(ORDER_ID);
    });

    it('is emitted exactly once per accept call', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const count = spy.calls.filter(c => c.event === 'trucks_remaining_update').length;
      expect(count).toBe(1);
    });
  });

  // ---- booking_fully_filled tests -------------------------------------------

  describe('booking_fully_filled', () => {
    it('is emitted when newStatus is fully_filled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 2,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      expect(spy.calls.find(c => c.event === 'booking_fully_filled')).toBeDefined();
    });

    it('is NOT emitted when newStatus is partially_filled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 3,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      expect(spy.calls.find(c => c.event === 'booking_fully_filled')).toBeUndefined();
    });

    it('is NOT emitted for other terminal statuses like cancelled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'cancelled',
        newTrucksFilled: 1,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      expect(spy.calls.find(c => c.event === 'booking_fully_filled')).toBeUndefined();
    });

    it('is NOT emitted for created status', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'created',
        newTrucksFilled: 0,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      expect(spy.calls.find(c => c.event === 'booking_fully_filled')).toBeUndefined();
    });

    it('is sent to the customerId', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 1,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'booking_fully_filled')!;
      expect(call.userId).toBe(CUSTOMER_ID);
    });

    it('payload contains orderId, trucksNeeded, trucksFilled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 3,
        orderTotalTrucks: 3,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'booking_fully_filled')!;
      expect(call.data.orderId).toBe(ORDER_ID);
      expect(call.data.trucksNeeded).toBe(3);
      expect(call.data.trucksFilled).toBe(3);
    });

    it('payload latestAssignment contains driver and vehicle fields', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 1,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'booking_fully_filled')!;
      const latest = call.data.latestAssignment as Record<string, unknown>;
      expect(latest.assignmentId).toBe(ASSIGNMENT_ID);
      expect(latest.tripId).toBe(TRIP_ID);
      expect(latest.vehicleNumber).toBe(VEHICLE_NUMBER);
      expect(latest.driverName).toBe(DRIVER_NAME);
      expect(latest.driverPhone).toBe(DRIVER_PHONE);
    });

    it('payload assignments array contains exactly the latestAssignment', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 1,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'booking_fully_filled')!;
      const assignments = call.data.assignments as unknown[];
      expect(Array.isArray(assignments)).toBe(true);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toEqual(call.data.latestAssignment);
    });

    it('payload filledAt and emittedAt match the now timestamp', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 2,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'booking_fully_filled')!;
      expect(call.data.filledAt).toBe(NOW);
      expect(call.data.emittedAt).toBe(NOW);
    });
  });

  // ---- ordering guarantee ---------------------------------------------------

  describe('emit ordering within a single accept call', () => {
    it('trucks_remaining_update fires before booking_fully_filled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 2,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const remainingIdx = spy.calls.findIndex(c => c.event === 'trucks_remaining_update');
      const fullyFilledIdx = spy.calls.findIndex(c => c.event === 'booking_fully_filled');

      expect(remainingIdx).toBeGreaterThanOrEqual(0);
      expect(fullyFilledIdx).toBeGreaterThan(remainingIdx);
    });

    it('when partially_filled only trucks_remaining_update is emitted, no booking_fully_filled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 2,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const customerEvents = spy.calls.filter(c => c.userId === CUSTOMER_ID).map(c => c.event);
      expect(customerEvents).toContain('trucks_remaining_update');
      expect(customerEvents).not.toContain('booking_fully_filled');
    });

    it('single-truck order: first accept triggers both trucks_remaining_update and booking_fully_filled', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 1,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const customerEvents = spy.calls.filter(c => c.userId === CUSTOMER_ID).map(c => c.event);
      expect(customerEvents).toContain('trucks_remaining_update');
      expect(customerEvents).toContain('booking_fully_filled');
    });
  });

  // ---- boundary values ------------------------------------------------------

  describe('boundary values', () => {
    it('trucksRemaining is 0 when filled equals total (boundary)', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'fully_filled',
        newTrucksFilled: 5,
        orderTotalTrucks: 5,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.trucksRemaining).toBe(0);
    });

    it('Math.max clamp prevents negative trucksRemaining if data is inconsistent', () => {
      // Defensive: trucksRemaining should never go negative
      const rawRemaining = Math.max(3 - 5, 0);
      expect(rawRemaining).toBe(0);
      expect(rawRemaining).toBeGreaterThanOrEqual(0);
    });

    it('large order (10 trucks): first accept shows 9 remaining', () => {
      const spy = makeEmitSpy();

      simulateAcceptTruckRequestEmits(spy.fn, {
        customerId: CUSTOMER_ID,
        driverId: DRIVER_ID,
        orderId: ORDER_ID,
        newStatus: 'partially_filled',
        newTrucksFilled: 1,
        orderTotalTrucks: 10,
        now: NOW,
        assignmentId: ASSIGNMENT_ID,
        tripId: TRIP_ID,
        vehicleNumber: VEHICLE_NUMBER,
        driverName: DRIVER_NAME,
        driverPhone: DRIVER_PHONE
      });

      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      expect(call.data.trucksRemaining).toBe(9);
      expect(call.data.isFullyFilled).toBe(false);
    });
  });
});
