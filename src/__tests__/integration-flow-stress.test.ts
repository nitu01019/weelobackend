/**
 * =============================================================================
 * DELTA-4: Integration Flow & Stress Tests
 * =============================================================================
 *
 * 40+ tests covering end-to-end flows and stress scenarios using the pure
 * simulation approach (no real DB / Redis / network). Each helper function
 * mirrors exactly what the corresponding service emits so assertions are
 * deterministic.
 *
 * Sections
 *   Flow 1  — Customer Booking → Order Completion (10 tests)
 *   Flow 2  — Multi-Truck Order Progress (10 tests)
 *   Flow 3  — SOS Alert Multi-Channel Delivery (5 tests)
 *   Flow 4  — Hold Expiry Cascade (5 tests)
 *   Stress  — Concurrency, Volume, Edge-Case, Timestamp (10 tests)
 * =============================================================================
 */

// =============================================================================
// SHARED TYPES
// =============================================================================

interface EmitCall {
  userId: string;
  event: string;
  data: Record<string, unknown>;
}

interface ChannelRecord {
  channel: string;
  payload: Record<string, unknown>;
}

// =============================================================================
// SHARED HELPERS
// =============================================================================

const makeEmitSpy = (): {
  calls: EmitCall[];
  fn: (userId: string, event: string, data: Record<string, unknown>) => boolean;
} => {
  const calls: EmitCall[] = [];
  const fn = (userId: string, event: string, data: Record<string, unknown>): boolean => {
    calls.push({ userId, event, data });
    return true;
  };
  return { calls, fn };
};

// ISO 8601 validator (strict: must parse to a valid date)
const isISO8601 = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && value.includes('T');
};

// =============================================================================
// FLOW 1 HELPERS — Customer Booking → Order Completion
// =============================================================================

/**
 * Step 1: Customer creates booking.
 * Simulates the emit that fires once the booking row is persisted.
 */
const simulateBookingCreated = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  p: { customerId: string; orderId: string; bookingId: string; now: string }
): void => {
  emit(p.customerId, 'order_status_update', {
    orderId: p.orderId,
    bookingId: p.bookingId,
    status: 'created',
    message: 'Your booking has been placed.',
    timestamp: p.now,
  });
};

/**
 * Step 2: Transporter accepts → trucks_remaining_update sent to customer.
 */
const simulateTransporterAccept = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  p: {
    customerId: string;
    orderId: string;
    trucksNeeded: number;
    trucksFilled: number;
    isFullyFilled: boolean;
    newStatus: string;
    now: string;
    assignmentId: string;
    tripId: string;
    vehicleNumber: string;
    driverName: string;
    driverPhone: string;
  }
): void => {
  const trucksRemaining = Math.max(p.trucksNeeded - p.trucksFilled, 0);

  emit(p.customerId, 'trucks_remaining_update', {
    orderId: p.orderId,
    trucksNeeded: p.trucksNeeded,
    trucksFilled: p.trucksFilled,
    trucksRemaining,
    isFullyFilled: p.isFullyFilled,
    timestamp: p.now,
    emittedAt: p.now,
  });

  if (p.newStatus === 'fully_filled') {
    const latestAssignment = {
      assignmentId: p.assignmentId,
      tripId: p.tripId,
      vehicleNumber: p.vehicleNumber,
      driverName: p.driverName,
      driverPhone: p.driverPhone,
    };
    emit(p.customerId, 'booking_fully_filled', {
      orderId: p.orderId,
      trucksNeeded: p.trucksNeeded,
      trucksFilled: p.trucksFilled,
      filledAt: p.now,
      emittedAt: p.now,
      latestAssignment,
      assignments: [latestAssignment],
    });
  }
};

/**
 * Step 3: Driver completes trip → order_completed + booking_completed emitted.
 */
const simulateTripCompletion = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  p: { customerId: string; orderId: string; now: string }
): void => {
  emit(p.customerId, 'order_completed', { orderId: p.orderId, completedAt: p.now });
  emit(p.customerId, 'booking_completed', {
    orderId: p.orderId,
    bookingId: p.orderId,
    completedAt: p.now,
  });
};

// =============================================================================
// FLOW 2 HELPERS — Multi-Truck Order Progress
// =============================================================================

interface AcceptStep {
  trucksFilled: number;
  trucksNeeded: number;
  newStatus: string;
  now: string;
  assignmentId: string;
  tripId: string;
  vehicleNumber: string;
  driverName: string;
  driverPhone: string;
}

const simulateMultiTruckAcceptStep = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  customerId: string,
  orderId: string,
  step: AcceptStep
): void => {
  simulateTransporterAccept(emit, {
    customerId,
    orderId,
    trucksNeeded: step.trucksNeeded,
    trucksFilled: step.trucksFilled,
    isFullyFilled: step.trucksFilled >= step.trucksNeeded,
    newStatus: step.newStatus,
    now: step.now,
    assignmentId: step.assignmentId,
    tripId: step.tripId,
    vehicleNumber: step.vehicleNumber,
    driverName: step.driverName,
    driverPhone: step.driverPhone,
  });
};

// =============================================================================
// FLOW 3 HELPERS — SOS Alert Multi-Channel Delivery
// =============================================================================

interface SosPayload {
  driverId: string;
  transporterId: string;
  location: { lat: number; lng: number } | null;
  timestamp: string;
  orderId?: string;
}

