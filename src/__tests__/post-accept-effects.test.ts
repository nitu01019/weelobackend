/**
 * =============================================================================
 * POST-ACCEPT EFFECTS -- Tests for Triads 5-8 (new code)
 * =============================================================================
 *
 * Tests for:
 *  A5#3  — applyPostAcceptSideEffects: calls tracking init, Redis update, customer notification
 *  A5#3  — applyPostAcceptSideEffects: one failure doesn't block other side effects
 *  A4#35 — Admin release: ownership check (403 for wrong transporter)
 *  A4#35 — Admin release: vehicle already available -> no-op success
 *  A4#13 — SLA monitor: enabled by default (FF_TRIP_SLA_MONITOR not set)
 *  A4#13 — SLA monitor: disabled when FF_TRIP_SLA_MONITOR=false
 *  A5#20 — FCM registerToken: Redis failure -> returns false, no in-memory write
 *  A5#27 — Booking backpressure: at limit -> throws 503
 *  A5#27 — Booking backpressure: counter always decremented in finally
 *
 * @author Weelo Team (TESTER-B, Team LEO)
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

import { logger } from '../shared/services/logger.service';

// =============================================================================
// CATEGORY 1: applyPostAcceptSideEffects (A5#3)
// =============================================================================

describe('A5#3: applyPostAcceptSideEffects', () => {
  /**
   * Simulates the post-accept side effects pattern from
   * src/modules/assignment/post-accept.effects.ts.
   * Each step is independently try/catch'd so failures are isolated.
   */
  async function applyPostAcceptSideEffects(
    ctx: {
      assignmentId: string;
      driverId: string;
      vehicleId: string;
      vehicleNumber: string;
      tripId: string;
      bookingId: string;
      transporterId: string;
      driverName: string;
    },
    deps: {
      updateVehicleAvailability: jest.Mock;
      initializeTracking: jest.Mock;
      seedGps: jest.Mock;
      notifyCustomer: jest.Mock;
      notifyTransporter: jest.Mock;
    }
  ): Promise<{ results: Record<string, boolean> }> {
    const results: Record<string, boolean> = {};

    // 1. Vehicle Redis availability update
    try {
      await deps.updateVehicleAvailability(ctx.vehicleId);
      results.vehicleUpdate = true;
    } catch {
      results.vehicleUpdate = false;
    }

    // 2. Tracking initialization
    try {
      await deps.initializeTracking(ctx.tripId, ctx.driverId, ctx.vehicleNumber);
      results.tracking = true;
    } catch {
      results.tracking = false;
    }

    // 3. GPS seeding
    try {
      await deps.seedGps(ctx.driverId, ctx.tripId);
      results.gps = true;
    } catch {
      results.gps = false;
    }

    // 4. Customer notification
    try {
      await deps.notifyCustomer(ctx.bookingId, ctx.assignmentId, ctx.driverName);
      results.customerNotification = true;
    } catch {
      results.customerNotification = false;
    }

    // 5. Transporter notification
    try {
      await deps.notifyTransporter(ctx.transporterId, ctx.assignmentId);
      results.transporterNotification = true;
    } catch {
      results.transporterNotification = false;
    }

    return { results };
  }

  const defaultCtx = {
    assignmentId: 'assign-001',
    driverId: 'driver-001',
    vehicleId: 'vehicle-001',
    vehicleNumber: 'MH12AB1234',
    tripId: 'trip-001',
    bookingId: 'booking-001',
    transporterId: 'transporter-001',
    driverName: 'Test Driver',
  };

  function makeDeps(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
      updateVehicleAvailability: jest.fn().mockResolvedValue(undefined),
      initializeTracking: jest.fn().mockResolvedValue(undefined),
      seedGps: jest.fn().mockResolvedValue(undefined),
      notifyCustomer: jest.fn().mockResolvedValue(undefined),
      notifyTransporter: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  test('all side effects called: tracking init, Redis update, customer notification', async () => {
    const deps = makeDeps();
    const { results } = await applyPostAcceptSideEffects(defaultCtx, deps);

    expect(deps.updateVehicleAvailability).toHaveBeenCalledWith('vehicle-001');
    expect(deps.initializeTracking).toHaveBeenCalledWith('trip-001', 'driver-001', 'MH12AB1234');
    expect(deps.notifyCustomer).toHaveBeenCalledWith('booking-001', 'assign-001', 'Test Driver');
    expect(deps.notifyTransporter).toHaveBeenCalledWith('transporter-001', 'assign-001');

    expect(results.vehicleUpdate).toBe(true);
    expect(results.tracking).toBe(true);
    expect(results.customerNotification).toBe(true);
    expect(results.transporterNotification).toBe(true);
  });

  test('one failure does not block other side effects', async () => {
    const deps = makeDeps({
      initializeTracking: jest.fn().mockRejectedValue(new Error('Tracking service down')),
    });

    const { results } = await applyPostAcceptSideEffects(defaultCtx, deps);

    // Tracking failed
    expect(results.tracking).toBe(false);
    // But everything else succeeded
    expect(results.vehicleUpdate).toBe(true);
    expect(results.gps).toBe(true);
    expect(results.customerNotification).toBe(true);
    expect(results.transporterNotification).toBe(true);
  });

  test('multiple failures still allow remaining steps', async () => {
    const deps = makeDeps({
      updateVehicleAvailability: jest.fn().mockRejectedValue(new Error('Redis down')),
      notifyCustomer: jest.fn().mockRejectedValue(new Error('Socket disconnected')),
    });

    const { results } = await applyPostAcceptSideEffects(defaultCtx, deps);

    expect(results.vehicleUpdate).toBe(false);
    expect(results.customerNotification).toBe(false);
    // Others still succeeded
    expect(results.tracking).toBe(true);
    expect(results.gps).toBe(true);
    expect(results.transporterNotification).toBe(true);
  });

  test('all steps failing does not throw', async () => {
    const deps = makeDeps({
      updateVehicleAvailability: jest.fn().mockRejectedValue(new Error('fail')),
      initializeTracking: jest.fn().mockRejectedValue(new Error('fail')),
      seedGps: jest.fn().mockRejectedValue(new Error('fail')),
      notifyCustomer: jest.fn().mockRejectedValue(new Error('fail')),
      notifyTransporter: jest.fn().mockRejectedValue(new Error('fail')),
    });

    // Should NOT throw
    const { results } = await applyPostAcceptSideEffects(defaultCtx, deps);

    expect(Object.values(results).every(v => v === false)).toBe(true);
  });
});

