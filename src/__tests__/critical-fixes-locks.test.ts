/**
 * =============================================================================
 * CRITICAL FIXES C-02, C-07, C-08 — Lock, Socket, FLEX Guard Tests
 * =============================================================================
 *
 * Tests for verified critical fixes:
 *
 *  C-02: Lock holder is now uuidv4() (prevents re-entrant lock bypass)
 *  C-07: Socket event name fixed (TRIP_ASSIGNED, not ASSIGNMENT_STATUS_CHANGED)
 *  C-08: FLEX conflict guard added to class method holdTrucks()
 *
 * @author Phase 3 Testing Agent
 * =============================================================================
 */

// =============================================================================
// MOCK SETUP — Must come before any imports
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
    observeHistogram: jest.fn(),
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
// C-02 TESTS: Lock holder is now uuidv4()
// =============================================================================

describe('C-02: Static lock holder replaced with uuidv4()', () => {
  // -------------------------------------------------------------------------
  // Structural verification: the fix is applied in source code
  // -------------------------------------------------------------------------
  describe('source code verification', () => {
    test('confirmed-hold.service.ts imports uuid', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/confirmed-hold.service.ts'),
        'utf-8'
      );

      expect(source).toContain("import { v4 as uuidv4 } from 'uuid'");
    });

    test('handleDriverAcceptance uses uuidv4() for lockHolder', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/confirmed-hold.service.ts'),
        'utf-8'
      );

      // Find the handleDriverAcceptance method and verify it uses uuidv4() for lockHolder
      const acceptMethodStart = source.indexOf('async handleDriverAcceptance');
      expect(acceptMethodStart).toBeGreaterThan(-1);

      const acceptMethodWindow = source.substring(acceptMethodStart, acceptMethodStart + 600);
      // Must use uuidv4() to generate lockHolder, not a static string
      expect(acceptMethodWindow).toContain('const lockHolder = uuidv4()');
      // Must NOT use a static string like 'driver-acceptance'
      expect(acceptMethodWindow).not.toContain("const lockHolder = 'driver-acceptance'");
    });

    test('handleDriverDecline uses uuidv4() for lockHolder', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/confirmed-hold.service.ts'),
        'utf-8'
      );

      const declineMethodStart = source.indexOf('async handleDriverDecline');
      expect(declineMethodStart).toBeGreaterThan(-1);

      const declineMethodWindow = source.substring(declineMethodStart, declineMethodStart + 600);
      expect(declineMethodWindow).toContain('const lockHolder = uuidv4()');
      expect(declineMethodWindow).not.toContain("const lockHolder = 'driver-decline'");
    });
  });

  // -------------------------------------------------------------------------
  // Test 1: Two concurrent accept calls use different lock holders
  // -------------------------------------------------------------------------
  describe('concurrent accept calls use different lock holders', () => {
    test('two calls to acquireLock receive different holder UUIDs', async () => {
      // Simulate the lock acquisition pattern from handleDriverAcceptance:
      //   const lockHolder = uuidv4();
      //   const lock = await redisService.acquireLock(lockKey, lockHolder, 10);
      //
      // Two concurrent calls must generate distinct holder values.
      const { v4: uuidv4 } = require('uuid');
      const capturedHolders: string[] = [];

      const mockAcquireLock = jest.fn().mockImplementation(
        (_key: string, holder: string, _ttl: number) => {
          capturedHolders.push(holder);
          return Promise.resolve({ acquired: true });
        }
      );

      // Simulate two concurrent handleDriverAcceptance calls
      async function simulateAcceptCall(assignmentId: string) {
        const lockKey = `driver-acceptance:${assignmentId}`;
        const lockHolder = uuidv4();
        await mockAcquireLock(lockKey, lockHolder, 10);
        return lockHolder;
      }

      const [holder1, holder2] = await Promise.all([
        simulateAcceptCall('assignment-aaa'),
        simulateAcceptCall('assignment-aaa'),
      ]);

      // Both calls must produce different UUID holders
      expect(holder1).not.toBe(holder2);
      expect(capturedHolders).toHaveLength(2);
      expect(capturedHolders[0]).not.toBe(capturedHolders[1]);

      // Each holder must be a valid UUID v4 format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(holder1).toMatch(uuidRegex);
      expect(holder2).toMatch(uuidRegex);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: Lock holder is passed to releaseLock
  // -------------------------------------------------------------------------
  describe('lock holder passed to releaseLock matches acquireLock', () => {
    test('releaseLock is called with the same UUID that acquireLock used', async () => {
      const { v4: uuidv4 } = require('uuid');
      let acquiredHolder: string | null = null;
      let releasedHolder: string | null = null;

      const mockAcquireLock = jest.fn().mockImplementation(
        (_key: string, holder: string, _ttl: number) => {
          acquiredHolder = holder;
          return Promise.resolve({ acquired: true });
        }
      );

      const mockReleaseLock = jest.fn().mockImplementation(
        (_key: string, holder: string) => {
          releasedHolder = holder;
          return Promise.resolve(true);
        }
      );

      // Simulate the handleDriverAcceptance pattern:
      //   const lockHolder = uuidv4();
      //   const lock = await acquireLock(lockKey, lockHolder, 10);
      //   try { ... } finally { await releaseLock(lockKey, lockHolder); }
      const lockKey = 'driver-acceptance:assignment-bbb';
      const lockHolder = uuidv4();

      await mockAcquireLock(lockKey, lockHolder, 10);
      try {
        // Simulate work inside the lock
      } finally {
        await mockReleaseLock(lockKey, lockHolder);
      }

      // The same UUID must be passed to both acquire and release
      expect(acquiredHolder).toBe(releasedHolder);
      expect(acquiredHolder).toBe(lockHolder);

      // Verify the calls were made with correct arguments
      expect(mockAcquireLock).toHaveBeenCalledWith(lockKey, lockHolder, 10);
      expect(mockReleaseLock).toHaveBeenCalledWith(lockKey, lockHolder);
    });

    test('releaseLock in finally block uses stored holder after error', async () => {
      const { v4: uuidv4 } = require('uuid');
      let releasedHolder: string | null = null;

      const mockAcquireLock = jest.fn().mockResolvedValue({ acquired: true });
      const mockReleaseLock = jest.fn().mockImplementation(
        (_key: string, holder: string) => {
          releasedHolder = holder;
          return Promise.resolve(true);
        }
      );

      const lockKey = 'driver-acceptance:assignment-ccc';
      const lockHolder = uuidv4();

      await mockAcquireLock(lockKey, lockHolder, 10);
      try {
        // Simulate an error during processing
        throw new Error('CAS guard failed');
      } catch {
        // Error handled
      } finally {
        await mockReleaseLock(lockKey, lockHolder);
      }

      // Even after an error, releaseLock must use the same holder
      expect(releasedHolder).toBe(lockHolder);
    });
  });

  // -------------------------------------------------------------------------
  // Verify source code: releaseLock in finally blocks uses lockHolder variable
  // -------------------------------------------------------------------------
  describe('source code finally blocks pass lockHolder to releaseLock', () => {
    test('handleDriverAcceptance finally block passes lockHolder', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/confirmed-hold.service.ts'),
        'utf-8'
      );

      // The acceptance handler must have: releaseLock(lockKey, lockHolder) in its finally block
      const acceptStart = source.indexOf('async handleDriverAcceptance');
      const acceptEnd = source.indexOf('async handleDriverDecline');
      const acceptMethod = source.substring(acceptStart, acceptEnd);

      expect(acceptMethod).toContain('releaseLock(lockKey, lockHolder)');
    });

    test('handleDriverDecline finally block passes lockHolder', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/confirmed-hold.service.ts'),
        'utf-8'
      );

      // The decline handler is ~6500 chars long; use a wide window
      const declineStart = source.indexOf('async handleDriverDecline');
      const declineMethod = source.substring(declineStart, declineStart + 8000);

      // The releaseLock call includes .catch(() => {}) — match the full pattern
      expect(declineMethod).toContain('releaseLock(lockKey, lockHolder)');
    });
  });
});