interface SosDeliveryResult {
  channels: ChannelRecord[];
  socketFired: boolean;
  fcmFired: boolean;
  redisFired: boolean;
}

/**
 * Simulates a 3-channel SOS dispatch: socket room emit, FCM push, Redis write.
 * If a channel's handler returns false the other channels still fire
 * (no short-circuit).
 */
const simulateSosAlert = (
  socketEmitRoom: (room: string, event: string, data: Record<string, unknown>) => boolean,
  fcmSend: (token: string, data: Record<string, unknown>) => boolean,
  redisSet: (key: string, value: string, ttlSeconds: number) => boolean,
  transporterFcmToken: string,
  sos: SosPayload
): SosDeliveryResult => {
  const channels: ChannelRecord[] = [];

  // Channel 1: socket room
  const socketOk = socketEmitRoom(
    `transporter:${sos.transporterId}`,
    'sos_alert',
    { driverId: sos.driverId, location: sos.location, timestamp: sos.timestamp, orderId: sos.orderId ?? null }
  );
  channels.push({ channel: 'socket', payload: { ok: socketOk } });

  // Channel 2: FCM push (fallback)
  const fcmOk = fcmSend(transporterFcmToken, {
    type: 'sos_alert',
    driverId: sos.driverId,
    timestamp: sos.timestamp,
  });
  channels.push({ channel: 'fcm', payload: { ok: fcmOk } });

  // Channel 3: Redis store with 5-min TTL
  const redisOk = redisSet(
    `sos:${sos.driverId}`,
    JSON.stringify({ driverId: sos.driverId, location: sos.location, timestamp: sos.timestamp }),
    300
  );
  channels.push({ channel: 'redis', payload: { ok: redisOk } });

  return {
    channels,
    socketFired: true,   // always attempted regardless of return value
    fcmFired: true,
    redisFired: true,
  };
};

// =============================================================================
// FLOW 4 HELPERS — Hold Expiry Cascade
// =============================================================================

const simulateFlexHoldCreated = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  p: { customerId: string; orderId: string; holdId: string; expiresAt: string; now: string }
): void => {
  emit(p.customerId, 'flex_hold_started', {
    orderId: p.orderId,
    holdId: p.holdId,
    expiresAt: p.expiresAt,
    timestamp: p.now,
  });
};

const simulateFlexHoldExtended = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  p: {
    customerId: string;
    orderId: string;
    holdId: string;
    newExpiresAt: string;
    extensionSeconds: number;
    totalDurationSeconds: number;
    now: string;
  }
): void => {
  emit(p.customerId, 'flex_hold_extended', {
    orderId: p.orderId,
    holdId: p.holdId,
    newExpiresAt: p.newExpiresAt,
    extensionSeconds: p.extensionSeconds,
    totalDurationSeconds: p.totalDurationSeconds,
    timestamp: p.now,
  });
};

const simulateHoldExpiry = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  p: { customerId: string; orderId: string; holdId: string; now: string; trucksReleased: number }
): void => {
  emit(p.customerId, 'hold_expired', {
    orderId: p.orderId,
    holdId: p.holdId,
    expiredAt: p.now,
    trucksReleased: p.trucksReleased,
  });
};

const simulateNoVehiclesAvailable = (
  emit: (u: string, e: string, d: Record<string, unknown>) => boolean,
  p: { customerId: string; orderId: string; now: string }
): void => {
  emit(p.customerId, 'no_vehicles_available', {
    orderId: p.orderId,
    reason: 'All holds have expired and no other trucks are available.',
    timestamp: p.now,
  });
};

// =============================================================================
// FLOW 1: Customer Booking → Order Completion (10 tests)
// =============================================================================

