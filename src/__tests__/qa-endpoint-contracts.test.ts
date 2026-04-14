/**
 * =============================================================================
 * QA ENDPOINT CONTRACTS -- Verify NO API routes were broken by 51 production fixes
 * =============================================================================
 *
 * Captain app and Customer app depend on exact endpoint paths, HTTP methods,
 * request/response shapes, and status codes. This test suite statically verifies
 * that all route files still export the correct route definitions.
 *
 * Groups:
 *   1. Booking Routes (10 tests)
 *   2. Order Routes (10 tests)
 *   3. Truck-Hold Routes (10 tests)
 *   4. Driver Routes (5 tests)
 *   5. Auth Routes (5 tests)
 *   6. Health / Debug Routes (5 tests)
 *   7. Broadcast Routes (3 tests)
 *   8. Tracking Routes (3 tests)
 *   9. Geocoding Routes (3 tests)
 *
 * @author QA-Agent -- Endpoint Contract Verification
 * =============================================================================
 */

import { Router } from 'express';

// ---------------------------------------------------------------------------
// Helper: Extract registered routes from an Express Router
// ---------------------------------------------------------------------------
interface RouteEntry {
  method: string;
  path: string;
}

function extractRoutes(router: any): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const stack = router?.stack ?? router?._router?.stack ?? [];

  for (const layer of stack) {
    if (layer.route) {
      const path: string = layer.route.path;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return routes;
}

function hasRoute(routes: RouteEntry[], method: string, path: string): boolean {
  return routes.some(
    (r) => r.method === method.toUpperCase() && r.path === path
  );
}

// =============================================================================
// GROUP 1: BOOKING ROUTES  (mounted at /api/v1/bookings)
// =============================================================================
describe('GROUP 1: Booking Routes -- /api/v1/bookings', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bookingRouter } = require('../modules/booking/booking.routes');
    routes = extractRoutes(bookingRouter);
  });

  test('POST / -- create booking still exists', () => {
    expect(hasRoute(routes, 'POST', '/')).toBe(true);
  });

  test('GET / -- list customer bookings still exists', () => {
    expect(hasRoute(routes, 'GET', '/')).toBe(true);
  });

  test('GET /active -- active broadcasts for transporters still exists', () => {
    expect(hasRoute(routes, 'GET', '/active')).toBe(true);
  });

  test('GET /:id -- get booking by id still exists', () => {
    expect(hasRoute(routes, 'GET', '/:id')).toBe(true);
  });

  test('GET /:id/trucks -- assigned trucks still exists', () => {
    expect(hasRoute(routes, 'GET', '/:id/trucks')).toBe(true);
  });

  test('PATCH /:id/cancel -- cancel booking still exists', () => {
    expect(hasRoute(routes, 'PATCH', '/:id/cancel')).toBe(true);
  });

  test('POST /orders -- create order (multi-truck) still exists', () => {
    expect(hasRoute(routes, 'POST', '/orders')).toBe(true);
  });

  test('GET /orders -- list customer orders still exists', () => {
    expect(hasRoute(routes, 'GET', '/orders')).toBe(true);
  });

  test('GET /orders/:id -- get order details still exists', () => {
    expect(hasRoute(routes, 'GET', '/orders/:id')).toBe(true);
  });

  test('GET /requests/active -- active truck requests for transporter still exists', () => {
    expect(hasRoute(routes, 'GET', '/requests/active')).toBe(true);
  });

  test('POST /requests/:id/accept -- accept truck request still exists', () => {
    expect(hasRoute(routes, 'POST', '/requests/:id/accept')).toBe(true);
  });

  test('POST /orders/:orderId/cancel -- cancel order still exists', () => {
    expect(hasRoute(routes, 'POST', '/orders/:orderId/cancel')).toBe(true);
  });

  test('GET /orders/:orderId/cancel-preview -- cancel preview still exists', () => {
    expect(hasRoute(routes, 'GET', '/orders/:orderId/cancel-preview')).toBe(true);
  });

  test('POST /orders/:orderId/cancel/dispute -- cancel dispute still exists', () => {
    expect(hasRoute(routes, 'POST', '/orders/:orderId/cancel/dispute')).toBe(true);
  });

  test('GET /orders/:orderId/status -- order status still exists', () => {
    expect(hasRoute(routes, 'GET', '/orders/:orderId/status')).toBe(true);
  });

  test('GET /orders/:orderId/broadcast-snapshot -- broadcast snapshot still exists', () => {
    expect(hasRoute(routes, 'GET', '/orders/:orderId/broadcast-snapshot')).toBe(true);
  });
});

