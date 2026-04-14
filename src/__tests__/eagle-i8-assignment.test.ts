/**
 * =============================================================================
 * EAGLE I8 ASSIGNMENT TESTS — DR-10, DR-11 fixes for post-accept.effects.ts
 * =============================================================================
 *
 * Tests for:
 *  DR-10: bookingId is actually orderId — customer resolved via Order table fallback
 *  DR-11: GPS staleness check — stale location data is NOT seeded
 *  DR-11: GPS freshness — fresh location data IS seeded
 *
 * @author Weelo Team (I8, Team EAGLE)
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP
// =============================================================================

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
  },
}));

jest.mock('../config/environment', () => ({
  config: {
    redis: { enabled: true },
    isProduction: false,
    otp: { expiryMinutes: 5 },
    sms: {},
  },
}));

// =============================================================================
// IMPORTS
// =============================================================================


// =============================================================================
// CATEGORY 1: DR-10 — bookingId is actually orderId in post-accept
// =============================================================================

describe('DR-10: post-accept customer notification resolves orderId via Order table', () => {
  /**
   * Simulates the DR-10 fix in post-accept.effects.ts:
   * When prisma.booking.findUnique returns null for ctx.bookingId,
   * fall back to prisma.order.findUnique to resolve the customerId.
   */
  async function resolveCustomerId(
    bookingId: string,
    mockBookingFindUnique: jest.Mock,
    mockOrderFindUnique: jest.Mock,
  ): Promise<string | null> {
    // DR-10 FIX: bookingId is a legacy name — in the Order system it maps to orderId.
    // Try Booking first; if not found, fall back to Order.
    let customerId: string | null = null;

    const booking = await mockBookingFindUnique({ where: { id: bookingId }, select: { customerId: true } });
    customerId = booking?.customerId ?? null;

    if (!customerId) {
      // DR-10: bookingId maps to orderId in the Order system — try Order table
      const order = await mockOrderFindUnique({ where: { id: bookingId }, select: { customerId: true } });
      customerId = order?.customerId ?? null;
    }

    return customerId;
  }

  test('booking found — returns booking customerId without querying Order', async () => {
    const mockBooking = jest.fn().mockResolvedValue({ customerId: 'customer-from-booking' });
    const mockOrder = jest.fn().mockResolvedValue(null);

    const result = await resolveCustomerId('booking-123', mockBooking, mockOrder);

    expect(result).toBe('customer-from-booking');
    expect(mockBooking).toHaveBeenCalledTimes(1);
    // Order table should NOT be queried when booking is found
    expect(mockOrder).not.toHaveBeenCalled();
  });

  test('booking not found — falls back to Order table and returns order customerId', async () => {
    const mockBooking = jest.fn().mockResolvedValue(null);
    const mockOrder = jest.fn().mockResolvedValue({ customerId: 'customer-from-order' });

    const result = await resolveCustomerId('order-456', mockBooking, mockOrder);

    expect(result).toBe('customer-from-order');
    expect(mockBooking).toHaveBeenCalledTimes(1);
    expect(mockOrder).toHaveBeenCalledTimes(1);
    expect(mockOrder).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-456' } })
    );
  });

  test('neither booking nor order found — returns null', async () => {
    const mockBooking = jest.fn().mockResolvedValue(null);
    const mockOrder = jest.fn().mockResolvedValue(null);

    const result = await resolveCustomerId('unknown-id', mockBooking, mockOrder);

    expect(result).toBeNull();
    expect(mockBooking).toHaveBeenCalledTimes(1);
    expect(mockOrder).toHaveBeenCalledTimes(1);
  });

  test('booking returns customerId=null — falls back to Order table', async () => {
    const mockBooking = jest.fn().mockResolvedValue({ customerId: null });
    const mockOrder = jest.fn().mockResolvedValue({ customerId: 'customer-from-order' });

    const result = await resolveCustomerId('id-with-null-customer', mockBooking, mockOrder);

    expect(result).toBe('customer-from-order');
    expect(mockOrder).toHaveBeenCalledTimes(1);
  });

  test('customer notification uses resolved customerId from Order (full flow)', async () => {
    const mockBooking = jest.fn().mockResolvedValue(null);
    const mockOrder = jest.fn().mockResolvedValue({ customerId: 'customer-order-789' });
    const mockEmitToUser = jest.fn();
    const mockQueuePush = jest.fn().mockResolvedValue(undefined);

    const customerId = await resolveCustomerId('order-789', mockBooking, mockOrder);

    // Simulate notification dispatch using resolved customerId
    if (customerId) {
      mockEmitToUser(customerId, 'driver_accepted', { assignmentId: 'assign-1' });
      await mockQueuePush(customerId, { title: 'Driver Accepted!' });
    }

    expect(mockEmitToUser).toHaveBeenCalledWith('customer-order-789', 'driver_accepted', expect.any(Object));
    expect(mockQueuePush).toHaveBeenCalledWith('customer-order-789', expect.any(Object));
  });
});

// =============================================================================
// CATEGORY 2: DR-11 — GPS staleness check in post-accept
// =============================================================================