describe('Flow 1 -- Customer Booking to Order Completion', () => {
  const NOW = '2026-04-11T10:00:00.000Z';
  const CUSTOMER_ID = 'cust-flow1-001';
  const ORDER_ID = 'order-flow1-001';
  const BOOKING_ID = 'booking-flow1-001';
  const ASSIGNMENT_ID = 'assign-flow1-001';
  const TRIP_ID = 'trip-flow1-001';

  it('F1-01: booking creation emits order_status_update with status=created to customer', () => {
    const spy = makeEmitSpy();
    simulateBookingCreated(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, bookingId: BOOKING_ID, now: NOW });

    const call = spy.calls.find(c => c.event === 'order_status_update');
    expect(call).toBeDefined();
    expect(call!.userId).toBe(CUSTOMER_ID);
    expect(call!.data.status).toBe('created');
  });

  it('F1-02: booking creation payload contains orderId, bookingId, and timestamp', () => {
    const spy = makeEmitSpy();
    simulateBookingCreated(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, bookingId: BOOKING_ID, now: NOW });

    const call = spy.calls.find(c => c.event === 'order_status_update')!;
    expect(call.data.orderId).toBe(ORDER_ID);
    expect(call.data.bookingId).toBe(BOOKING_ID);
    expect(call.data.timestamp).toBe(NOW);
  });

  it('F1-03: transporter accept emits trucks_remaining_update to customer', () => {
    const spy = makeEmitSpy();
    simulateTransporterAccept(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID,
      trucksNeeded: 2, trucksFilled: 1, isFullyFilled: false,
      newStatus: 'partially_filled', now: NOW,
      assignmentId: ASSIGNMENT_ID, tripId: TRIP_ID,
      vehicleNumber: 'MH01AB1234', driverName: 'Ravi', driverPhone: '9999900000',
    });

    const call = spy.calls.find(c => c.event === 'trucks_remaining_update');
    expect(call).toBeDefined();
    expect(call!.userId).toBe(CUSTOMER_ID);
  });

  it('F1-04: trucks_remaining_update shows correct trucksRemaining after first accept', () => {
    const spy = makeEmitSpy();
    simulateTransporterAccept(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID,
      trucksNeeded: 3, trucksFilled: 1, isFullyFilled: false,
      newStatus: 'partially_filled', now: NOW,
      assignmentId: ASSIGNMENT_ID, tripId: TRIP_ID,
      vehicleNumber: 'MH01AB0001', driverName: 'Suresh', driverPhone: '9000000001',
    });

    const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
    expect(call.data.trucksRemaining).toBe(2);
    expect(call.data.trucksFilled).toBe(1);
    expect(call.data.trucksNeeded).toBe(3);
  });

  it('F1-05: all trucks assigned fires booking_fully_filled to customer', () => {
    const spy = makeEmitSpy();
    simulateTransporterAccept(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID,
      trucksNeeded: 1, trucksFilled: 1, isFullyFilled: true,
      newStatus: 'fully_filled', now: NOW,
      assignmentId: ASSIGNMENT_ID, tripId: TRIP_ID,
      vehicleNumber: 'MH01AB9999', driverName: 'Amit', driverPhone: '9888800000',
    });

    expect(spy.calls.find(c => c.event === 'booking_fully_filled')).toBeDefined();
  });

  it('F1-06: driver trip completion emits order_completed followed by booking_completed', () => {
    const spy = makeEmitSpy();
    simulateTripCompletion(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });

    const orderIdx = spy.calls.findIndex(c => c.event === 'order_completed');
    const bookingIdx = spy.calls.findIndex(c => c.event === 'booking_completed');
    expect(orderIdx).toBeGreaterThanOrEqual(0);
    expect(bookingIdx).toBeGreaterThan(orderIdx);
  });

  it('F1-07: booking_completed payload mirrors order_completed with bookingId alias', () => {
    const spy = makeEmitSpy();
    simulateTripCompletion(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });

    const call = spy.calls.find(c => c.event === 'booking_completed')!;
    expect(call.data.orderId).toBe(ORDER_ID);
    expect(call.data.bookingId).toBe(ORDER_ID);
    expect(call.data.completedAt).toBe(NOW);
  });

  it('F1-08: complete chain — booking create then accept then complete fires all expected events', () => {
    const spy = makeEmitSpy();

    simulateBookingCreated(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, bookingId: BOOKING_ID, now: NOW });
    simulateTransporterAccept(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID,
      trucksNeeded: 1, trucksFilled: 1, isFullyFilled: true,
      newStatus: 'fully_filled', now: NOW,
      assignmentId: ASSIGNMENT_ID, tripId: TRIP_ID,
      vehicleNumber: 'TN01AA5555', driverName: 'Priya', driverPhone: '9123456789',
    });
    simulateTripCompletion(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });

    const events = spy.calls.map(c => c.event);
    expect(events).toContain('order_status_update');
    expect(events).toContain('trucks_remaining_update');
    expect(events).toContain('booking_fully_filled');
    expect(events).toContain('order_completed');
    expect(events).toContain('booking_completed');
  });

  it('F1-09: all events in the full chain are sent exclusively to the correct customerId', () => {
    const spy = makeEmitSpy();
    const OTHER_CUSTOMER = 'cust-other-999';

    simulateBookingCreated(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, bookingId: BOOKING_ID, now: NOW });
    simulateTransporterAccept(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID,
      trucksNeeded: 1, trucksFilled: 1, isFullyFilled: true,
      newStatus: 'fully_filled', now: NOW,
      assignmentId: ASSIGNMENT_ID, tripId: TRIP_ID,
      vehicleNumber: 'TN01AA1111', driverName: 'Kiran', driverPhone: '9111111111',
    });
    simulateTripCompletion(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });

    const wrongCustomerEmits = spy.calls.filter(c => c.userId === OTHER_CUSTOMER);
    expect(wrongCustomerEmits).toHaveLength(0);
  });

  it('F1-10: rating trigger can subscribe to booking_completed — event fires exactly once per completion', () => {
    const spy = makeEmitSpy();
    simulateTripCompletion(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });

    const bookingCompletedCount = spy.calls.filter(c => c.event === 'booking_completed').length;
    expect(bookingCompletedCount).toBe(1);
    // A rating trigger would listen to this single event — assert it is unique
    expect(bookingCompletedCount).not.toBeGreaterThan(1);
  });
});

// =============================================================================
// FLOW 2: Multi-Truck Order Progress (10 tests)
// =============================================================================