// =============================================================================
// GROUP 2: ORDER ROUTES  (mounted at /api/v1/orders)
// =============================================================================
describe('GROUP 2: Order Routes -- /api/v1/orders', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const orderRouter = require('../modules/order/order.routes').default;
    routes = extractRoutes(orderRouter);
  });

  test('POST / -- create order still exists', () => {
    expect(hasRoute(routes, 'POST', '/')).toBe(true);
  });

  test('GET / -- list orders still exists', () => {
    expect(hasRoute(routes, 'GET', '/')).toBe(true);
  });

  test('GET /check-active -- check active order still exists', () => {
    expect(hasRoute(routes, 'GET', '/check-active')).toBe(true);
  });

  test('GET /active -- active requests for transporter still exists', () => {
    expect(hasRoute(routes, 'GET', '/active')).toBe(true);
  });

  test('GET /:id -- get order details still exists', () => {
    expect(hasRoute(routes, 'GET', '/:id')).toBe(true);
  });

  test('POST /accept -- accept truck request still exists', () => {
    expect(hasRoute(routes, 'POST', '/accept')).toBe(true);
  });

  test('POST /:id/cancel -- cancel order still exists', () => {
    expect(hasRoute(routes, 'POST', '/:id/cancel')).toBe(true);
  });

  test('DELETE /:orderId/cancel -- delete cancel still exists', () => {
    expect(hasRoute(routes, 'DELETE', '/:orderId/cancel')).toBe(true);
  });

  test('GET /:orderId/status -- order status still exists', () => {
    expect(hasRoute(routes, 'GET', '/:orderId/status')).toBe(true);
  });

  test('GET /:orderId/broadcast-snapshot -- broadcast snapshot still exists', () => {
    expect(hasRoute(routes, 'GET', '/:orderId/broadcast-snapshot')).toBe(true);
  });

  test('POST /:orderId/reached-stop -- route progress still exists', () => {
    expect(hasRoute(routes, 'POST', '/:orderId/reached-stop')).toBe(true);
  });

  test('GET /:orderId/route -- get route with progress still exists', () => {
    expect(hasRoute(routes, 'GET', '/:orderId/route')).toBe(true);
  });

  test('POST /:orderId/departed-stop -- departed stop still exists', () => {
    expect(hasRoute(routes, 'POST', '/:orderId/departed-stop')).toBe(true);
  });

  test('GET /:orderId/cancel-preview -- cancel preview still exists', () => {
    expect(hasRoute(routes, 'GET', '/:orderId/cancel-preview')).toBe(true);
  });

  test('POST /:orderId/cancel/dispute -- cancel dispute still exists', () => {
    expect(hasRoute(routes, 'POST', '/:orderId/cancel/dispute')).toBe(true);
  });

  test('GET /pending-settlements -- pending settlements still exists', () => {
    expect(hasRoute(routes, 'GET', '/pending-settlements')).toBe(true);
  });
});