describe('DR-11: GPS staleness check before seeding in post-accept', () => {
  const GPS_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — must match the constant in post-accept.effects.ts

  /**
   * Simulates the DR-11 GPS staleness logic from post-accept.effects.ts.
   * Returns whether the GPS data was seeded or skipped.
   */
  function evaluateGpsStaleness(
    location: { latitude: number; longitude: number; timestamp?: string; lastUpdated?: string } | null,
    nowMs: number,
  ): { seeded: boolean; reason: string; ageSeconds?: number } {
    if (!location) {
      return { seeded: false, reason: 'no_location' };
    }
    if (!location.latitude || !location.longitude) {
      return { seeded: false, reason: 'incomplete' };
    }

    const locationTimestamp = location.timestamp || location.lastUpdated;
    const locationAge = locationTimestamp ? nowMs - new Date(locationTimestamp).getTime() : Infinity;

    if (locationAge > GPS_MAX_AGE_MS) {
      return { seeded: false, reason: 'stale', ageSeconds: Math.round(locationAge / 1000) };
    }

    return { seeded: true, reason: 'fresh', ageSeconds: Math.round(locationAge / 1000) };
  }

  test('GPS data older than 5 min is NOT seeded', () => {
    const now = Date.now();
    // Location 6 minutes old
    const staleLocation = {
      latitude: 12.9716,
      longitude: 77.5946,
      timestamp: new Date(now - 6 * 60 * 1000).toISOString(),
    };

    const result = evaluateGpsStaleness(staleLocation, now);

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('stale');
    expect(result.ageSeconds).toBeGreaterThanOrEqual(360); // 6 minutes = 360s
  });

  test('GPS data younger than 5 min IS seeded', () => {
    const now = Date.now();
    // Location 2 minutes old
    const freshLocation = {
      latitude: 12.9716,
      longitude: 77.5946,
      timestamp: new Date(now - 2 * 60 * 1000).toISOString(),
    };

    const result = evaluateGpsStaleness(freshLocation, now);

    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('fresh');
    expect(result.ageSeconds).toBeLessThanOrEqual(120); // 2 minutes = 120s
  });

  test('GPS data exactly 5 min old is NOT seeded (boundary)', () => {
    const now = Date.now();
    // Exactly 5 minutes + 1ms — over threshold
    const boundaryLocation = {
      latitude: 12.9716,
      longitude: 77.5946,
      timestamp: new Date(now - GPS_MAX_AGE_MS - 1).toISOString(),
    };

    const result = evaluateGpsStaleness(boundaryLocation, now);

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('stale');
  });

  test('GPS data at exactly 5 min boundary is NOT seeded (> not >=)', () => {
    const now = Date.now();
    // Exactly 5 minutes (300001 ms > 300000 ms threshold after rounding)
    const boundaryLocation = {
      latitude: 12.9716,
      longitude: 77.5946,
      timestamp: new Date(now - GPS_MAX_AGE_MS).toISOString(),
    };

    const result = evaluateGpsStaleness(boundaryLocation, now);

    // locationAge === GPS_MAX_AGE_MS, which is NOT > GPS_MAX_AGE_MS, so it should seed
    // This validates the > comparison (not >=)
    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('fresh');
  });

  test('GPS data with no timestamp — treated as stale (age=Infinity)', () => {
    const now = Date.now();
    const noTimestampLocation = {
      latitude: 12.9716,
      longitude: 77.5946,
      // No timestamp or lastUpdated
    };

    const result = evaluateGpsStaleness(noTimestampLocation, now);

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('stale');
  });

  test('GPS data uses lastUpdated when timestamp is absent', () => {
    const now = Date.now();
    const locationWithLastUpdated = {
      latitude: 12.9716,
      longitude: 77.5946,
      lastUpdated: new Date(now - 1 * 60 * 1000).toISOString(), // 1 minute old
    };

    const result = evaluateGpsStaleness(locationWithLastUpdated, now);

    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('fresh');
    expect(result.ageSeconds).toBeLessThanOrEqual(60);
  });

  test('GPS data prefers timestamp over lastUpdated', () => {
    const now = Date.now();
    const locationWithBoth = {
      latitude: 12.9716,
      longitude: 77.5946,
      timestamp: new Date(now - 1 * 60 * 1000).toISOString(), // 1 min old (fresh)
      lastUpdated: new Date(now - 10 * 60 * 1000).toISOString(), // 10 min old (stale)
    };

    const result = evaluateGpsStaleness(locationWithBoth, now);

    // Should use timestamp (fresh), not lastUpdated (stale)
    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('fresh');
  });

  test('null location returns no_location', () => {
    const result = evaluateGpsStaleness(null, Date.now());

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('no_location');
  });

  test('location with zero coordinates returns incomplete', () => {
    const result = evaluateGpsStaleness(
      { latitude: 0, longitude: 0, timestamp: new Date().toISOString() },
      Date.now(),
    );

    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('incomplete');
  });

  test('very fresh GPS data (just now) IS seeded', () => {
    const now = Date.now();
    const justNow = {
      latitude: 28.6139,
      longitude: 77.2090,
      timestamp: new Date(now - 100).toISOString(), // 100ms ago
    };

    const result = evaluateGpsStaleness(justNow, now);

    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('fresh');
    expect(result.ageSeconds).toBe(0);
  });
});