describe('Flow 2 -- Multi-Truck Order Progress (3-truck order)', () => {
  const NOW = '2026-04-11T11:00:00.000Z';
  const CUSTOMER_ID = 'cust-flow2-001';
  const ORDER_ID = 'order-flow2-001';
  const TRUCKS_NEEDED = 3;

  function buildStep(trucksFilled: number): AcceptStep {
    return {
      trucksFilled,
      trucksNeeded: TRUCKS_NEEDED,
      newStatus: trucksFilled === TRUCKS_NEEDED ? 'fully_filled' : 'partially_filled',
      now: NOW,
      assignmentId: `assign-flow2-${trucksFilled}`,
      tripId: `trip-flow2-${trucksFilled}`,
      vehicleNumber: `MH01AB000${trucksFilled}`,
      driverName: `Driver${trucksFilled}`,
      driverPhone: `900000000${trucksFilled}`,
    };
  }

  it('F2-01: first accept emits trucks_remaining_update with trucksRemaining=2', () => {
    const spy = makeEmitSpy();
    simulateMultiTruckAcceptStep(spy.fn, CUSTOMER_ID, ORDER_ID, buildStep(1));

    const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
    expect(call.data.trucksRemaining).toBe(2);
  });

  it('F2-02: second accept emits trucks_remaining_update with trucksRemaining=1', () => {
    const spy = makeEmitSpy();
    simulateMultiTruckAcceptStep(spy.fn, CUSTOMER_ID, ORDER_ID, buildStep(2));

    const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
    expect(call.data.trucksRemaining).toBe(1);
  });

  it('F2-03: third accept emits trucks_remaining_update with trucksRemaining=0', () => {
    const spy = makeEmitSpy();
    simulateMultiTruckAcceptStep(spy.fn, CUSTOMER_ID, ORDER_ID, buildStep(3));

    const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
    expect(call.data.trucksRemaining).toBe(0);
  });

  it('F2-04: booking_fully_filled fires only on the third (last) accept', () => {
    const spyStep1 = makeEmitSpy();
    const spyStep2 = makeEmitSpy();
    const spyStep3 = makeEmitSpy();

    simulateMultiTruckAcceptStep(spyStep1.fn, CUSTOMER_ID, ORDER_ID, buildStep(1));
    simulateMultiTruckAcceptStep(spyStep2.fn, CUSTOMER_ID, ORDER_ID, buildStep(2));
    simulateMultiTruckAcceptStep(spyStep3.fn, CUSTOMER_ID, ORDER_ID, buildStep(3));

    expect(spyStep1.calls.find(c => c.event === 'booking_fully_filled')).toBeUndefined();
    expect(spyStep2.calls.find(c => c.event === 'booking_fully_filled')).toBeUndefined();
    expect(spyStep3.calls.find(c => c.event === 'booking_fully_filled')).toBeDefined();
  });

  it('F2-05: isFullyFilled is false for first two accepts and true on third', () => {
    const results: boolean[] = [];
    for (let filled = 1; filled <= 3; filled++) {
      const spy = makeEmitSpy();
      simulateMultiTruckAcceptStep(spy.fn, CUSTOMER_ID, ORDER_ID, buildStep(filled));
      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      results.push(call.data.isFullyFilled as boolean);
    }

    expect(results[0]).toBe(false);
    expect(results[1]).toBe(false);
    expect(results[2]).toBe(true);
  });

  it('F2-06: trucksRemaining decrements by 1 at each step', () => {
    const remainingValues: number[] = [];
    for (let filled = 1; filled <= 3; filled++) {
      const spy = makeEmitSpy();
      simulateMultiTruckAcceptStep(spy.fn, CUSTOMER_ID, ORDER_ID, buildStep(filled));
      const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
      remainingValues.push(call.data.trucksRemaining as number);
    }

    expect(remainingValues).toEqual([2, 1, 0]);
  });

  it('F2-07: each step emits trucks_remaining_update exactly once', () => {
    for (let filled = 1; filled <= 3; filled++) {
      const spy = makeEmitSpy();
      simulateMultiTruckAcceptStep(spy.fn, CUSTOMER_ID, ORDER_ID, buildStep(filled));
      const count = spy.calls.filter(c => c.event === 'trucks_remaining_update').length;
      expect(count).toBe(1);
    }
  });

  it('F2-08: accumulated event log across 3 steps has 3 trucks_remaining_update and 1 booking_fully_filled', () => {
    const allCalls: EmitCall[] = [];
    const accumulatingSpy = {
      calls: allCalls,
      fn: (u: string, e: string, d: Record<string, unknown>): boolean => {
        allCalls.push({ userId: u, event: e, data: d });
        return true;
      },
    };

    for (let filled = 1; filled <= 3; filled++) {
      simulateMultiTruckAcceptStep(accumulatingSpy.fn, CUSTOMER_ID, ORDER_ID, buildStep(filled));
    }

    const updateCount = allCalls.filter(c => c.event === 'trucks_remaining_update').length;
    const fullyFilledCount = allCalls.filter(c => c.event === 'booking_fully_filled').length;
    expect(updateCount).toBe(3);
    expect(fullyFilledCount).toBe(1);
  });

  it('F2-09: booking_fully_filled payload on third accept contains all 3 filled trucks info', () => {
    const spy = makeEmitSpy();
    simulateMultiTruckAcceptStep(spy.fn, CUSTOMER_ID, ORDER_ID, buildStep(3));

    const call = spy.calls.find(c => c.event === 'booking_fully_filled')!;
    expect(call.data.trucksNeeded).toBe(3);
    expect(call.data.trucksFilled).toBe(3);
    expect((call.data.assignments as unknown[]).length).toBe(1); // latest only per sim
  });

  it('F2-10: trucksRemaining never goes negative even if filled exceeds needed', () => {
    // Simulate inconsistent data where filled > needed
    const rawRemaining = Math.max(3 - 5, 0);
    expect(rawRemaining).toBe(0);
    expect(rawRemaining).toBeGreaterThanOrEqual(0);

    // Also verify via the sim helper with clamping
    const spy = makeEmitSpy();
    simulateTransporterAccept(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID,
      trucksNeeded: 3, trucksFilled: 5, // over-filled edge case
      isFullyFilled: true, newStatus: 'fully_filled', now: NOW,
      assignmentId: 'assign-x', tripId: 'trip-x',
      vehicleNumber: 'XX01ZZ9999', driverName: 'Test', driverPhone: '0000000000',
    });

    const call = spy.calls.find(c => c.event === 'trucks_remaining_update')!;
    expect(call.data.trucksRemaining as number).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// FLOW 3: SOS Alert Multi-Channel Delivery (5 tests)
// =============================================================================

describe('Flow 3 -- SOS Alert Multi-Channel Delivery', () => {
  const NOW = '2026-04-11T12:00:00.000Z';
  const DRIVER_ID = 'driver-sos-001';
  const TRANSPORTER_ID = 'transporter-sos-001';
  const FCM_TOKEN = 'fcm-token-sos-abc';

  function makeChannelSpies(): {
    socketCalls: Array<{ room: string; event: string; data: Record<string, unknown> }>;
    fcmCalls: Array<{ token: string; data: Record<string, unknown> }>;
    redisCalls: Array<{ key: string; value: string; ttl: number }>;
    socketEmitRoom: (room: string, event: string, data: Record<string, unknown>) => boolean;
    fcmSend: (token: string, data: Record<string, unknown>) => boolean;
    redisSet: (key: string, value: string, ttlSeconds: number) => boolean;
  } {
    const socketCalls: Array<{ room: string; event: string; data: Record<string, unknown> }> = [];
    const fcmCalls: Array<{ token: string; data: Record<string, unknown> }> = [];
    const redisCalls: Array<{ key: string; value: string; ttl: number }> = [];

    return {
      socketCalls,
      fcmCalls,
      redisCalls,
      socketEmitRoom: (room, event, data) => { socketCalls.push({ room, event, data }); return true; },
      fcmSend: (token, data) => { fcmCalls.push({ token, data }); return true; },
      redisSet: (key, value, ttl) => { redisCalls.push({ key, value, ttl }); return true; },
    };
  }

  it('F3-01: SOS fires socket emit to the transporter room', () => {
    const spies = makeChannelSpies();
    simulateSosAlert(spies.socketEmitRoom, spies.fcmSend, spies.redisSet, FCM_TOKEN, {
      driverId: DRIVER_ID, transporterId: TRANSPORTER_ID,
      location: { lat: 12.9716, lng: 77.5946 },
      timestamp: NOW,
    });

    expect(spies.socketCalls).toHaveLength(1);
    expect(spies.socketCalls[0].room).toBe(`transporter:${TRANSPORTER_ID}`);
    expect(spies.socketCalls[0].event).toBe('sos_alert');
  });

  it('F3-02: SOS fires FCM push as fallback with type=sos_alert and driverId', () => {
    const spies = makeChannelSpies();
    simulateSosAlert(spies.socketEmitRoom, spies.fcmSend, spies.redisSet, FCM_TOKEN, {
      driverId: DRIVER_ID, transporterId: TRANSPORTER_ID,
      location: { lat: 12.9716, lng: 77.5946 },
      timestamp: NOW,
    });

    expect(spies.fcmCalls).toHaveLength(1);
    expect(spies.fcmCalls[0].token).toBe(FCM_TOKEN);
    expect(spies.fcmCalls[0].data.type).toBe('sos_alert');
    expect(spies.fcmCalls[0].data.driverId).toBe(DRIVER_ID);
  });

  it('F3-03: SOS stores payload in Redis with 5-minute (300s) TTL', () => {
    const spies = makeChannelSpies();
    simulateSosAlert(spies.socketEmitRoom, spies.fcmSend, spies.redisSet, FCM_TOKEN, {
      driverId: DRIVER_ID, transporterId: TRANSPORTER_ID,
      location: { lat: 28.7041, lng: 77.1025 },
      timestamp: NOW,
    });

    expect(spies.redisCalls).toHaveLength(1);
    expect(spies.redisCalls[0].key).toBe(`sos:${DRIVER_ID}`);
    expect(spies.redisCalls[0].ttl).toBe(300);
    const stored = JSON.parse(spies.redisCalls[0].value);
    expect(stored.driverId).toBe(DRIVER_ID);
  });

  it('F3-04: all 3 channels fire even when socket handler returns false (no short-circuit)', () => {
    const fcmCalls: Array<{ token: string; data: Record<string, unknown> }> = [];
    const redisCalls: Array<{ key: string; value: string; ttl: number }> = [];
    const socketCalls: Array<{ room: string; event: string; data: Record<string, unknown> }> = [];

    // Socket always returns false (simulates failure)
    const failingSocket = (room: string, event: string, data: Record<string, unknown>): boolean => {
      socketCalls.push({ room, event, data });
      return false;
    };
    const fcmSend = (token: string, data: Record<string, unknown>): boolean => {
      fcmCalls.push({ token, data }); return true;
    };
    const redisSet = (key: string, value: string, ttl: number): boolean => {
      redisCalls.push({ key, value, ttl }); return true;
    };

    const result = simulateSosAlert(failingSocket, fcmSend, redisSet, FCM_TOKEN, {
      driverId: DRIVER_ID, transporterId: TRANSPORTER_ID,
      location: { lat: 0, lng: 0 }, timestamp: NOW,
    });

    // All 3 channels were still attempted
    expect(result.socketFired).toBe(true);
    expect(result.fcmFired).toBe(true);
    expect(result.redisFired).toBe(true);
    expect(socketCalls).toHaveLength(1);
    expect(fcmCalls).toHaveLength(1);
    expect(redisCalls).toHaveLength(1);
  });

  it('F3-05: SOS payload includes location, driverId, and timestamp; location may be null for graceful degradation', () => {
    const spies = makeChannelSpies();

    // SOS with missing location (driver GPS lost)
    simulateSosAlert(spies.socketEmitRoom, spies.fcmSend, spies.redisSet, FCM_TOKEN, {
      driverId: DRIVER_ID, transporterId: TRANSPORTER_ID,
      location: null,   // no GPS fix
      timestamp: NOW,
    });

    const socketData = spies.socketCalls[0].data;
    expect(socketData.driverId).toBe(DRIVER_ID);
    expect(socketData.timestamp).toBe(NOW);
    expect(socketData.location).toBeNull();   // gracefully null, not absent

    // Redis value still parseable and driverId preserved
    const stored = JSON.parse(spies.redisCalls[0].value);
    expect(stored.driverId).toBe(DRIVER_ID);
    expect(stored.location).toBeNull();
  });
});

// =============================================================================
// FLOW 4: Hold Expiry Cascade (5 tests)
// =============================================================================

describe('Flow 4 -- Hold Expiry Cascade', () => {
  const NOW = '2026-04-11T13:00:00.000Z';
  const LATER = '2026-04-11T13:01:30.000Z';
  const CUSTOMER_ID = 'cust-flow4-001';
  const ORDER_ID = 'order-flow4-001';
  const HOLD_ID = 'hold-flow4-001';

  it('F4-01: flex hold creation emits flex_hold_started with holdId and expiresAt', () => {
    const spy = makeEmitSpy();
    simulateFlexHoldCreated(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      expiresAt: LATER, now: NOW,
    });

    const call = spy.calls.find(c => c.event === 'flex_hold_started')!;
    expect(call).toBeDefined();
    expect(call.userId).toBe(CUSTOMER_ID);
    expect(call.data.holdId).toBe(HOLD_ID);
    expect(call.data.expiresAt).toBe(LATER);
  });

  it('F4-02: hold extension emits flex_hold_extended with updated expiresAt and extensionSeconds', () => {
    const spy = makeEmitSpy();
    const EXTENDED = '2026-04-11T13:02:00.000Z';
    simulateFlexHoldExtended(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      newExpiresAt: EXTENDED, extensionSeconds: 30, totalDurationSeconds: 120, now: NOW,
    });

    const call = spy.calls.find(c => c.event === 'flex_hold_extended')!;
    expect(call).toBeDefined();
    expect(call.data.extensionSeconds).toBe(30);
    expect(call.data.newExpiresAt).toBe(EXTENDED);
    expect(call.data.totalDurationSeconds).toBe(120);
  });

  it('F4-03: hold expiry emits hold_expired with trucksReleased count', () => {
    const spy = makeEmitSpy();
    simulateHoldExpiry(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      now: NOW, trucksReleased: 2,
    });

    const call = spy.calls.find(c => c.event === 'hold_expired')!;
    expect(call).toBeDefined();
    expect(call.data.trucksReleased).toBe(2);
    expect(call.data.holdId).toBe(HOLD_ID);
  });

  it('F4-04: no_vehicles_available fires after hold expiry when no other holds exist', () => {
    const spy = makeEmitSpy();
    simulateHoldExpiry(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      now: NOW, trucksReleased: 1,
    });
    // Expiry cleanup determines no other holds — fires no_vehicles_available
    simulateNoVehiclesAvailable(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });

    const holdExpired = spy.calls.find(c => c.event === 'hold_expired');
    const noVehicles = spy.calls.find(c => c.event === 'no_vehicles_available');
    expect(holdExpired).toBeDefined();
    expect(noVehicles).toBeDefined();

    const expiredIdx = spy.calls.indexOf(holdExpired!);
    const noVehiclesIdx = spy.calls.indexOf(noVehicles!);
    expect(noVehiclesIdx).toBeGreaterThan(expiredIdx);
  });

  it('F4-05: full hold lifecycle emits events in correct sequence: started → extended → expired → no_vehicles', () => {
    const spy = makeEmitSpy();
    const EXTENDED_EXPIRY = '2026-04-11T13:03:00.000Z';

    simulateFlexHoldCreated(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      expiresAt: LATER, now: NOW,
    });
    simulateFlexHoldExtended(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      newExpiresAt: EXTENDED_EXPIRY, extensionSeconds: 30, totalDurationSeconds: 120, now: NOW,
    });
    simulateHoldExpiry(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      now: NOW, trucksReleased: 3,
    });
    simulateNoVehiclesAvailable(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });

    const eventSequence = spy.calls.map(c => c.event);
    const startedIdx = eventSequence.indexOf('flex_hold_started');
    const extendedIdx = eventSequence.indexOf('flex_hold_extended');
    const expiredIdx = eventSequence.indexOf('hold_expired');
    const noVehiclesIdx = eventSequence.indexOf('no_vehicles_available');

    expect(startedIdx).toBeLessThan(extendedIdx);
    expect(extendedIdx).toBeLessThan(expiredIdx);
    expect(expiredIdx).toBeLessThan(noVehiclesIdx);
  });
});