// =============================================================================
// GROUP 3: TRUCK-HOLD ROUTES  (mounted at /api/v1/truck-hold)
// =============================================================================
describe('GROUP 3: Truck-Hold Routes -- /api/v1/truck-hold', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { truckHoldRouter } = require('../modules/truck-hold/truck-hold.routes');
    routes = extractRoutes(truckHoldRouter);
  });

  test('POST /hold -- hold trucks still exists', () => {
    expect(hasRoute(routes, 'POST', '/hold')).toBe(true);
  });

  test('POST /confirm -- confirm hold still exists', () => {
    expect(hasRoute(routes, 'POST', '/confirm')).toBe(true);
  });

  test('POST /confirm-with-assignments -- confirm with assignments still exists', () => {
    expect(hasRoute(routes, 'POST', '/confirm-with-assignments')).toBe(true);
  });

  test('POST /release -- release hold still exists', () => {
    expect(hasRoute(routes, 'POST', '/release')).toBe(true);
  });

  test('GET /my-active -- get my active hold still exists', () => {
    expect(hasRoute(routes, 'GET', '/my-active')).toBe(true);
  });

  test('GET /availability/:orderId -- get availability still exists', () => {
    expect(hasRoute(routes, 'GET', '/availability/:orderId')).toBe(true);
  });

  test('POST /flex-hold -- create flex hold still exists', () => {
    expect(hasRoute(routes, 'POST', '/flex-hold')).toBe(true);
  });

  test('POST /flex-hold/extend -- extend flex hold still exists', () => {
    expect(hasRoute(routes, 'POST', '/flex-hold/extend')).toBe(true);
  });

  test('GET /flex-hold/:holdId -- get flex hold state still exists', () => {
    expect(hasRoute(routes, 'GET', '/flex-hold/:holdId')).toBe(true);
  });

  test('POST /confirmed-hold/initialize -- initialize confirmed hold still exists', () => {
    expect(hasRoute(routes, 'POST', '/confirmed-hold/initialize')).toBe(true);
  });

  test('GET /confirmed-hold/:holdId -- get confirmed hold state still exists', () => {
    expect(hasRoute(routes, 'GET', '/confirmed-hold/:holdId')).toBe(true);
  });

  test('PUT /driver/:assignmentId/accept -- driver accept still exists', () => {
    expect(hasRoute(routes, 'PUT', '/driver/:assignmentId/accept')).toBe(true);
  });

  test('PUT /driver/:assignmentId/decline -- driver decline still exists', () => {
    expect(hasRoute(routes, 'PUT', '/driver/:assignmentId/decline')).toBe(true);
  });

  test('POST /order-timeout/initialize -- timeout initialize still exists', () => {
    expect(hasRoute(routes, 'POST', '/order-timeout/initialize')).toBe(true);
  });

  test('POST /order-timeout/extend -- timeout extend still exists', () => {
    expect(hasRoute(routes, 'POST', '/order-timeout/extend')).toBe(true);
  });

  test('GET /order-timeout/:orderId -- get timeout state still exists', () => {
    expect(hasRoute(routes, 'GET', '/order-timeout/:orderId')).toBe(true);
  });

  test('GET /order-progress/:orderId -- get order progress still exists', () => {
    expect(hasRoute(routes, 'GET', '/order-progress/:orderId')).toBe(true);
  });

  test('GET /order-assignments/:orderId -- get order assignments still exists', () => {
    expect(hasRoute(routes, 'GET', '/order-assignments/:orderId')).toBe(true);
  });
});

// =============================================================================
// GROUP 3b: Truck-Hold CRUD Routes (split file)
// =============================================================================
describe('GROUP 3b: Truck-Hold CRUD Routes (split file)', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { truckHoldCrudRouter } = require('../modules/truck-hold/truck-hold-crud.routes');
    routes = extractRoutes(truckHoldCrudRouter);
  });

  test('POST /hold exists in CRUD split', () => {
    expect(hasRoute(routes, 'POST', '/hold')).toBe(true);
  });

  test('POST /confirm exists in CRUD split', () => {
    expect(hasRoute(routes, 'POST', '/confirm')).toBe(true);
  });

  test('POST /confirm-with-assignments exists in CRUD split', () => {
    expect(hasRoute(routes, 'POST', '/confirm-with-assignments')).toBe(true);
  });

  test('POST /release exists in CRUD split', () => {
    expect(hasRoute(routes, 'POST', '/release')).toBe(true);
  });

  test('GET /my-active exists in CRUD split', () => {
    expect(hasRoute(routes, 'GET', '/my-active')).toBe(true);
  });

  test('GET /availability/:orderId exists in CRUD split', () => {
    expect(hasRoute(routes, 'GET', '/availability/:orderId')).toBe(true);
  });
});