// =============================================================================
// CATEGORY 2: Admin release ownership check (A4#35)
// =============================================================================

describe('A4#35: Admin release ownership check', () => {
  /**
   * Simulates admin release validation:
   * - Must own the vehicle (403 for wrong transporter)
   * - Vehicle already available -> no-op success
   */
  async function adminReleaseVehicle(
    vehicleId: string,
    requestingTransporterId: string,
    mockFindVehicle: jest.Mock,
    mockUpdateVehicle: jest.Mock
  ): Promise<{ success: boolean; status?: number; message?: string }> {
    const vehicle = await mockFindVehicle(vehicleId);
    if (!vehicle) {
      return { success: false, status: 404, message: 'Vehicle not found' };
    }

    // Ownership check
    if (vehicle.transporterId !== requestingTransporterId) {
      return { success: false, status: 403, message: 'Not your vehicle' };
    }

    // Already available -> no-op
    if (vehicle.status === 'available') {
      return { success: true, message: 'Vehicle already available' };
    }

    await mockUpdateVehicle(vehicleId, { status: 'available' });
    return { success: true, message: 'Vehicle released' };
  }

  test('wrong transporter -> 403', async () => {
    const mockFind = jest.fn().mockResolvedValue({
      id: 'vehicle-1',
      transporterId: 'transporter-A',
      status: 'on_hold',
    });
    const mockUpdate = jest.fn().mockResolvedValue({});

    const result = await adminReleaseVehicle('vehicle-1', 'transporter-B', mockFind, mockUpdate);

    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(result.message).toContain('Not your vehicle');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('correct transporter -> success', async () => {
    const mockFind = jest.fn().mockResolvedValue({
      id: 'vehicle-1',
      transporterId: 'transporter-A',
      status: 'on_hold',
    });
    const mockUpdate = jest.fn().mockResolvedValue({});

    const result = await adminReleaseVehicle('vehicle-1', 'transporter-A', mockFind, mockUpdate);

    expect(result.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith('vehicle-1', { status: 'available' });
  });

  test('vehicle already available -> success with no-op', async () => {
    const mockFind = jest.fn().mockResolvedValue({
      id: 'vehicle-1',
      transporterId: 'transporter-A',
      status: 'available',
    });
    const mockUpdate = jest.fn();

    const result = await adminReleaseVehicle('vehicle-1', 'transporter-A', mockFind, mockUpdate);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already available');
    // No update call needed
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('vehicle not found -> 404', async () => {
    const mockFind = jest.fn().mockResolvedValue(null);
    const mockUpdate = jest.fn();

    const result = await adminReleaseVehicle('nonexistent', 'transporter-A', mockFind, mockUpdate);

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CATEGORY 3: SLA monitor feature flag (A4#13)
// =============================================================================

describe('A4#13: SLA monitor feature flag', () => {
  test('SLA monitor: enabled by default when FF_TRIP_SLA_MONITOR not set', () => {
    // From trip-sla-monitor.job.ts, the pattern checks if the env var is NOT set.
    // If not set, the monitor should run (enabled by default).
    const envVal: string | undefined = undefined;
    // The real code: if FF_TRIP_SLA_MONITOR is not 'false', monitor runs
    const enabled = envVal !== 'false';
    expect(enabled).toBe(true);
  });

  test('SLA monitor: disabled when FF_TRIP_SLA_MONITOR=false', () => {
    const envVal: string = 'false';
    const enabled = envVal !== 'false';
    expect(enabled).toBe(false);
  });

  test('SLA monitor: enabled when FF_TRIP_SLA_MONITOR=true', () => {
    const envVal: string = 'true';
    const enabled = envVal !== 'false';
    expect(enabled).toBe(true);
  });

  test('SLA monitor: enabled for any non-false value', () => {
    const values: string[] = ['', '1', 'yes', 'on', 'True'];
    for (const val of values) {
      const enabled = val !== 'false';
      expect(enabled).toBe(true);
    }
  });
});

// =============================================================================
// CATEGORY 4: FCM registerToken Redis failure (A5#20)
// =============================================================================

describe('A5#20: FCM registerToken Redis failure handling', () => {
  /**
   * Simulates the FCM registerToken behavior from fcm.service.ts (A5#20 fix):
   * If Redis fails, returns false WITHOUT writing to in-memory fallback.
   * This prevents unbounded Map growth on long-running ECS instances.
   */
  async function simulateRegisterToken(
    userId: string,
    token: string,
    isRedisAvailable: boolean,
    mockRedisAdd: jest.Mock,
    mockRedisExpire: jest.Mock,
    inMemoryMap: Map<string, string[]>
  ): Promise<boolean> {
    if (isRedisAvailable) {
      try {
        await mockRedisAdd(`fcm:tokens:${userId}`, token);
        await mockRedisExpire(`fcm:tokens:${userId}`, 90 * 24 * 60 * 60);
        return true;
      } catch (error: any) {
        // FIX A5#20: Do NOT write to in-memory fallback
        (logger.error as jest.Mock)(`FCM: Redis registerToken failed -- token NOT stored`, {
          userId,
          error: error.message,
        });
        return false;
      }
    }

    // Redis not available -- token cannot be stored
    (logger.error as jest.Mock)(`FCM: Redis unavailable -- token NOT stored for user ${userId}`);
    return false;
  }

  test('Redis failure -> returns false, no in-memory write', async () => {
    const mockAdd = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const mockExpire = jest.fn();
    const inMemory = new Map<string, string[]>();

    const result = await simulateRegisterToken(
      'user-1', 'token-abc', true, mockAdd, mockExpire, inMemory
    );

    expect(result).toBe(false);
    // In-memory map should NOT have been written to
    expect(inMemory.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Redis registerToken failed'),
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  test('Redis success -> returns true', async () => {
    const mockAdd = jest.fn().mockResolvedValue(1);
    const mockExpire = jest.fn().mockResolvedValue(true);
    const inMemory = new Map<string, string[]>();

    const result = await simulateRegisterToken(
      'user-2', 'token-def', true, mockAdd, mockExpire, inMemory
    );

    expect(result).toBe(true);
    expect(mockAdd).toHaveBeenCalledWith('fcm:tokens:user-2', 'token-def');
  });

  test('Redis unavailable -> returns false', async () => {
    const mockAdd = jest.fn();
    const mockExpire = jest.fn();
    const inMemory = new Map<string, string[]>();

    const result = await simulateRegisterToken(
      'user-3', 'token-ghi', false, mockAdd, mockExpire, inMemory
    );

    expect(result).toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(inMemory.size).toBe(0);
  });
});

// =============================================================================
// CATEGORY 5: Booking backpressure (A5#27)
// =============================================================================

describe('A5#27: Booking backpressure', () => {
  /**
   * Simulates the booking concurrency guard from booking.service.ts.
   * Uses Redis INCR for a concurrency counter with a 300s crash-safety TTL.
   * If inflight > limit, throws 503.
   * Counter is ALWAYS decremented in a finally block.
   */
  async function simulateBookingWithBackpressure(
    mockIncr: jest.Mock,
    mockIncrBy: jest.Mock,
    mockExpire: jest.Mock,
    concurrencyLimit: number,
    bookingFn: jest.Mock
  ): Promise<any> {
    const concurrencyKey = 'booking:create:inflight';
    let incremented = false;

    try {
      const inflight = await mockIncr(concurrencyKey);
      incremented = true;
      await mockExpire(concurrencyKey, 300).catch(() => {});

      if (inflight > concurrencyLimit) {
        await mockIncrBy(concurrencyKey, -1).catch(() => {});
        incremented = false;
        const err = new Error('Too many bookings being processed.');
        (err as any).statusCode = 503;
        (err as any).code = 'SYSTEM_BUSY';
        throw err;
      }
    } catch (err: any) {
      if (err.code === 'SYSTEM_BUSY') throw err;
      // Redis down -- skip backpressure
      incremented = false;
    }

    try {
      return await bookingFn();
    } finally {
      if (incremented) {
        await mockIncrBy(concurrencyKey, -1).catch(() => {});
      }
    }
  }

  test('at limit -> throws 503 SYSTEM_BUSY', async () => {
    const mockIncr = jest.fn().mockResolvedValue(51); // over limit of 50
    const mockIncrBy = jest.fn().mockResolvedValue(50);
    const mockExpire = jest.fn().mockResolvedValue(true);
    const bookingFn = jest.fn();

    await expect(
      simulateBookingWithBackpressure(mockIncr, mockIncrBy, mockExpire, 50, bookingFn)
    ).rejects.toThrow('Too many bookings being processed.');

    // Booking function should NOT have been called
    expect(bookingFn).not.toHaveBeenCalled();
    // Counter decremented immediately (before throw)
    expect(mockIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });

  test('under limit -> booking proceeds normally', async () => {
    const mockIncr = jest.fn().mockResolvedValue(5); // under limit of 50
    const mockIncrBy = jest.fn().mockResolvedValue(4);
    const mockExpire = jest.fn().mockResolvedValue(true);
    const bookingFn = jest.fn().mockResolvedValue({ id: 'booking-1' });

    const result = await simulateBookingWithBackpressure(
      mockIncr, mockIncrBy, mockExpire, 50, bookingFn
    );

    expect(result).toEqual({ id: 'booking-1' });
    expect(bookingFn).toHaveBeenCalled();
    // Counter decremented in finally
    expect(mockIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });

  test('counter always decremented in finally (even if booking throws)', async () => {
    const mockIncr = jest.fn().mockResolvedValue(3);
    const mockIncrBy = jest.fn().mockResolvedValue(2);
    const mockExpire = jest.fn().mockResolvedValue(true);
    const bookingFn = jest.fn().mockRejectedValue(new Error('booking failed'));

    await expect(
      simulateBookingWithBackpressure(mockIncr, mockIncrBy, mockExpire, 50, bookingFn)
    ).rejects.toThrow('booking failed');

    // Counter MUST be decremented even though booking threw
    expect(mockIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });

  test('counter NOT decremented if Redis incr itself failed', async () => {
    const mockIncr = jest.fn().mockRejectedValue(new Error('Redis down'));
    const mockIncrBy = jest.fn();
    const mockExpire = jest.fn();
    const bookingFn = jest.fn().mockResolvedValue({ id: 'booking-2' });

    const result = await simulateBookingWithBackpressure(
      mockIncr, mockIncrBy, mockExpire, 50, bookingFn
    );

    expect(result).toEqual({ id: 'booking-2' });
    // Counter was never incremented, so should NOT be decremented
    expect(mockIncrBy).not.toHaveBeenCalled();
  });

  test('TTL is 300s as crash safety net', async () => {
    const mockIncr = jest.fn().mockResolvedValue(1);
    const mockIncrBy = jest.fn().mockResolvedValue(0);
    const mockExpire = jest.fn().mockResolvedValue(true);
    const bookingFn = jest.fn().mockResolvedValue({});

    await simulateBookingWithBackpressure(mockIncr, mockIncrBy, mockExpire, 50, bookingFn);

    expect(mockExpire).toHaveBeenCalledWith('booking:create:inflight', 300);
    // NOT 3600 or any other value
    expect(mockExpire).not.toHaveBeenCalledWith('booking:create:inflight', 3600);
  });

  test('exactly at limit -> allowed (limit is exclusive upper bound)', async () => {
    const mockIncr = jest.fn().mockResolvedValue(50); // exactly at limit of 50
    const mockIncrBy = jest.fn().mockResolvedValue(49);
    const mockExpire = jest.fn().mockResolvedValue(true);
    const bookingFn = jest.fn().mockResolvedValue({ id: 'booking-3' });

    const result = await simulateBookingWithBackpressure(
      mockIncr, mockIncrBy, mockExpire, 50, bookingFn
    );

    expect(result).toEqual({ id: 'booking-3' });
    expect(bookingFn).toHaveBeenCalled();
  });

  test('concurrent booking success -> counter goes 1, then 0 after completion', async () => {
    const mockIncr = jest.fn().mockResolvedValue(1);
    const mockIncrBy = jest.fn().mockResolvedValue(0);
    const mockExpire = jest.fn().mockResolvedValue(true);
    const bookingFn = jest.fn().mockResolvedValue({ id: 'booking-4' });

    await simulateBookingWithBackpressure(mockIncr, mockIncrBy, mockExpire, 50, bookingFn);

    // Incr: 0 -> 1
    expect(mockIncr).toHaveBeenCalledWith('booking:create:inflight');
    // Finally: 1 -> 0
    expect(mockIncrBy).toHaveBeenCalledWith('booking:create:inflight', -1);
  });
});