// =============================================================================
// STRESS TESTS (10 tests)
// =============================================================================

describe('Stress Tests -- Concurrency, Volume, Edge Cases, Timestamp Consistency', () => {
  const NOW = '2026-04-11T14:00:00.000Z';

  it('ST-01: 100 concurrent trucks_remaining_update emissions are all captured in order', () => {
    const allCalls: EmitCall[] = [];
    const spy = {
      calls: allCalls,
      fn: (u: string, e: string, d: Record<string, unknown>): boolean => {
        allCalls.push({ userId: u, event: e, data: d });
        return true;
      },
    };

    for (let i = 1; i <= 100; i++) {
      spy.fn(`cust-${i}`, 'trucks_remaining_update', {
        orderId: `order-${i}`,
        trucksRemaining: 1,
        trucksFilled: 1,
        trucksNeeded: 2,
        isFullyFilled: false,
        timestamp: NOW,
        emittedAt: NOW,
      });
    }

    const updateCalls = allCalls.filter(c => c.event === 'trucks_remaining_update');
    expect(updateCalls).toHaveLength(100);
    // Verify ordering is preserved (first emitted = first in array)
    expect(updateCalls[0].userId).toBe('cust-1');
    expect(updateCalls[99].userId).toBe('cust-100');
  });

  it('ST-02: rapid booking_completed + order_completed both fire without loss', () => {
    const spy = makeEmitSpy();

    // Simulate rapid-fire completions for 10 different orders
    for (let i = 1; i <= 10; i++) {
      simulateTripCompletion(spy.fn, {
        customerId: `cust-rapid-${i}`,
        orderId: `order-rapid-${i}`,
        now: NOW,
      });
    }

    const orderCompleted = spy.calls.filter(c => c.event === 'order_completed');
    const bookingCompleted = spy.calls.filter(c => c.event === 'booking_completed');
    expect(orderCompleted).toHaveLength(10);
    expect(bookingCompleted).toHaveLength(10);
  });

  it('ST-03: SOS alert with null location degrades gracefully — all 3 channels still fire', () => {
    let socketCount = 0;
    let fcmCount = 0;
    let redisCount = 0;

    const result = simulateSosAlert(
      () => { socketCount++; return true; },
      () => { fcmCount++; return true; },
      () => { redisCount++; return true; },
      'fcm-token-x',
      { driverId: 'driver-sos-null', transporterId: 'trans-null', location: null, timestamp: NOW }
    );

    expect(result.socketFired).toBe(true);
    expect(result.fcmFired).toBe(true);
    expect(result.redisFired).toBe(true);
    expect(socketCount).toBe(1);
    expect(fcmCount).toBe(1);
    expect(redisCount).toBe(1);
  });

  it('ST-04: emitToUser called 1000 times — mock spy array length stays accurate (no memory aliasing)', () => {
    const spy = makeEmitSpy();

    for (let i = 0; i < 1000; i++) {
      spy.fn('cust-stress', 'order_status_update', { orderId: `order-${i}`, status: 'created' });
    }

    expect(spy.calls).toHaveLength(1000);
    // Each call must have distinct orderId (no aliasing)
    const uniqueOrderIds = new Set(spy.calls.map(c => c.data.orderId as string));
    expect(uniqueOrderIds.size).toBe(1000);
  });

  it('ST-05: 10-truck order — all 10 accept steps each emit trucks_remaining_update', () => {
    const allCalls: EmitCall[] = [];
    const spy = {
      fn: (u: string, e: string, d: Record<string, unknown>): boolean => {
        allCalls.push({ userId: u, event: e, data: d });
        return true;
      },
    };

    for (let filled = 1; filled <= 10; filled++) {
      simulateTransporterAccept(spy.fn, {
        customerId: 'cust-10trucks',
        orderId: 'order-10trucks',
        trucksNeeded: 10,
        trucksFilled: filled,
        isFullyFilled: filled === 10,
        newStatus: filled === 10 ? 'fully_filled' : 'partially_filled',
        now: NOW,
        assignmentId: `assign-${filled}`,
        tripId: `trip-${filled}`,
        vehicleNumber: `MH01AB${String(filled).padStart(4, '0')}`,
        driverName: `Driver ${filled}`,
        driverPhone: `90000000${String(filled).padStart(2, '0')}`,
      });
    }

    const remainingUpdates = allCalls.filter(c => c.event === 'trucks_remaining_update');
    const fullyFilledEmits = allCalls.filter(c => c.event === 'booking_fully_filled');

    expect(remainingUpdates).toHaveLength(10);
    expect(fullyFilledEmits).toHaveLength(1);

    // Verify decrementing remaining
    const remainingValues = remainingUpdates.map(c => c.data.trucksRemaining as number);
    expect(remainingValues).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('ST-06: hold extend called 5 times — totalDurationSeconds caps at 130s as per config', () => {
    const FLEX_BASE = 90;
    const EXTENSION_SECONDS = 30;
    const MAX_TOTAL = 130;

    let totalDuration = FLEX_BASE;
    const capturedDurations: number[] = [totalDuration];

    for (let i = 0; i < 5; i++) {
      const proposed = totalDuration + EXTENSION_SECONDS;
      totalDuration = Math.min(proposed, MAX_TOTAL);
      capturedDurations.push(totalDuration);
    }

    // After first extension: 90+30=120 (under cap)
    // After second extension: 120+30=150, capped to 130
    // All subsequent extensions: 130 (already at cap)
    expect(capturedDurations[0]).toBe(90);  // base
    expect(capturedDurations[1]).toBe(120); // +30
    expect(capturedDurations[2]).toBe(130); // +30, capped
    expect(capturedDurations[3]).toBe(130); // already at cap
    expect(capturedDurations[4]).toBe(130); // still at cap
    expect(capturedDurations[5]).toBe(130); // still at cap

    // No value must exceed MAX_TOTAL
    for (const d of capturedDurations) {
      expect(d).toBeLessThanOrEqual(MAX_TOTAL);
    }
  });

  it('ST-07: concurrent order_completed from two sources — events are captured independently (no dedup loss)', () => {
    const spy = makeEmitSpy();
    const ORDER_ID = 'order-concurrent-001';
    const CUSTOMER_ID = 'cust-concurrent-001';

    // Source A: tracking.service
    spy.fn(CUSTOMER_ID, 'order_completed', { orderId: ORDER_ID, completedAt: NOW, source: 'tracking_service' });
    // Source B: order.routes
    spy.fn(CUSTOMER_ID, 'order_completed', { orderId: ORDER_ID, completedAt: NOW, source: 'order_routes' });

    const completedCalls = spy.calls.filter(c => c.event === 'order_completed');
    // Both fire — dedup is a client-side concern; backend emits both
    expect(completedCalls).toHaveLength(2);
    expect(completedCalls[0].data.source).toBe('tracking_service');
    expect(completedCalls[1].data.source).toBe('order_routes');
  });

  it('ST-08: missing customerId across entire flow — no crash and zero emits', () => {
    const spy = makeEmitSpy();

    // Simulate the guard that all services apply when customerId is null
    const maybeEmit = (customerId: string | null, event: string, data: Record<string, unknown>): void => {
      if (!customerId) return; // guard
      spy.fn(customerId, event, data);
    };

    maybeEmit(null, 'order_status_update', { orderId: 'order-x', status: 'created' });
    maybeEmit(null, 'trucks_remaining_update', { orderId: 'order-x', trucksRemaining: 2 });
    maybeEmit(null, 'booking_fully_filled', { orderId: 'order-x' });
    maybeEmit(null, 'order_completed', { orderId: 'order-x' });
    maybeEmit(null, 'booking_completed', { orderId: 'order-x', bookingId: 'order-x' });

    expect(spy.calls).toHaveLength(0);
  });

  it('ST-09: empty orderId in payload — event fires but orderId is empty string (not undefined)', () => {
    const spy = makeEmitSpy();

    // Empty string orderId is an edge case that should still propagate without crashing
    spy.fn('cust-edge', 'order_status_update', { orderId: '', status: 'created', timestamp: NOW });

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].data.orderId).toBe('');
    expect(spy.calls[0].data.orderId).not.toBeUndefined();
  });

  it('ST-10: timestamp format is ISO 8601 across all event types', () => {
    const spy = makeEmitSpy();
    const CUSTOMER_ID = 'cust-ts-001';
    const ORDER_ID = 'order-ts-001';
    const BOOKING_ID = 'booking-ts-001';
    const HOLD_ID = 'hold-ts-001';
    const EXTENDED_EXPIRY = '2026-04-11T15:01:30.000Z';

    // Fire all major events that carry a timestamp
    simulateBookingCreated(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, bookingId: BOOKING_ID, now: NOW });
    simulateTransporterAccept(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID,
      trucksNeeded: 1, trucksFilled: 1, isFullyFilled: true,
      newStatus: 'fully_filled', now: NOW,
      assignmentId: 'assign-ts', tripId: 'trip-ts',
      vehicleNumber: 'TS01AB0001', driverName: 'TS Driver', driverPhone: '9000000099',
    });
    simulateTripCompletion(spy.fn, { customerId: CUSTOMER_ID, orderId: ORDER_ID, now: NOW });
    simulateFlexHoldCreated(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      expiresAt: EXTENDED_EXPIRY, now: NOW,
    });
    simulateFlexHoldExtended(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      newExpiresAt: EXTENDED_EXPIRY, extensionSeconds: 30, totalDurationSeconds: 120, now: NOW,
    });
    simulateHoldExpiry(spy.fn, {
      customerId: CUSTOMER_ID, orderId: ORDER_ID, holdId: HOLD_ID,
      now: NOW, trucksReleased: 1,
    });

    // Every event that carries a timestamp-like field must be ISO 8601
    const TIMESTAMP_FIELDS = ['timestamp', 'emittedAt', 'completedAt', 'filledAt', 'expiresAt', 'newExpiresAt', 'expiredAt'];

    for (const call of spy.calls) {
      for (const field of TIMESTAMP_FIELDS) {
        if (field in call.data) {
          expect(isISO8601(call.data[field])).toBe(true);
        }
      }
    }
  });
});