// =============================================================================
// GROUP 3c: Truck-Hold Lifecycle Routes (split file)
// =============================================================================
describe('GROUP 3c: Truck-Hold Lifecycle Routes (split file)', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { truckHoldLifecycleRouter } = require('../modules/truck-hold/truck-hold-lifecycle.routes');
    routes = extractRoutes(truckHoldLifecycleRouter);
  });

  test('POST /flex-hold exists in lifecycle split', () => {
    expect(hasRoute(routes, 'POST', '/flex-hold')).toBe(true);
  });

  test('POST /flex-hold/extend exists in lifecycle split', () => {
    expect(hasRoute(routes, 'POST', '/flex-hold/extend')).toBe(true);
  });

  test('GET /flex-hold/:holdId exists in lifecycle split', () => {
    expect(hasRoute(routes, 'GET', '/flex-hold/:holdId')).toBe(true);
  });

  test('POST /confirmed-hold/initialize exists in lifecycle split', () => {
    expect(hasRoute(routes, 'POST', '/confirmed-hold/initialize')).toBe(true);
  });

  test('PUT /driver/:assignmentId/accept exists in lifecycle split', () => {
    expect(hasRoute(routes, 'PUT', '/driver/:assignmentId/accept')).toBe(true);
  });

  test('PUT /driver/:assignmentId/decline exists in lifecycle split', () => {
    expect(hasRoute(routes, 'PUT', '/driver/:assignmentId/decline')).toBe(true);
  });
});

// =============================================================================
// GROUP 4: DRIVER ROUTES  (mounted at /api/v1/driver)
// =============================================================================
describe('GROUP 4: Driver Routes -- /api/v1/driver', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    routes = extractRoutes(driverRouter);
  });

  test('POST /onboard/initiate -- driver onboarding still exists', () => {
    expect(hasRoute(routes, 'POST', '/onboard/initiate')).toBe(true);
  });

  test('POST /onboard/verify -- driver OTP verify still exists', () => {
    expect(hasRoute(routes, 'POST', '/onboard/verify')).toBe(true);
  });

  test('POST /onboard/resend -- driver OTP resend still exists', () => {
    expect(hasRoute(routes, 'POST', '/onboard/resend')).toBe(true);
  });

  test('POST /create -- create driver still exists', () => {
    expect(hasRoute(routes, 'POST', '/create')).toBe(true);
  });

  test('GET /list -- list drivers still exists', () => {
    expect(hasRoute(routes, 'GET', '/list')).toBe(true);
  });

  test('GET /dashboard -- driver dashboard still exists', () => {
    expect(hasRoute(routes, 'GET', '/dashboard')).toBe(true);
  });

  test('GET /performance -- driver performance still exists', () => {
    expect(hasRoute(routes, 'GET', '/performance')).toBe(true);
  });

  test('GET /availability -- get availability still exists', () => {
    expect(hasRoute(routes, 'GET', '/availability')).toBe(true);
  });

  test('GET /available -- get available drivers still exists', () => {
    expect(hasRoute(routes, 'GET', '/available')).toBe(true);
  });

  test('PUT /availability -- update availability still exists', () => {
    expect(hasRoute(routes, 'PUT', '/availability')).toBe(true);
  });

  test('GET /online-drivers -- online drivers still exists', () => {
    expect(hasRoute(routes, 'GET', '/online-drivers')).toBe(true);
  });

  test('GET /earnings -- driver earnings still exists', () => {
    expect(hasRoute(routes, 'GET', '/earnings')).toBe(true);
  });

  test('GET /trips -- driver trips still exists', () => {
    expect(hasRoute(routes, 'GET', '/trips')).toBe(true);
  });

  test('GET /trips/active -- active trip still exists', () => {
    expect(hasRoute(routes, 'GET', '/trips/active')).toBe(true);
  });

  test('POST /complete-profile -- complete profile still exists', () => {
    expect(hasRoute(routes, 'POST', '/complete-profile')).toBe(true);
  });

  test('GET /profile -- get profile still exists', () => {
    expect(hasRoute(routes, 'GET', '/profile')).toBe(true);
  });

  test('PUT /profile/photo -- update profile photo still exists', () => {
    expect(hasRoute(routes, 'PUT', '/profile/photo')).toBe(true);
  });

  test('PUT /profile/license -- update license photos still exists', () => {
    expect(hasRoute(routes, 'PUT', '/profile/license')).toBe(true);
  });

  test('POST /regenerate-urls -- regenerate S3 URLs still exists', () => {
    expect(hasRoute(routes, 'POST', '/regenerate-urls')).toBe(true);
  });
});

