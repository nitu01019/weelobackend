/**
 * =============================================================================
 * PHASE 1 P0 FIXES TEST SUITE
 * =============================================================================
 *
 * Tests for:
 *   FIX-3: Tracking Route Ordering (route shadowing prevention)
 *   FIX-2: Socket Reconnect Event (correct event name + enriched payload)
 *
 * FIX-3 Context:
 *   Express matches routes in registration order. If the parameterized
 *   route `/:tripId` is registered before static routes like `/fleet`,
 *   `/status`, or `/active-trip`, Express treats the static segment as
 *   a tripId parameter and the static handler is never reached.
 *   These tests verify that all static routes are registered BEFORE `/:tripId`.
 *
 * FIX-2 Context:
 *   When a driver reconnects and has a pending assignment, the socket
 *   service must emit `trip_assigned` (SocketEvent.TRIP_ASSIGNED) with an
 *   enriched payload. The Captain app (SocketEventRouter.kt:130) only shows
 *   the trip overlay for `trip_assigned` events -- NOT `assignment_status_changed`.
 *   Uber RAMEN pattern: reconnect re-delivery uses the SAME event + payload
 *   as initial delivery, including pickup, drop, vehicleNumber, farePerTruck.
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';

export {};

// =============================================================================
// FIX-3: TRACKING ROUTE ORDERING (ROUTE SHADOWING PREVENTION)
// =============================================================================

const TRACKING_ROUTES_PATH = path.resolve(
  __dirname,
  '../modules/tracking/tracking.routes.ts'
);

describe('FIX-3: Tracking Route Ordering', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(TRACKING_ROUTES_PATH, 'utf-8');
  });

  describe('Static routes exist', () => {
    it('defines GET /fleet route', () => {
      expect(source).toMatch(/router\.get\(\s*['"]\/fleet['"]/);
    });

    it('defines GET /status route', () => {
      expect(source).toMatch(/router\.get\(\s*['"]\/status['"]/);
    });

    it('defines GET /active-trip route', () => {
      expect(source).toMatch(/router\.get\(\s*['"]\/active-trip['"]/);
    });

    it('defines GET /:tripId parameterized route', () => {
      expect(source).toMatch(/router\.get\(\s*['"]\/:tripId['"]/);
    });
  });

  describe('Route ordering: static routes BEFORE /:tripId', () => {
    it('GET /fleet is registered BEFORE GET /:tripId', () => {
      const fleetPos = source.indexOf("'/fleet'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(fleetPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(fleetPos).toBeLessThan(tripIdPos);
    });

    it('GET /status is registered BEFORE GET /:tripId', () => {
      const statusPos = source.indexOf("'/status'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(statusPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(statusPos).toBeLessThan(tripIdPos);
    });

    it('GET /active-trip is registered BEFORE GET /:tripId', () => {
      const activeTripPos = source.indexOf("'/active-trip'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(activeTripPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(activeTripPos).toBeLessThan(tripIdPos);
    });

    it('GET /history/:tripId is registered BEFORE GET /:tripId', () => {
      const historyPos = source.indexOf("'/history/:tripId'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(historyPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(historyPos).toBeLessThan(tripIdPos);
    });

    it('PUT /trip/:tripId/status is registered BEFORE GET /:tripId', () => {
      const tripStatusPos = source.indexOf("'/trip/:tripId/status'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(tripStatusPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(tripStatusPos).toBeLessThan(tripIdPos);
    });

    it('POST /batch is registered BEFORE GET /:tripId', () => {
      const batchPos = source.indexOf("'/batch'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(batchPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(batchPos).toBeLessThan(tripIdPos);
    });

    it('GET /booking/:bookingId is registered BEFORE GET /:tripId', () => {
      const bookingPos = source.indexOf("'/booking/:bookingId'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(bookingPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(bookingPos).toBeLessThan(tripIdPos);
    });

    it('GET /driver/:driverId/status is registered BEFORE GET /:tripId', () => {
      const driverStatusPos = source.indexOf("'/driver/:driverId/status'");
      const tripIdPos = source.indexOf("'/:tripId'");

      expect(driverStatusPos).toBeGreaterThan(-1);
      expect(tripIdPos).toBeGreaterThan(-1);
      expect(driverStatusPos).toBeLessThan(tripIdPos);
    });
  });

  describe('/:tripId is the LAST GET route registered', () => {
    it('no router.get() calls appear after /:tripId', () => {
      const tripIdPos = source.indexOf("'/:tripId'");
      const afterTripId = source.slice(tripIdPos + 10);

      // There should be no further router.get( calls after /:tripId
      // (router.get is the concern; router.post/put after it are fine)
      const subsequentGetMatch = afterTripId.match(/router\.get\(\s*['"]/);
      expect(subsequentGetMatch).toBeNull();
    });
  });
});

// =============================================================================
// FIX-2: SOCKET RECONNECT EVENT
// =============================================================================

const SOCKET_SERVICE_PATH = path.resolve(
  __dirname,
  '../shared/services/socket.service.ts'
);
// F-C-52: SocketEvent map moved to packages/contracts/events.generated.ts.
// Concat both so inline-OR-generated assertions still match.
const CONTRACTS_GENERATED_PATH = path.resolve(
  __dirname,
  '../../packages/contracts/events.generated.ts'
);

describe('FIX-2: Socket Reconnect Event', () => {
  let source: string;

  beforeAll(() => {
    const socketSrc = fs.readFileSync(SOCKET_SERVICE_PATH, 'utf-8');
    const contractsSrc = fs.existsSync(CONTRACTS_GENERATED_PATH)
      ? fs.readFileSync(CONTRACTS_GENERATED_PATH, 'utf-8')
      : '';
    source = socketSrc + '\n' + contractsSrc;
  });

  describe('Reconnect event name', () => {
    it('emits TRIP_ASSIGNED (not ASSIGNMENT_STATUS_CHANGED) on driver reconnect', () => {
      // FIX-2: Captain app SocketEventRouter.kt:130 only shows trip overlay
      // for 'trip_assigned' events. Reconnect must use the SAME event as
      // initial delivery (Uber RAMEN pattern).
      expect(source).toContain('socket.emit(SocketEvent.TRIP_ASSIGNED');
    });

    it('TRIP_ASSIGNED is defined in SocketEvent constants', () => {
      expect(source).toMatch(/TRIP_ASSIGNED:\s*['"]trip_assigned['"]/);
    });

    it('reconnect emit uses TRIP_ASSIGNED near _reconnectDelivery flag', () => {
      // Find the driver reconnect block (first _reconnectDelivery after TRIP_ASSIGNED emit)
      const tripAssignedEmitIdx = source.indexOf('socket.emit(SocketEvent.TRIP_ASSIGNED');
      expect(tripAssignedEmitIdx).toBeGreaterThan(-1);

      // The _reconnectDelivery: true should appear within the same emit payload
      // Use a wider window (1200 chars) to capture the full emit payload
      const afterEmit = source.slice(tripAssignedEmitIdx, tripAssignedEmitIdx + 1200);
      expect(afterEmit).toContain('_reconnectDelivery: true');
    });
  });

  describe('Reconnect payload: enriched fields for Captain app', () => {
    // Helper: extract the reconnect emit block (TRIP_ASSIGNED emit with _reconnectDelivery)
    // Uses a 1200-char window to capture the full payload including _reconnectDelivery
    function getReconnectBlock(): string {
      const emitIdx = source.indexOf('socket.emit(SocketEvent.TRIP_ASSIGNED');
      expect(emitIdx).toBeGreaterThan(-1);
      return source.slice(emitIdx, emitIdx + 1200);
    }

    it('reconnect payload includes assignmentId', () => {
      expect(getReconnectBlock()).toContain('assignmentId:');
    });

    it('reconnect payload includes tripId', () => {
      expect(getReconnectBlock()).toContain('tripId:');
    });

    it('reconnect payload includes bookingId', () => {
      expect(getReconnectBlock()).toContain('bookingId:');
    });

    it('reconnect payload includes pickup', () => {
      expect(getReconnectBlock()).toContain('pickup:');
    });

    it('reconnect payload includes drop', () => {
      expect(getReconnectBlock()).toContain('drop:');
    });

    it('reconnect payload includes vehicleNumber', () => {
      expect(getReconnectBlock()).toContain('vehicleNumber:');
    });

    it('reconnect payload includes farePerTruck', () => {
      expect(getReconnectBlock()).toContain('farePerTruck:');
    });

    it('reconnect payload includes distanceKm', () => {
      expect(getReconnectBlock()).toContain('distanceKm:');
    });

    it('reconnect payload includes status field set to pending', () => {
      expect(getReconnectBlock()).toContain("status: 'pending'");
    });

    it('reconnect payload includes remainingSeconds', () => {
      expect(getReconnectBlock()).toContain('remainingSeconds:');
    });

    it('reconnect payload includes _reconnectDelivery flag set to true', () => {
      expect(getReconnectBlock()).toContain('_reconnectDelivery: true');
    });

    it('reconnect payload includes orderId', () => {
      expect(getReconnectBlock()).toContain('orderId:');
    });
  });

  describe('Reconnect fetches full assignment with order details', () => {
    // Helper: extract the driver reconnect section between known markers
    function getDriverReconnectSection(): string {
      const startMarker = 'PENDING ASSIGNMENT RE-SEND ON DRIVER RECONNECT';
      const startIdx = source.indexOf(startMarker);
      expect(startIdx).toBeGreaterThan(-1);

      // Find the end boundary: the transporter branch that follows the driver block
      const endMarker = "} else if (role === 'transporter')";
      const endIdx = source.indexOf(endMarker, startIdx);
      expect(endIdx).toBeGreaterThan(-1);

      return source.slice(startIdx, endIdx);
    }

    it('queries assignment with include: order for enriched payload', () => {
      const section = getDriverReconnectSection();
      expect(section).toContain('include:');
      expect(section).toContain('order:');
    });

    it('selects pickup from order for payload enrichment', () => {
      const section = getDriverReconnectSection();
      expect(section).toContain('pickup:');
    });

    it('selects drop from order for payload enrichment', () => {
      const section = getDriverReconnectSection();
      expect(section).toContain('drop:');
    });

    it('selects distanceKm from order', () => {
      const section = getDriverReconnectSection();
      expect(section).toContain('distanceKm:');
    });

    it('selects pricePerTruck from order for fare calculation', () => {
      const section = getDriverReconnectSection();
      expect(section).toContain('pricePerTruck');
    });
  });

  describe('Reconnect safety: only re-sends within timeout window', () => {
    it('checks remainingMs > 2000 before re-sending', () => {
      expect(source).toContain('remainingMs > 2000');
    });

    it('calculates elapsed time from assignedAt', () => {
      expect(source).toContain('Date.now() - assignedAtMs');
    });

    it('calculates remaining time from ASSIGNMENT_TIMEOUT_MS', () => {
      expect(source).toContain('ASSIGNMENT_TIMEOUT_MS - elapsedMs');
    });

    it('skips re-send when assignment has less than 2s remaining', () => {
      // The else branch logs that it is skipping
      expect(source).toContain('skipping re-send');
    });
  });

  describe('Reconnect dual-channel: FCM fallback', () => {
    it('sends FCM push notification as fallback after socket emit', () => {
      expect(source).toContain("sendPushNotification(userId,");
    });

    it('FCM payload includes type: trip_assigned for driver notification', () => {
      expect(source).toContain("type: 'trip_assigned'");
    });

    it('FCM payload includes assignmentId in data', () => {
      const fcmBlockMatch = source.match(/sendPushNotification\(userId[\s\S]*?data:\s*\{[\s\S]*?assignmentId/);
      expect(fcmBlockMatch).not.toBeNull();
    });

    it('FCM failure is caught and does not crash reconnect flow', () => {
      expect(source).toContain("fcmErr");
    });
  });

  describe('Reconnect only triggers for drivers with pending assignments', () => {
    it('queries assignments with status: pending', () => {
      expect(source).toContain("status: 'pending'");
    });

    it('orders by assignedAt desc to get the latest assignment', () => {
      expect(source).toContain("orderBy: { assignedAt: 'desc' }");
    });

    it('reconnect logic is inside the driver role branch', () => {
      const driverRoleIdx = source.indexOf("if (role === 'driver')");
      const reconnectEmitIdx = source.indexOf('_reconnectDelivery: true');
      expect(driverRoleIdx).toBeGreaterThan(-1);
      expect(reconnectEmitIdx).toBeGreaterThan(-1);
      expect(driverRoleIdx).toBeLessThan(reconnectEmitIdx);
    });
  });
});
