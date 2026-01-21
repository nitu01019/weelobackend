/**
 * =============================================================================
 * BOOKING MODULE - ROUTES
 * =============================================================================
 *
 * API routes for booking/broadcast management.
 * All routes require authentication except where noted.
 *
 * NEW: Order System Routes (Multi-Truck Requests)
 * - POST /bookings/orders - Create order with multiple truck types
 * - GET /bookings/orders/:id - Get order with all truck requests
 * - GET /bookings/requests/active - Get active truck requests for transporter
 * - POST /bookings/requests/:id/accept - Accept a truck request
 * =============================================================================
 */
declare const router: import("express-serve-static-core").Router;
export { router as bookingRouter };
//# sourceMappingURL=booking.routes.d.ts.map