// =============================================================================
// GROUP 5: AUTH ROUTES  (mounted at /api/v1/auth)
// =============================================================================
describe('GROUP 5: Auth Routes -- /api/v1/auth', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { authRouter } = require('../modules/auth/auth.routes');
    routes = extractRoutes(authRouter);
  });

  test('POST /send-otp -- send OTP still exists', () => {
    expect(hasRoute(routes, 'POST', '/send-otp')).toBe(true);
  });

  test('POST /verify-otp -- verify OTP still exists', () => {
    expect(hasRoute(routes, 'POST', '/verify-otp')).toBe(true);
  });

  test('POST /refresh -- refresh token still exists', () => {
    expect(hasRoute(routes, 'POST', '/refresh')).toBe(true);
  });

  test('POST /logout -- logout still exists', () => {
    expect(hasRoute(routes, 'POST', '/logout')).toBe(true);
  });

  test('GET /me -- get current user still exists', () => {
    expect(hasRoute(routes, 'GET', '/me')).toBe(true);
  });

  test('GET /debug-otp -- REMOVED (intentional security fix)', () => {
    // debug-otp was intentionally removed for security
    expect(hasRoute(routes, 'GET', '/debug-otp')).toBe(false);
  });
});

// =============================================================================
// GROUP 5b: DRIVER AUTH ROUTES  (mounted at /api/v1/driver-auth)
// =============================================================================
describe('GROUP 5b: Driver Auth Routes -- /api/v1/driver-auth', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { driverAuthRouter } = require('../modules/driver-auth/driver-auth.routes');
    routes = extractRoutes(driverAuthRouter);
  });

  test('POST /send-otp -- send driver OTP still exists', () => {
    expect(hasRoute(routes, 'POST', '/send-otp')).toBe(true);
  });

  test('POST /verify-otp -- verify driver OTP still exists', () => {
    expect(hasRoute(routes, 'POST', '/verify-otp')).toBe(true);
  });

  test('GET /debug-otp -- REMOVED (intentional security fix)', () => {
    // debug-otp was intentionally removed for security
    expect(hasRoute(routes, 'GET', '/debug-otp')).toBe(false);
  });
});

// =============================================================================
// GROUP 6: HEALTH ROUTES  (mounted at /)
// =============================================================================
describe('GROUP 6: Health Routes -- /', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { healthRoutes } = require('../shared/routes/health.routes');
    routes = extractRoutes(healthRoutes);
  });

  test('GET /health -- basic health check still exists', () => {
    expect(hasRoute(routes, 'GET', '/health')).toBe(true);
  });

  test('GET /health/live -- liveness probe still exists', () => {
    expect(hasRoute(routes, 'GET', '/health/live')).toBe(true);
  });

  test('GET /health/ready -- readiness probe still exists', () => {
    expect(hasRoute(routes, 'GET', '/health/ready')).toBe(true);
  });

  test('GET /health/detailed -- detailed health still exists', () => {
    expect(hasRoute(routes, 'GET', '/health/detailed')).toBe(true);
  });

  test('GET /health/slo -- SLO snapshot still exists', () => {
    expect(hasRoute(routes, 'GET', '/health/slo')).toBe(true);
  });

  test('GET /health/websocket -- websocket debug still exists', () => {
    expect(hasRoute(routes, 'GET', '/health/websocket')).toBe(true);
  });

  test('GET /metrics -- prometheus metrics still exists', () => {
    expect(hasRoute(routes, 'GET', '/metrics')).toBe(true);
  });

  test('GET /version -- version endpoint still exists', () => {
    expect(hasRoute(routes, 'GET', '/version')).toBe(true);
  });
});