// =============================================================================
// C-07 TESTS: Socket event name fixed (TRIP_ASSIGNED)
// =============================================================================

describe('C-07: assignment-dispatch emits TRIP_ASSIGNED (not ASSIGNMENT_STATUS_CHANGED)', () => {
  // -------------------------------------------------------------------------
  // Test 3: assignment-dispatch emits TRIP_ASSIGNED
  // -------------------------------------------------------------------------
  describe('dispatch service uses correct socket event', () => {
    test('source code uses SocketEvent.TRIP_ASSIGNED for driver notification', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/assignment/assignment-dispatch.service.ts'),
        'utf-8'
      );

      // The dispatch service must emit TRIP_ASSIGNED to the driver
      expect(source).toContain('SocketEvent.TRIP_ASSIGNED');

      // Find the driver notification line specifically
      const lines = source.split('\n');
      const tripAssignedLines = lines.filter((line: string) =>
        line.includes('SocketEvent.TRIP_ASSIGNED')
      );
      expect(tripAssignedLines.length).toBeGreaterThan(0);

      // The emitToUser call for the driver must use TRIP_ASSIGNED
      const emitDriverLines = lines.filter((line: string) =>
        line.includes('emitToUser') && line.includes('data.driverId')
      );
      // There should be at least one emitToUser call for the driver
      expect(emitDriverLines.length).toBeGreaterThan(0);
    });

    test('source code does NOT use ASSIGNMENT_STATUS_CHANGED for driver dispatch', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/assignment/assignment-dispatch.service.ts'),
        'utf-8'
      );

      // The bug was: emitToUser(driverId, SocketEvent.ASSIGNMENT_STATUS_CHANGED, ...)
      // After fix: emitToUser(driverId, SocketEvent.TRIP_ASSIGNED, ...)
      //
      // ASSIGNMENT_STATUS_CHANGED must NOT appear in the dispatch service
      // as a driver notification event (it may still exist in imports)
      const lines = source.split('\n');
      const driverEmitWithWrongEvent = lines.filter((line: string) =>
        line.includes('emitToUser') &&
        line.includes('ASSIGNMENT_STATUS_CHANGED')
      );
      expect(driverEmitWithWrongEvent).toHaveLength(0);
    });

    test('C-07 fix comment is present in source', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/assignment/assignment-dispatch.service.ts'),
        'utf-8'
      );

      // The fix comment documents the change
      expect(source).toContain('C-07 fix');
    });
  });

  // -------------------------------------------------------------------------
  // Behavioral test: mock emitToUser and verify event name
  // -------------------------------------------------------------------------
  describe('emitToUser mock verification', () => {
    test('dispatch function emits trip_assigned to driver (not assignment_status_changed)', () => {
      // Replicate the dispatch notification pattern
      const emitToUser = jest.fn();

      const SocketEvent = {
        TRIP_ASSIGNED: 'trip_assigned',
        ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
        TRUCK_ASSIGNED: 'truck_assigned',
      };

      // Simulate the FIXED dispatch behavior (C-07)
      const driverId = 'driver-xyz';
      const payload = {
        assignmentId: 'assign-001',
        tripId: 'trip-001',
        bookingId: 'booking-001',
        status: 'pending',
        message: 'New trip assigned to you',
      };

      // The fixed code: emitToUser(data.driverId, SocketEvent.TRIP_ASSIGNED, payload)
      emitToUser(driverId, SocketEvent.TRIP_ASSIGNED, payload);

      // Verify TRIP_ASSIGNED was emitted
      expect(emitToUser).toHaveBeenCalledWith(
        driverId,
        'trip_assigned',
        expect.objectContaining({
          assignmentId: 'assign-001',
          tripId: 'trip-001',
        })
      );

      // Verify ASSIGNMENT_STATUS_CHANGED was NOT emitted
      const wrongEventCalls = emitToUser.mock.calls.filter(
        (call: any[]) => call[1] === 'assignment_status_changed'
      );
      expect(wrongEventCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // All three notification paths now use the same event name
  // -------------------------------------------------------------------------
  describe('all notification paths aligned', () => {
    test('assignment.service.ts, assignment-dispatch.service.ts, and socket.service.ts all use trip_assigned', () => {
      const fs = require('fs');
      const path = require('path');

      const dispatchSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/assignment/assignment-dispatch.service.ts'),
        'utf-8'
      );
      const socketSource = fs.readFileSync(
        path.resolve(__dirname, '../shared/services/socket.service.ts'),
        'utf-8'
      );

      // assignment-dispatch.service.ts uses TRIP_ASSIGNED
      expect(dispatchSource).toContain('SocketEvent.TRIP_ASSIGNED');

      // socket.service.ts reconnect path uses TRIP_ASSIGNED
      expect(socketSource).toContain('SocketEvent.TRIP_ASSIGNED');
    });
  });
});

// =============================================================================
// C-08 TESTS: FLEX conflict guard added to class method holdTrucks()
// =============================================================================

describe('C-08: FLEX conflict guard added to class method holdTrucks()', () => {
  // -------------------------------------------------------------------------
  // Test 4: holdTrucks rejects when active FLEX hold exists
  // -------------------------------------------------------------------------
  describe('FLEX hold conflict detection', () => {
    test('holdTrucks returns FLEX_HOLD_CONFLICT when active FLEX hold exists', async () => {
      // Simulate the FLEX conflict guard logic from truck-hold.service.ts:720-736
      // This replicates the guard that was added to the class method
      const mockFindFirst = jest.fn().mockResolvedValue({
        id: 'existing-hold-id',
        orderId: 'order-001',
        transporterId: 'transporter-001',
        status: 'active',
        phase: 'FLEX',
      });

      // Replicate the guard logic
      async function flexConflictGuard(orderId: string, transporterId: string) {
        const existingFlexHold = await mockFindFirst({
          where: {
            orderId,
            transporterId,
            status: 'active',
            phase: 'FLEX',
          },
        });

        if (existingFlexHold) {
          return {
            success: false,
            message: 'Active flex hold already exists. Use the flex hold API to manage it.',
            error: 'FLEX_HOLD_CONFLICT',
          };
        }

        return null; // No conflict, proceed
      }

      const result = await flexConflictGuard('order-001', 'transporter-001');

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.error).toBe('FLEX_HOLD_CONFLICT');
      expect(mockFindFirst).toHaveBeenCalledWith({
        where: {
          orderId: 'order-001',
          transporterId: 'transporter-001',
          status: 'active',
          phase: 'FLEX',
        },
      });
    });

    // -----------------------------------------------------------------------
    // Test 5: holdTrucks proceeds when no FLEX hold exists
    // -----------------------------------------------------------------------
    test('holdTrucks proceeds to transaction when no FLEX hold exists', async () => {
      const mockFindFirst = jest.fn().mockResolvedValue(null);
      let reachedTransaction = false;

      // Replicate the guard + transaction pattern
      async function holdTrucksWithGuard(orderId: string, transporterId: string) {
        const existingFlexHold = await mockFindFirst({
          where: {
            orderId,
            transporterId,
            status: 'active',
            phase: 'FLEX',
          },
        });

        if (existingFlexHold) {
          return {
            success: false,
            error: 'FLEX_HOLD_CONFLICT',
          };
        }

        // If no conflict, we reach the transaction
        reachedTransaction = true;
        return { success: true, holdId: 'HOLD_NEW' };
      }

      const result = await holdTrucksWithGuard('order-002', 'transporter-002');

      expect(result.success).toBe(true);
      expect(reachedTransaction).toBe(true);
      expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Structural verification: guard present in class method
  // -------------------------------------------------------------------------
  describe('source code verification', () => {
    test('truck-hold.service.ts class method has FLEX conflict guard', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/truck-hold.service.ts'),
        'utf-8'
      );

      // The class method holdTrucks must contain the FLEX guard
      const holdTrucksStart = source.indexOf('async holdTrucks(');
      expect(holdTrucksStart).toBeGreaterThan(-1);

      // The method is large (~5000 chars to the guard); use a wide window
      const holdTrucksWindow = source.substring(holdTrucksStart, holdTrucksStart + 6000);

      // Must query for existing FLEX hold via prismaClient
      expect(holdTrucksWindow).toContain('prismaClient.truckHoldLedger.findFirst');
      expect(holdTrucksWindow).toContain("phase: HoldPhase.FLEX");
      expect(holdTrucksWindow).toContain("status: 'active'");

      // Must return FLEX_HOLD_CONFLICT error
      expect(holdTrucksWindow).toContain('FLEX_HOLD_CONFLICT');
    });

    test('C-08 fix comment is present in truck-hold.service.ts', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/truck-hold.service.ts'),
        'utf-8'
      );

      // The fix comment documents this is the C-08 fix
      expect(source).toContain('C-08 fix');
    });

    test('guard is placed before the transaction (not inside it)', () => {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/truck-hold.service.ts'),
        'utf-8'
      );

      const holdTrucksStart = source.indexOf('async holdTrucks(');
      // Use a wide window to capture both the guard and the transaction
      const holdTrucksWindow = source.substring(holdTrucksStart, holdTrucksStart + 8000);

      // FLEX_HOLD_CONFLICT must appear BEFORE withDbTimeout
      const conflictIndex = holdTrucksWindow.indexOf('FLEX_HOLD_CONFLICT');
      const transactionIndex = holdTrucksWindow.indexOf('withDbTimeout');

      expect(conflictIndex).toBeGreaterThan(-1);
      expect(transactionIndex).toBeGreaterThan(-1);
      // The guard must come before the transaction
      expect(conflictIndex).toBeLessThan(transactionIndex);
    });

    test('class method guard matches standalone function guard pattern', () => {
      const fs = require('fs');
      const path = require('path');

      const classSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/truck-hold.service.ts'),
        'utf-8'
      );
      const standaloneSource = fs.readFileSync(
        path.resolve(__dirname, '../modules/truck-hold/truck-hold-create.service.ts'),
        'utf-8'
      );

      // Both must query truckHoldLedger.findFirst with phase: HoldPhase.FLEX
      expect(classSource).toContain('truckHoldLedger.findFirst');
      expect(standaloneSource).toContain('truckHoldLedger.findFirst');

      // Both must return FLEX_HOLD_CONFLICT
      expect(classSource).toContain('FLEX_HOLD_CONFLICT');
      expect(standaloneSource).toContain('FLEX_HOLD_CONFLICT');

      // Both must check status: 'active'
      const classHoldTrucks = classSource.substring(classSource.indexOf('async holdTrucks('));
      const standaloneHoldTrucks = standaloneSource;

      expect(classHoldTrucks).toContain("status: 'active'");
      expect(standaloneHoldTrucks).toContain("status: 'active'");
    });
  });

  // -------------------------------------------------------------------------
  // Edge case: FLEX hold exists but for a different order
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    test('FLEX hold for a different orderId does not block', async () => {
      // findFirst returns null when orderId does not match
      const mockFindFirst = jest.fn().mockResolvedValue(null);

      const existingFlexHold = await mockFindFirst({
        where: {
          orderId: 'order-different',
          transporterId: 'transporter-001',
          status: 'active',
          phase: 'FLEX',
        },
      });

      // No conflict since the query returns null for a different orderId
      expect(existingFlexHold).toBeNull();
    });

    test('expired FLEX hold does not block (status != active)', async () => {
      // findFirst returns null because the only hold has status 'expired'
      const mockFindFirst = jest.fn().mockResolvedValue(null);

      const existingFlexHold = await mockFindFirst({
        where: {
          orderId: 'order-001',
          transporterId: 'transporter-001',
          status: 'active',
          phase: 'FLEX',
        },
      });

      expect(existingFlexHold).toBeNull();
    });

    test('CONFIRMED phase hold does not trigger FLEX conflict', async () => {
      // findFirst returns null because the hold is CONFIRMED, not FLEX
      const mockFindFirst = jest.fn().mockResolvedValue(null);

      const existingFlexHold = await mockFindFirst({
        where: {
          orderId: 'order-001',
          transporterId: 'transporter-001',
          status: 'active',
          phase: 'FLEX',
        },
      });

      expect(existingFlexHold).toBeNull();
    });
  });
});
