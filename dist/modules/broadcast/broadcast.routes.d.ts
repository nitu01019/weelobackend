/**
 * =============================================================================
 * BROADCAST MODULE - ROUTES
 * =============================================================================
 *
 * API routes for broadcast management (booking requests sent to drivers).
 *
 * FLOW:
 * 1. Customer creates booking → Backend creates broadcast
 * 2. Drivers see active broadcasts via GET /broadcasts/active
 * 3. Driver accepts → POST /broadcasts/:id/accept
 * 4. Driver declines → POST /broadcasts/:id/decline
 *
 * =============================================================================
 */
declare const router: import("express-serve-static-core").Router;
export { router as broadcastRouter };
//# sourceMappingURL=broadcast.routes.d.ts.map