// =============================================================================
// GROUP 7: BROADCAST ROUTES  (mounted at /api/v1/broadcasts)
// =============================================================================
describe('GROUP 7: Broadcast Routes -- /api/v1/broadcasts', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { broadcastRouter } = require('../modules/broadcast/broadcast.routes');
    routes = extractRoutes(broadcastRouter);
  });

  test('GET /active -- active broadcasts still exists', () => {
    expect(hasRoute(routes, 'GET', '/active')).toBe(true);
  });

  test('GET /:broadcastId -- get broadcast details still exists', () => {
    expect(hasRoute(routes, 'GET', '/:broadcastId')).toBe(true);
  });

  test('POST /:broadcastId/accept -- accept broadcast still exists', () => {
    expect(hasRoute(routes, 'POST', '/:broadcastId/accept')).toBe(true);
  });

  test('POST /:broadcastId/decline -- decline broadcast still exists', () => {
    expect(hasRoute(routes, 'POST', '/:broadcastId/decline')).toBe(true);
  });

  test('GET /history -- broadcast history still exists', () => {
    expect(hasRoute(routes, 'GET', '/history')).toBe(true);
  });

  test('POST /create -- create broadcast still exists', () => {
    expect(hasRoute(routes, 'POST', '/create')).toBe(true);
  });
});

// =============================================================================
// GROUP 8: TRACKING ROUTES  (mounted at /api/v1/tracking)
// =============================================================================
describe('GROUP 8: Tracking Routes -- /api/v1/tracking', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const { trackingRouter } = require('../modules/tracking/tracking.routes');
    routes = extractRoutes(trackingRouter);
  });

  test('POST /update -- update driver location still exists', () => {
    expect(hasRoute(routes, 'POST', '/update')).toBe(true);
  });

  test('GET /:tripId -- get trip tracking still exists', () => {
    expect(hasRoute(routes, 'GET', '/:tripId')).toBe(true);
  });

  test('GET /booking/:bookingId/eta -- batch ETA still exists', () => {
    expect(hasRoute(routes, 'GET', '/booking/:bookingId/eta')).toBe(true);
  });

  test('GET /booking/:bookingId -- booking tracking still exists', () => {
    expect(hasRoute(routes, 'GET', '/booking/:bookingId')).toBe(true);
  });

  test('GET /history/:tripId -- trip history still exists', () => {
    expect(hasRoute(routes, 'GET', '/history/:tripId')).toBe(true);
  });

  test('GET /fleet -- fleet tracking still exists', () => {
    expect(hasRoute(routes, 'GET', '/fleet')).toBe(true);
  });

  test('PUT /trip/:tripId/status -- trip status update still exists', () => {
    expect(hasRoute(routes, 'PUT', '/trip/:tripId/status')).toBe(true);
  });

  test('POST /batch -- batch location upload still exists', () => {
    expect(hasRoute(routes, 'POST', '/batch')).toBe(true);
  });

  test('GET /status -- driver online status still exists', () => {
    expect(hasRoute(routes, 'GET', '/status')).toBe(true);
  });

  test('PUT /status -- set driver online status still exists', () => {
    expect(hasRoute(routes, 'PUT', '/status')).toBe(true);
  });

  test('GET /driver/:driverId/status -- get specific driver status still exists', () => {
    expect(hasRoute(routes, 'GET', '/driver/:driverId/status')).toBe(true);
  });

  test('GET /active-trip -- crash recovery endpoint still exists', () => {
    expect(hasRoute(routes, 'GET', '/active-trip')).toBe(true);
  });
});

// =============================================================================
// GROUP 9: GEOCODING ROUTES  (mounted at /api/v1/geocoding)
// =============================================================================
describe('GROUP 9: Geocoding Routes -- /api/v1/geocoding', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const geocodingRouter = require('../modules/routing/geocoding.routes').default;
    routes = extractRoutes(geocodingRouter);
  });

  test('POST /search -- place search still exists', () => {
    expect(hasRoute(routes, 'POST', '/search')).toBe(true);
  });

  test('POST /reverse -- reverse geocode still exists', () => {
    expect(hasRoute(routes, 'POST', '/reverse')).toBe(true);
  });

  test('POST /route -- route calculation still exists', () => {
    expect(hasRoute(routes, 'POST', '/route')).toBe(true);
  });

  test('POST /route-multi -- multi-point route still exists', () => {
    expect(hasRoute(routes, 'POST', '/route-multi')).toBe(true);
  });

  test('GET /status -- geocoding status still exists', () => {
    expect(hasRoute(routes, 'GET', '/status')).toBe(true);
  });
});

// =============================================================================
// GROUP 10: RESPONSE SHAPE CONTRACTS
// =============================================================================
describe('GROUP 10: Response shape contracts', () => {
  // These tests verify that route files export the expected names
  // and that the router objects are valid Express routers.

  test('bookingRouter is a valid Express router', () => {
    const { bookingRouter } = require('../modules/booking/booking.routes');
    expect(bookingRouter).toBeDefined();
    expect(typeof bookingRouter).toBe('function');
    expect(bookingRouter.stack).toBeDefined();
  });

  test('orderRouter is a valid default export Express router', () => {
    const orderRouter = require('../modules/order/order.routes').default;
    expect(orderRouter).toBeDefined();
    expect(typeof orderRouter).toBe('function');
    expect(orderRouter.stack).toBeDefined();
  });

  test('truckHoldRouter is a valid Express router', () => {
    const { truckHoldRouter } = require('../modules/truck-hold/truck-hold.routes');
    expect(truckHoldRouter).toBeDefined();
    expect(typeof truckHoldRouter).toBe('function');
    expect(truckHoldRouter.stack).toBeDefined();
  });

  test('authRouter is a valid Express router', () => {
    const { authRouter } = require('../modules/auth/auth.routes');
    expect(authRouter).toBeDefined();
    expect(typeof authRouter).toBe('function');
    expect(authRouter.stack).toBeDefined();
  });

  test('driverRouter is a valid Express router', () => {
    const { driverRouter } = require('../modules/driver/driver.routes');
    expect(driverRouter).toBeDefined();
    expect(typeof driverRouter).toBe('function');
    expect(driverRouter.stack).toBeDefined();
  });

  test('healthRoutes is a valid Express router', () => {
    const { healthRoutes } = require('../shared/routes/health.routes');
    expect(healthRoutes).toBeDefined();
    expect(typeof healthRoutes).toBe('function');
    expect(healthRoutes.stack).toBeDefined();
  });

  test('trackingRouter is a valid Express router', () => {
    const { trackingRouter } = require('../modules/tracking/tracking.routes');
    expect(trackingRouter).toBeDefined();
    expect(typeof trackingRouter).toBe('function');
    expect(trackingRouter.stack).toBeDefined();
  });

  test('broadcastRouter is a valid Express router', () => {
    const { broadcastRouter } = require('../modules/broadcast/broadcast.routes');
    expect(broadcastRouter).toBeDefined();
    expect(typeof broadcastRouter).toBe('function');
    expect(broadcastRouter.stack).toBeDefined();
  });

  test('driverAuthRouter is a valid Express router', () => {
    const { driverAuthRouter } = require('../modules/driver-auth/driver-auth.routes');
    expect(driverAuthRouter).toBeDefined();
    expect(typeof driverAuthRouter).toBe('function');
    expect(driverAuthRouter.stack).toBeDefined();
  });
});

// =============================================================================
// GROUP 11: MOUNT PREFIX CONTRACTS
// =============================================================================
describe('GROUP 11: Server route mount prefixes', () => {
  // Read server.ts source to verify mount prefixes have not changed
  const fs = require('fs');
  const path = require('path');
  let serverSource: string;

  beforeAll(() => {
    const serverPath = path.resolve(__dirname, '../server.ts');
    serverSource = fs.readFileSync(serverPath, 'utf-8');
  });

  test('API_PREFIX is /api/v1', () => {
    expect(serverSource).toContain("const API_PREFIX = '/api/v1'");
  });

  test('auth mounted at /api/v1/auth', () => {
    expect(serverSource).toContain('`${API_PREFIX}/auth`');
  });

  test('driver-auth mounted at /api/v1/driver-auth', () => {
    expect(serverSource).toContain('`${API_PREFIX}/driver-auth`');
  });

  test('bookings mounted at /api/v1/bookings', () => {
    expect(serverSource).toContain('`${API_PREFIX}/bookings`');
  });

  test('orders mounted at /api/v1/orders', () => {
    expect(serverSource).toContain('`${API_PREFIX}/orders`');
  });

  test('truck-hold mounted at /api/v1/truck-hold', () => {
    expect(serverSource).toContain('`${API_PREFIX}/truck-hold`');
  });

  test('driver mounted at /api/v1/driver', () => {
    expect(serverSource).toContain('`${API_PREFIX}/driver`');
  });

  test('tracking mounted at /api/v1/tracking', () => {
    expect(serverSource).toContain('`${API_PREFIX}/tracking`');
  });

  test('broadcasts mounted at /api/v1/broadcasts', () => {
    expect(serverSource).toContain('`${API_PREFIX}/broadcasts`');
  });

  test('geocoding mounted at /api/v1/geocoding', () => {
    expect(serverSource).toContain('`${API_PREFIX}/geocoding`');
  });

  test('vehicles mounted at /api/v1/vehicles', () => {
    expect(serverSource).toContain('`${API_PREFIX}/vehicles`');
  });

  test('health routes mounted at root /', () => {
    expect(serverSource).toMatch(/app\.use\(['"]\/['"],\s*healthRoutes\)/);
  });

  test('rating mounted at /api/v1/rating', () => {
    expect(serverSource).toContain('`${API_PREFIX}/rating`');
  });

  test('notifications mounted at /api/v1/notifications', () => {
    expect(serverSource).toContain('`${API_PREFIX}/notifications`');
  });

  test('transporter mounted at /api/v1/transporter', () => {
    expect(serverSource).toContain('`${API_PREFIX}/transporter`');
  });

  test('pricing mounted at /api/v1/pricing', () => {
    expect(serverSource).toContain('`${API_PREFIX}/pricing`');
  });
});

// =============================================================================
// GROUP 12: BOOKING RESPONSE FIELD CONTRACTS
// =============================================================================
describe('GROUP 12: Booking response field contracts in route source', () => {
  const fs = require('fs');
  const path = require('path');
  let bookingRouteSrc: string;

  beforeAll(() => {
    bookingRouteSrc = fs.readFileSync(
      path.resolve(__dirname, '../modules/booking/booking.routes.ts'),
      'utf-8'
    );
  });

  test('POST /bookings legacy response includes customerPhone field', () => {
    expect(bookingRouteSrc).toContain('customerPhone');
  });

  test('POST /bookings legacy response includes id field', () => {
    expect(bookingRouteSrc).toContain('id: responseData.order.id');
  });

  test('POST /bookings legacy response includes status field', () => {
    expect(bookingRouteSrc).toContain('status: responseData.order.status');
  });

  test('POST /bookings returns 201 on success', () => {
    expect(bookingRouteSrc).toContain('res.status(201)');
  });

  test('POST /bookings response envelope has success and data.booking', () => {
    expect(bookingRouteSrc).toContain('data: {');
    expect(bookingRouteSrc).toContain('booking: {');
  });

  test('broadcast-snapshot response includes order, requests, syncCursor fields', () => {
    expect(bookingRouteSrc).toContain('syncCursor');
    expect(bookingRouteSrc).toContain('order: {');
    expect(bookingRouteSrc).toContain('requests: details.truckRequests.map');
  });

  test('requests/active response includes orders, count, syncCursor, snapshotUnchanged', () => {
    expect(bookingRouteSrc).toContain('orders: responseOrders');
    expect(bookingRouteSrc).toContain('count: result.length');
    expect(bookingRouteSrc).toContain('syncCursor');
    expect(bookingRouteSrc).toContain('snapshotUnchanged');
  });
});
